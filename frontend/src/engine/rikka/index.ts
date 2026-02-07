import type { Database } from 'sql.js';

import { readJsonEntry, writeJsonEntry } from '../backup/zip';
import type { BackupIR, IRConversation, IRFile, IRMessage, IRPart } from '../ir/types';
import { asArray, asBoolean, asNumber, asRecord, asString, cloneJson, dedupeStrings, nowIso, normalizeText, toRfc3339, truncate } from '../util/common';
import { basename, ensureOpenAIBaseUrl, extname, guessLogicalType } from '../util/file';
import { marshalGoJSON } from '../util/go_json';
import { sha256Hex } from '../util/hash';
import { ensureUUID, newId } from '../util/id';
import { openDatabase, tableExists } from '../../vendor/sql';
import { DEFAULT_IDENTITY_HASH, RIKKA_SCHEMA_SQL } from './schema';

export async function parseRikka(entries: Map<string, Uint8Array>): Promise<BackupIR> {
  const settings = readJsonEntry<Record<string, unknown>>(entries, 'settings.json');
  const dbBytes = entries.get('rikka_hub.db');
  if (!settings || !dbBytes) {
    throw new Error('invalid rikka backup: settings.json or rikka_hub.db missing');
  }

  const db = await openDatabase(dbBytes);
  const files = await parseRikkaFiles(db, entries);
  const conversations = parseRikkaConversations(db, files.byRelative);
  const assistants = parseRikkaAssistants(settings);
  const unsupported = extractRikkaUnsupported(settings);

  db.close();

  const warnings = [...files.warnings];
  if (Object.keys(unsupported).length > 0) {
    warnings.push('unsupported-isolated:rikka.settings');
  }

  return {
    sourceApp: 'rikkahub',
    sourceFormat: 'rikka',
    targetFormat: 'cherry',
    assistants,
    conversations,
    files: files.files,
    config: {
      'rikka.settings': cloneJson(settings),
    },
    opaque: Object.keys(unsupported).length > 0 ? { 'interop.rikka.unsupported': unsupported } : {},
    warnings: dedupeStrings(warnings),
  };
}

export async function buildRikka(
  ir: BackupIR,
  outEntries: Map<string, Uint8Array>,
  idMap: Record<string, string>,
  redactSecrets: boolean,
): Promise<string[]> {
  const warnings: string[] = [];
  const db = await openDatabase();
  for (const sql of RIKKA_SCHEMA_SQL) {
    db.run(sql);
  }
  db.run('INSERT OR REPLACE INTO room_master_table (id, identity_hash) VALUES (42, ?)', [DEFAULT_IDENTITY_HASH]);

  const settings = buildRikkaSettings(ir, warnings);
  if (redactSecrets) redactRikkaSettings(settings);

  const filePathById = materializeRikkaFiles(ir.files, outEntries, db, idMap, warnings);
  writeRikkaConversations(db, ir.conversations, settings, filePathById, idMap, warnings);

  outEntries.set('rikka_hub.db', db.export());
  outEntries.set('rikka_hub-wal', new Uint8Array());
  outEntries.set('rikka_hub-shm', new Uint8Array());
  writeJsonEntry(outEntries, 'settings.json', settings);

  db.close();
  return dedupeStrings(warnings);
}

async function parseRikkaFiles(
  db: Database,
  entries: Map<string, Uint8Array>,
): Promise<{ files: IRFile[]; byRelative: Map<string, IRFile>; warnings: string[] }> {
  const warnings: string[] = [];
  const out = new Map<string, IRFile>();

  if (tableExists(db, 'managed_files')) {
    const rows = db.exec('SELECT id, folder, relative_path, display_name, mime_type, size_bytes, created_at, updated_at FROM managed_files');
    for (const row of rows) {
      const vals = row.values;
      for (const r of vals) {
        const id = Number(r[0]);
        const rel = asString(r[2]);
        const display = asString(r[3]);
        const mime = asString(r[4]) || 'application/octet-stream';
        const size = Number(r[5]) || 0;
        const createdAt = Number(r[6]) || Date.now();
        const updatedAt = Number(r[7]) || createdAt;
        const bytes = entries.get(rel) ?? new Uint8Array();
        if (bytes.length === 0) warnings.push(`missing managed file payload: ${rel}`);

        out.set(rel, {
          id: `managed:${id}`,
          name: display || basename(rel),
          ext: extname(display || rel),
          mimeType: mime,
          logicalType: guessLogicalType(mime, extname(display || rel)),
          relativeSrc: rel,
          size: size || bytes.length,
          createdAt: toRfc3339(createdAt),
          updatedAt: toRfc3339(updatedAt),
          hashSha256: bytes.length ? await sha256Hex(bytes) : '',
          missing: bytes.length === 0,
          orphan: false,
          bytes,
          metadata: {
            'rikka.relative_path': rel,
            managed_id: id,
          },
        });
      }
    }
  } else {
    warnings.push('managed_files table missing; skipping managed file index');
  }

  for (const [path, bytes] of entries.entries()) {
    if (!path.startsWith('upload/')) continue;
    if (out.has(path)) continue;
    const name = basename(path);
    out.set(path, {
      id: `upload:${name}`,
      name,
      ext: extname(name),
      mimeType: 'application/octet-stream',
      logicalType: guessLogicalType('', extname(name)),
      relativeSrc: path,
      size: bytes.length,
      createdAt: toRfc3339(Date.now()),
      updatedAt: toRfc3339(Date.now()),
      hashSha256: bytes.length ? await sha256Hex(bytes) : '',
      missing: false,
      orphan: true,
      bytes,
      metadata: {
        discovered: true,
        'rikka.relative_path': path,
      },
    });
    warnings.push(`orphan upload file discovered: ${path}`);
  }

  return {
    files: [...out.values()].sort((a, b) => a.relativeSrc.localeCompare(b.relativeSrc)),
    byRelative: out,
    warnings: dedupeStrings(warnings),
  };
}

function parseRikkaConversations(db: Database, filesByRelative: Map<string, IRFile>): IRConversation[] {
  const out: IRConversation[] = [];
  const convRows = db.exec(
    'SELECT id, assistant_id, title, create_at, update_at, truncate_index, suggestions, is_pinned FROM ConversationEntity ORDER BY update_at DESC',
  );

  for (const result of convRows) {
    for (const row of result.values) {
      const id = asString(row[0]);
      const assistantId = asString(row[1]);
      const title = asString(row[2]);
      const createAt = Number(row[3]) || Date.now();
      const updateAt = Number(row[4]) || createAt;

      const messages = parseConversationNodes(db, id, filesByRelative);
      out.push({
        id,
        assistantId,
        title,
        createdAt: toRfc3339(createAt),
        updatedAt: toRfc3339(updateAt),
        messages,
        opaque: {
          truncateIndex: Number(row[5]) || -1,
          suggestions: asString(row[6]),
          isPinned: Number(row[7]) || 0,
        },
      });
    }
  }

  return out;
}

function parseConversationNodes(db: Database, conversationId: string, filesByRelative: Map<string, IRFile>): IRMessage[] {
  const out: IRMessage[] = [];
  const stmt = db.prepare('SELECT id, node_index, messages, select_index FROM message_node WHERE conversation_id = ? ORDER BY node_index ASC');
  stmt.bind([conversationId]);
  while (stmt.step()) {
    const row = stmt.get();
    const messagesJson = asString(row[2]);
    const selectIndexRaw = asNumber(row[3]);
    let parsed: unknown[] = [];
    try {
      parsed = JSON.parse(messagesJson) as unknown[];
    } catch {
      parsed = [];
    }
    if (parsed.length === 0) continue;

    const selectIndex = Math.min(Math.max(selectIndexRaw, 0), parsed.length - 1);
    const selected = asRecord(parsed[selectIndex]);
    out.push(parseRikkaMessage(selected, filesByRelative));
  }
  stmt.free();
  return out;
}

function parseRikkaMessage(message: Record<string, unknown>, filesByRelative: Map<string, IRFile>): IRMessage {
  const partsRaw = asArray(message.parts);
  const parts = partsRaw.map((p) => parseRikkaPart(asRecord(p), filesByRelative));

  return {
    id: asString(message.id) || newId(),
    role: normalizeRole(asString(message.role)),
    createdAt: asString(message.createdAt),
    modelId: asString(message.modelId),
    parts: parts.length > 0 ? parts : [{ type: 'text', content: '' }],
    opaque: {},
  };
}

function parseRikkaPart(part: Record<string, unknown>, filesByRelative: Map<string, IRFile>): IRPart {
  const metadata: Record<string, unknown> = {
    rikkaType: asString(part.type),
  };

  if (typeof part.text === 'string') {
    return { type: 'text', content: part.text, metadata };
  }
  if (typeof part.reasoning === 'string') {
    return { type: 'reasoning', content: part.reasoning, metadata };
  }
  if (typeof part.toolName === 'string' && typeof part.input === 'string') {
    return {
      type: 'tool',
      name: asString(part.toolName),
      toolCallId: asString(part.toolCallId),
      input: asString(part.input),
      output: parseRikkaToolOutput(part.output),
      metadata,
    };
  }

  if (typeof part.url === 'string' && asString(part.url).startsWith('file://')) {
    const rel = `upload/${basename(asString(part.url))}`;
    const linked = filesByRelative.get(rel);
    return {
      type: inferPartType(part),
      fileId: linked?.id,
      mediaUrl: asString(part.url),
      name: asString(part.fileName) || linked?.name || basename(rel),
      mimeType: asString(part.mime) || linked?.mimeType || 'application/octet-stream',
      metadata,
    };
  }

  if (typeof part.url === 'string') {
    return {
      type: inferPartType(part),
      mediaUrl: asString(part.url),
      metadata,
    };
  }

  return { type: 'text', content: '[unsupported rikka part]', metadata: { ...metadata, raw: part } };
}

function parseRikkaToolOutput(value: unknown): IRPart[] {
  const parts: IRPart[] = [];
  for (const item of asArray(value)) {
    const m = asRecord(item);
    if (typeof m.text === 'string') {
      parts.push({ type: 'text', content: asString(m.text) });
    }
  }
  return parts;
}

function inferPartType(part: Record<string, unknown>): IRPart['type'] {
  const type = asString(part.type).toLowerCase();
  const url = asString(part.url).toLowerCase();
  const ext = extname(url);

  if (type.includes('.image') || ['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) return 'image';
  if (type.includes('.video') || ['.mp4', '.mov', '.mkv', '.webm'].includes(ext)) return 'video';
  if (type.includes('.audio') || ['.mp3', '.wav', '.m4a', '.aac', '.ogg'].includes(ext)) return 'audio';
  return 'document';
}

function parseRikkaAssistants(settings: Record<string, unknown>): BackupIR['assistants'] {
  const assistants: BackupIR['assistants'] = [];
  for (const raw of asArray(settings.assistants)) {
    const assistant = asRecord(raw);
    const parsedSettings: Record<string, unknown> = {
      contextCount: asNumber(assistant.contextMessageSize, 32),
      streamOutput: asBoolean(assistant.streamOutput, true),
      temperature: asNumber(assistant.temperature, 0.7),
    };
    const maxTokens = asNumber(assistant.maxTokens, 0);
    if (maxTokens > 0) {
      parsedSettings.maxTokens = maxTokens;
    }
    assistants.push({
      id: asString(assistant.id) || newId(),
      name: asString(assistant.name) || 'Imported Assistant',
      prompt: asString(assistant.systemPrompt),
      model: {
        chatModelId: asString(assistant.chatModelId),
      },
      settings: parsedSettings,
      opaque: assistant,
    });
  }
  return assistants;
}

function buildRikkaSettings(ir: BackupIR, warnings: string[]): Record<string, unknown> {
  const existing = asRecord(ir.config['rikka.settings']);
  if (Object.keys(existing).length > 0) {
    const cloned = cloneJson(existing);
    normalizeRikkaSettings(cloned, warnings);
    return cloned;
  }

  const fromCherry = asRecord(ir.config['cherry.persistSlices']);
  const llm = asRecord(fromCherry.llm);
  const cherrySettings = asRecord(ir.config['cherry.settings']);
  const persistSettings = asRecord(fromCherry.settings);
  const providersRaw = asArray(llm.providers);
  const modelAlias = new Map<string, string>();

  const providers = providersRaw.map((raw) => normalizeProvider(asRecord(raw), warnings, modelAlias));

  const modelIndex = new Map<string, string>();
  for (const provider of providers) {
    if (!asBoolean(provider.enabled, true)) continue;
    for (const modelRaw of asArray(provider.models)) {
      const model = asRecord(modelRaw);
      const id = asString(model.id) || asString(model.modelId);
      if (id) modelIndex.set(id, asString(provider.id));
    }
  }

  const fallbackModel = modelIndex.keys().next().value || newId();
  const assistants = buildRikkaAssistants(ir.assistants, fallbackModel, modelAlias, warnings);

  const settings: Record<string, unknown> = {
    providers,
    assistants,
    assistantId: asString(assistants[0]?.id),
    chatModelId: pickCherrySelectedModel(llm, 'defaultModel', fallbackModel, modelAlias),
    titleModelId: pickCherrySelectedModel(llm, 'topicNamingModel', fallbackModel, modelAlias),
    translateModeId: pickCherrySelectedModel(llm, 'translateModel', fallbackModel, modelAlias),
    suggestionModelId: pickCherrySelectedModel(llm, 'quickModel', fallbackModel, modelAlias),
    imageGenerationModelId: fallbackModel,
    enableWebSearch: asBoolean(cherrySettings.enableWebSearch, false),
    mcpServers: asArray(cherrySettings.mcpServers),
    ttsProviders: cloneJson(asArray(cherrySettings.ttsProviders)),
    selectedTTSProviderId: pickFirstString(cherrySettings.selectedTTSProviderId),
    webDavConfig: {
      path: pickFirstString(cherrySettings.webdavPath, '/cherrikka'),
      items: ['DATABASE', 'FILES'],
    },
    s3Config: {
      endpoint: '',
      accessKeyId: '',
      secretAccessKey: '',
      region: '',
      bucket: '',
      pathStyle: true,
      items: ['DATABASE', 'FILES'],
    },
  };

  if (Object.keys(persistSettings).length > 0) {
    if (!settings.selectedTTSProviderId) {
      settings.selectedTTSProviderId = pickFirstString(persistSettings.selectedTTSProviderId);
    }
    if (asArray(settings.ttsProviders).length === 0) {
      settings.ttsProviders = cloneJson(asArray(persistSettings.ttsProviders));
    }
  }
  if (Object.keys(cherrySettings).length > 0) {
    const webDav = asRecord(settings.webDavConfig);
    if (pickFirstString(cherrySettings.webdavHost)) {
      webDav.url = pickFirstString(cherrySettings.webdavHost);
    }
    if (pickFirstString(cherrySettings.webdavUser)) {
      webDav.username = pickFirstString(cherrySettings.webdavUser);
    }
    if (pickFirstString(cherrySettings.webdavPass)) {
      webDav.password = pickFirstString(cherrySettings.webdavPass);
    }
    if (pickFirstString(cherrySettings.webdavPath)) {
      webDav.path = pickFirstString(cherrySettings.webdavPath);
    }
    settings.webDavConfig = webDav;
    if (Object.keys(asRecord(cherrySettings.s3)).length > 0) {
      const s3 = cloneJson(asRecord(cherrySettings.s3));
      if (!Array.isArray(s3.items)) s3.items = ['DATABASE', 'FILES'];
      settings.s3Config = s3;
    }
    if (!settings.selectedTTSProviderId) {
      settings.selectedTTSProviderId = pickFirstString(cherrySettings.selectedTTSProviderId);
    }
    if (asArray(settings.ttsProviders).length === 0) {
      settings.ttsProviders = cloneJson(asArray(cherrySettings.ttsProviders));
    }
  }

  normalizeRikkaSettings(settings, warnings);
  return settings;
}

function normalizeRikkaSettings(settings: Record<string, unknown>, warnings: string[]): void {
  const modelAlias = new Map<string, string>();
  const providers = asArray(settings.providers).map((raw) => normalizeProvider(asRecord(raw), warnings, modelAlias));
  settings.providers = providers;

  const modelIds = new Set<string>();
  const allModelIds = new Set<string>();
  for (const providerRaw of providers) {
    const provider = asRecord(providerRaw);
    const providerEnabled = asBoolean(provider.enabled, true);
    const models = asArray(provider.models);
    for (const modelRaw of models) {
      const model = asRecord(modelRaw);
      const id = asString(model.id) || asString(model.modelId);
      if (!id) continue;
      allModelIds.add(id);
      if (providerEnabled) modelIds.add(id);
    }
  }

  const fallbackModel = modelIds.values().next().value || allModelIds.values().next().value || newId();

  const usedNames = new Set<string>();
  const assistants = asArray(settings.assistants).map((raw, index) => {
    const assistant = asRecord(raw);
    const id = asString(assistant.id) || newId();
    const name = uniqueAssistantName(
      asString(assistant.name) || `Imported Assistant ${index + 1}`,
      usedNames,
      warnings,
    );
    let chatModelId = resolveModelAlias(asString(assistant.chatModelId), modelAlias);
    if (!chatModelId || !modelIds.has(chatModelId)) {
      chatModelId = fallbackModel;
      warnings.push(`assistant-model-fallback:${id}`);
    }

    const out: Record<string, unknown> = {
      id,
      name,
      systemPrompt: asString(assistant.systemPrompt),
      chatModelId,
      contextMessageSize: asNumber(assistant.contextMessageSize, 32),
      streamOutput: asBoolean(assistant.streamOutput, true),
      temperature: asNumber(assistant.temperature, 0.7),
    };
    if (Object.prototype.hasOwnProperty.call(assistant, 'topP')) {
      out.topP = asNumber(assistant.topP, 1);
    }

    const maxTokens = asNumber(assistant.maxTokens, 0);
    if (maxTokens > 0) {
      out.maxTokens = maxTokens;
    }

    return out;
  });

  settings.assistants = assistants;
  settings.assistantId = asString(settings.assistantId) || asString(assistants[0]?.id);

  for (const key of ['chatModelId', 'titleModelId', 'translateModeId', 'suggestionModelId', 'imageGenerationModelId']) {
    const current = resolveModelAlias(asString(settings[key]), modelAlias);
    settings[key] = current && modelIds.has(current) ? current : fallbackModel;
  }
}

function normalizeProvider(
  provider: Record<string, unknown>,
  warnings: string[],
  modelAlias?: Map<string, string>,
): Record<string, unknown> {
  const providerSeed = pickFirstString(provider.id, provider.name, provider.type, newId());
  const providerId = ensureUUID(pickFirstString(provider.id), `provider:${providerSeed}`);
  const out: Record<string, unknown> = {
    id: providerId,
    name: pickFirstString(provider.name, 'Imported Provider'),
  };
  const mappedType = mapProviderTypeToRikka(pickFirstString(provider.type));
  out.type = mappedType || 'openai';

  const rawBase = pickFirstString(provider.baseUrl, provider.apiHost);
  if (out.type === 'openai') {
    out.baseUrl = ensureOpenAIBaseUrl(rawBase || 'https://api.openai.com/v1');
    const chatPath = normalizeOpenAIChatPath(
      pickFirstString(provider.chatCompletionsPath, provider.apiPath, '/chat/completions'),
      pickFirstString(out.baseUrl),
    );
    out.chatCompletionsPath = chatPath;
    if (pickFirstString(provider.apiKey)) out.apiKey = pickFirstString(provider.apiKey);
    if (typeof provider.useResponseApi === 'boolean') out.useResponseApi = provider.useResponseApi;
  } else if (out.type === 'claude') {
    out.baseUrl = rawBase || 'https://api.anthropic.com/v1';
    if (pickFirstString(provider.apiKey)) out.apiKey = pickFirstString(provider.apiKey);
  } else if (out.type === 'google') {
    out.baseUrl = rawBase || 'https://generativelanguage.googleapis.com/v1beta';
    if (pickFirstString(provider.apiKey)) out.apiKey = pickFirstString(provider.apiKey);
    if (typeof provider.vertexAI === 'boolean') out.vertexAI = provider.vertexAI;
    if (pickFirstString(provider.privateKey)) out.privateKey = pickFirstString(provider.privateKey);
    if (pickFirstString(provider.serviceAccountEmail)) out.serviceAccountEmail = pickFirstString(provider.serviceAccountEmail);
    if (pickFirstString(provider.location)) out.location = pickFirstString(provider.location);
    if (pickFirstString(provider.projectId)) out.projectId = pickFirstString(provider.projectId);
  } else {
    out.baseUrl = rawBase;
  }

  const models = asArray(provider.models).map((raw) => {
    const m = asRecord(raw);
    const modelRef = pickFirstString(m.modelId, m.id, m.name, m.displayName, newId());
    const id = ensureUUID(pickFirstString(m.id), `model:${providerId}:${modelRef}`);
    const modelType = normalizeRikkaModelType(pickFirstString(m.type), warnings);
    const model: Record<string, unknown> = {
      id,
      modelId: pickFirstString(m.modelId, modelRef),
      displayName: pickFirstString(m.displayName, m.name, m.modelId, modelRef),
      type: modelType,
    };
    const inputModalities = normalizeModelModalities(m.inputModalities);
    if (inputModalities.length > 0) {
      model.inputModalities = inputModalities;
    }
    const outputModalities = normalizeModelModalities(m.outputModalities);
    if (outputModalities.length > 0) {
      model.outputModalities = outputModalities;
    }
    const abilities = normalizeModelAbilities(m.abilities);
    if (abilities.length > 0) {
      model.abilities = abilities;
    }
    const tools = normalizeModelTools(m.tools);
    if (tools.length > 0) {
      model.tools = tools;
    }
    registerModelAlias(modelAlias, modelRef, id);
    registerModelAlias(modelAlias, pickFirstString(m.id), id);
    registerModelAlias(modelAlias, pickFirstString(m.displayName), id);
    registerModelAlias(modelAlias, pickFirstString(m.name), id);
    registerModelAlias(modelAlias, pickFirstString(model.modelId), id);
    registerModelAlias(modelAlias, pickFirstString(model.displayName), id);
    registerModelAlias(modelAlias, id, id);
    return model;
  });
  out.models = models;

  const enabled = asBoolean(provider.enabled, true) && models.length > 0 && Boolean(mappedType);
  out.enabled = enabled;
  if (!mappedType) {
    warnings.push(`provider-invalid-disabled:${pickFirstString(out.name)}:unsupported-type`);
  }
  if (models.length === 0) {
    warnings.push(`provider-invalid-disabled:${pickFirstString(out.name)}:no-models`);
  }

  return out;
}

function buildRikkaAssistants(
  assistants: BackupIR['assistants'],
  fallbackModelId: string,
  modelAlias: Map<string, string>,
  warnings: string[],
): Record<string, unknown>[] {
  const source = assistants.length > 0 ? assistants : [{ id: newId(), name: 'Imported Assistant', prompt: '' }];
  const usedNames = new Set<string>();

  return source.map((assistant, index) => {
    const rawSettings = asRecord(assistant.settings);
    const maxTokens = asNumber(rawSettings.maxTokens, 0);
    const resolvedModel = resolveModelAlias(asString(asRecord(assistant.model).chatModelId), modelAlias);

    const out: Record<string, unknown> = {
      id: ensureUUID(assistant.id, `assistant:${assistant.id}:${assistant.name}`),
      name: uniqueAssistantName(assistant.name || `Imported Assistant ${index + 1}`, usedNames, warnings),
      systemPrompt: assistant.prompt || '',
      chatModelId: resolvedModel || fallbackModelId,
      contextMessageSize: asNumber(rawSettings.contextCount, 32),
      streamOutput: asBoolean(rawSettings.streamOutput, true),
      temperature: asNumber(rawSettings.temperature, 0.7),
    };
    if (Object.prototype.hasOwnProperty.call(rawSettings, 'topP')) {
      out.topP = asNumber(rawSettings.topP, 1);
    }

    if (maxTokens > 0) {
      out.maxTokens = maxTokens;
    }

    return out;
  });
}

function resolveModelAlias(candidate: string, modelAlias: Map<string, string>): string {
  if (!candidate) return '';
  if (modelAlias.has(candidate)) return asString(modelAlias.get(candidate));
  const lower = candidate.toLowerCase();
  if (modelAlias.has(lower)) return asString(modelAlias.get(lower));
  return candidate;
}

function registerModelAlias(alias: Map<string, string> | undefined, key: string, id: string): void {
  if (!alias || !key || !id) return;
  if (!alias.has(key)) alias.set(key, id);
  const lower = key.toLowerCase();
  if (!alias.has(lower)) alias.set(lower, id);
}

function normalizeRikkaModelType(rawType: string, warnings: string[]): string {
  const clean = rawType.trim().toUpperCase();
  if (!clean) return 'CHAT';
  const allowed = new Set(['CHAT', 'IMAGE', 'EMBEDDING']);
  if (allowed.has(clean)) return clean;
  warnings.push(`normalized unsupported model type to CHAT: ${rawType}`);
  return 'CHAT';
}

function pickCherrySelectedModel(
  llm: Record<string, unknown>,
  key: string,
  fallback: string,
  modelAlias: Map<string, string>,
): string {
  const model = asRecord(llm[key]);
  const id = pickFirstString(model.id, model.modelId, model.name, model.displayName);
  const resolved = resolveModelAlias(id, modelAlias);
  return resolved || fallback;
}

function mapProviderTypeToRikka(rawType: string): string {
  const clean = rawType.trim().toLowerCase();
  if (!clean) return 'openai';
  if (['openai', 'openai-response', 'new-api', 'gateway', 'azure-openai', 'ollama', 'lmstudio', 'gpustack', 'aws-bedrock'].includes(clean)) {
    return 'openai';
  }
  if (['anthropic', 'vertex-anthropic', 'claude'].includes(clean)) {
    return 'claude';
  }
  if (['gemini', 'vertexai', 'google'].includes(clean)) {
    return 'google';
  }
  return '';
}

function pickFirstString(...values: unknown[]): string {
  for (const value of values) {
    const candidate = asString(value).trim();
    if (candidate) return candidate;
  }
  return '';
}

function normalizeOpenAIChatPath(chatPath: string, baseUrl: string): string {
  let normalized = chatPath.trim() || '/chat/completions';
  if (!normalized.startsWith('/')) normalized = `/${normalized}`;
  if (openAIBaseHasVersion(baseUrl) && normalized.toLowerCase().startsWith('/v1/')) {
    normalized = normalized.slice('/v1'.length) || '/chat/completions';
  }
  return normalized;
}

function openAIBaseHasVersion(baseUrl: string): boolean {
  if (!baseUrl) return false;
  try {
    const parsed = new URL(baseUrl);
    const path = parsed.pathname.replace(/^\/+|\/+$/g, '').toLowerCase();
    return path.endsWith('v1') || path.endsWith('v1beta');
  } catch {
    return false;
  }
}

function normalizeModelModalities(value: unknown): string[] {
  const out = new Set<string>();
  for (const item of asArray(value)) {
    const text = pickFirstString(item).toUpperCase();
    if (text === 'TEXT' || text === 'IMAGE') out.add(text);
  }
  return [...out];
}

function normalizeModelAbilities(value: unknown): string[] {
  const out = new Set<string>();
  for (const item of asArray(value)) {
    const text = pickFirstString(item).toUpperCase();
    if (text === 'TOOL' || text === 'REASONING') out.add(text);
  }
  return [...out];
}

function normalizeModelTools(value: unknown): string[] {
  const out = new Set<string>();
  for (const item of asArray(value)) {
    const text = pickFirstString(item).toLowerCase();
    if (text === 'search' || text === 'url_context') out.add(text);
  }
  return [...out];
}

function extractRikkaUnsupported(settings: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ['modeInjections', 'lorebooks', 'memoryEntities', 'memories']) {
    if (isMeaningfulUnsupported(settings[key])) out[key] = cloneJson(settings[key]);
  }

  const assistantsOut: Record<string, unknown>[] = [];
  for (const item of asArray(settings.assistants)) {
    const assistant = asRecord(item);
    const entry: Record<string, unknown> = {};
    const id = pickFirstString(assistant.id);
    const name = pickFirstString(assistant.name);
    if (id) entry.id = id;
    if (name) entry.name = name;
    for (const key of ['modeInjectionIds', 'lorebookIds', 'enableMemory', 'useGlobalMemory', 'regexes', 'localTools']) {
      if (isMeaningfulUnsupported(assistant[key])) entry[key] = cloneJson(assistant[key]);
    }
    if (Object.keys(entry).length > 0) assistantsOut.push(entry);
  }
  if (assistantsOut.length > 0) out.assistants = assistantsOut;
  return out;
}

function isMeaningfulUnsupported(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(asRecord(value)).length > 0;
  return true;
}

function uniqueAssistantName(name: string, used: Set<string>, warnings: string[]): string {
  const trimmed = name.trim() || 'Imported Assistant';
  if (!used.has(trimmed)) {
    used.add(trimmed);
    return trimmed;
  }

  let index = 2;
  let candidate = `${trimmed} (${index})`;
  while (used.has(candidate)) {
    index += 1;
    candidate = `${trimmed} (${index})`;
  }
  used.add(candidate);
  warnings.push(`assistant name conflict renamed: ${trimmed} -> ${candidate}`);
  return candidate;
}

function redactRikkaSettings(settings: Record<string, unknown>): void {
  for (const raw of asArray(settings.providers)) {
    const provider = asRecord(raw);
    if (typeof provider.apiKey === 'string' && provider.apiKey.length > 0) {
      provider.apiKey = '***REDACTED***';
    }
    if (typeof provider.password === 'string' && provider.password.length > 0) {
      provider.password = '***REDACTED***';
    }
  }

  const webDav = asRecord(settings.webDavConfig);
  if (typeof webDav.password === 'string' && webDav.password.length > 0) {
    webDav.password = '***REDACTED***';
  }
  settings.webDavConfig = webDav;

  const s3 = asRecord(settings.s3Config);
  if (typeof s3.secretAccessKey === 'string' && s3.secretAccessKey.length > 0) {
    s3.secretAccessKey = '***REDACTED***';
  }
  settings.s3Config = s3;
}

function materializeRikkaFiles(
  files: IRFile[],
  outEntries: Map<string, Uint8Array>,
  db: Database,
  idMap: Record<string, string>,
  warnings: string[],
): Map<string, string> {
  const relById = new Map<string, string>();
  const used = new Set<string>();

  for (const file of files) {
    let rel = asString(asRecord(file.metadata)['rikka.relative_path']);
    if (!rel) {
      rel = normalizeRikkaRelativePath(file.relativeSrc);
    }
    if (!rel.startsWith('upload/') || used.has(rel)) {
      rel = `upload/${newId()}${file.ext || extname(file.name)}`;
    }
    used.add(rel);

    const bytes = file.bytes ?? new Uint8Array();
    outEntries.set(rel, bytes);

    const display = file.name || basename(rel);
    const mime = file.mimeType || 'application/octet-stream';
    const createdAt = Date.parse(file.createdAt || nowIso()) || Date.now();
    const updatedAt = Date.parse(file.updatedAt || file.createdAt || nowIso()) || createdAt;

    db.run(
      'INSERT INTO managed_files (folder, relative_path, display_name, mime_type, size_bytes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['upload', rel, display, mime, bytes.length, createdAt, updatedAt],
    );

    idMap[`file:${file.id}`] = rel;
    relById.set(file.id, rel);

    if (bytes.length === 0) {
      warnings.push(`file ${file.id} has empty payload in output`);
    }
  }

  return relById;
}

function normalizeRikkaRelativePath(input: string): string {
  const clean = input.trim().replaceAll('\\\\', '/');
  if (!clean) return '';
  if (clean.startsWith('upload/')) return clean;
  const name = basename(clean);
  if (!name || name === '.' || name === '/') return '';
  return `upload/${name}`;
}

function writeRikkaConversations(
  db: Database,
  conversations: IRConversation[],
  settings: Record<string, unknown>,
  fileRelById: Map<string, string>,
  idMap: Record<string, string>,
  warnings: string[],
): void {
  const validAssistantIds = new Set(asArray(settings.assistants).map((a) => asString(asRecord(a).id)).filter(Boolean));
  const fallbackAssistant = asString(settings.assistantId) || [...validAssistantIds][0] || '0950e2dc-9bd5-4801-afa3-aa887aa36b4e';

  for (const conversation of conversations) {
    const convId = ensureUUID(conversation.id, `conversation:${conversation.id}:${conversation.title}`);
    const assistantId = validAssistantIds.has(conversation.assistantId)
      ? conversation.assistantId
      : fallbackAssistant;

    const createdAt = Date.parse(conversation.createdAt || nowIso()) || Date.now();
    const updatedAt = Date.parse(conversation.updatedAt || conversation.createdAt || nowIso()) || createdAt;

    db.run(
      'INSERT INTO ConversationEntity (id, assistant_id, title, nodes, create_at, update_at, truncate_index, suggestions, is_pinned) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        convId,
        assistantId,
        normalizeConversationTitle(conversation.title, conversation.messages),
        '[]',
        createdAt,
        updatedAt,
        -1,
        '[]',
        0,
      ],
    );

    idMap[`topic:${conversation.id}`] = convId;

    for (let i = 0; i < conversation.messages.length; i += 1) {
      const message = conversation.messages[i];
      const nodeId = newId();
      const serialized = toRikkaMessage(message, fileRelById, warnings);

      db.run(
        'INSERT INTO message_node (id, conversation_id, node_index, messages, select_index) VALUES (?, ?, ?, ?, ?)',
        [nodeId, convId, i, marshalGoJSON([serialized]), 0],
      );

      idMap[`message:${message.id}`] = asString(serialized.id);
    }
  }
}

function toRikkaMessage(
  message: IRMessage,
  fileRelById: Map<string, string>,
  warnings: string[],
): Record<string, unknown> {
  const parts: Record<string, unknown>[] = [];

  for (const part of message.parts) {
    const mapped = mapPartToRikka(part, fileRelById, warnings);
    if (mapped) parts.push(mapped);
  }

  if (parts.length === 0) {
    parts.push({
      type: 'me.rerere.ai.ui.UIMessagePart.Text',
      text: '',
    });
  }

  return {
    id: ensureUUID(message.id, `message:${message.id}:${message.role}`),
    role: normalizeRole(message.role),
    parts,
    annotations: [],
  };
}

function mapPartToRikka(
  part: IRPart,
  fileRelById: Map<string, string>,
  warnings: string[],
): Record<string, unknown> | null {
  if (part.type === 'text') {
    return {
      type: 'me.rerere.ai.ui.UIMessagePart.Text',
      text: part.content ?? '',
    };
  }

  if (part.type === 'reasoning') {
    return {
      type: 'me.rerere.ai.ui.UIMessagePart.Reasoning',
      reasoning: part.content ?? '',
    };
  }

  if (part.type === 'tool') {
    const lines: string[] = [`[Tool] ${part.name || 'unknown'}`];
    if (part.input) lines.push(`Input: ${part.input}`);
    if (part.output && part.output.length) {
      lines.push(`Output: ${part.output.map((o) => o.content || '').join(' | ')}`);
    }
    if (part.content) lines.push(`Content: ${part.content}`);

    return {
      type: 'me.rerere.ai.ui.UIMessagePart.Text',
      text: lines.join('\n'),
    };
  }

  if (part.type === 'image' || part.type === 'video' || part.type === 'audio' || part.type === 'document') {
    const rel = part.fileId ? fileRelById.get(part.fileId) : undefined;
    if (!rel) {
      warnings.push(`missing file reference for part fileId=${part.fileId || ''}`);
      return {
        type: 'me.rerere.ai.ui.UIMessagePart.Text',
        text: `[missing file] ${part.name || part.fileId || ''}`,
      };
    }

    return {
      type: 'me.rerere.ai.ui.UIMessagePart.File',
      fileName: part.name || basename(rel),
      mime: part.mimeType || 'application/octet-stream',
      url: `file:///data/user/0/me.rerere.rikkahub/files/${rel}`,
    };
  }

  return null;
}

function normalizeRole(role: string): string {
  const clean = role.trim().toLowerCase();
  if (clean === 'user' || clean === 'assistant' || clean === 'system' || clean === 'tool') return clean;
  return 'assistant';
}

function normalizeConversationTitle(title: string, messages: IRMessage[]): string {
  const clean = normalizeText(title);
  if (clean) return truncate(clean, 80);

  for (const message of messages) {
    if (normalizeRole(message.role) !== 'user') continue;
    for (const part of message.parts) {
      if (part.type === 'text' && part.content) {
        const guess = normalizeText(part.content);
        if (guess) return truncate(guess, 80);
      }
    }
  }

  return 'Imported Conversation';
}
