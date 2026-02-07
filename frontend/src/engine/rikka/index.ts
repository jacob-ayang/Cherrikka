import type { Database } from 'sql.js';

import { readJsonEntry, writeJsonEntry } from '../backup/zip';
import type { BackupIR, IRConversation, IRFile, IRMessage, IRPart } from '../ir/types';
import { asArray, asBoolean, asNumber, asRecord, asString, cloneJson, dedupeStrings, nowIso, normalizeText, truncate } from '../util/common';
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

  db.close();

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
    opaque: {},
    warnings: files.warnings,
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
          createdAt: new Date(createdAt).toISOString(),
          updatedAt: new Date(updatedAt).toISOString(),
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
      createdAt: nowIso(),
      updatedAt: nowIso(),
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
        createdAt: new Date(createAt).toISOString(),
        updatedAt: new Date(updateAt).toISOString(),
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
  if (typeof part.text === 'string') {
    return { type: 'text', content: part.text };
  }
  if (typeof part.reasoning === 'string') {
    return { type: 'reasoning', content: part.reasoning };
  }
  if (typeof part.toolName === 'string' && typeof part.input === 'string') {
    return {
      type: 'tool',
      name: asString(part.toolName),
      toolCallId: asString(part.toolCallId),
      input: asString(part.input),
      output: parseRikkaToolOutput(part.output),
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
    };
  }

  if (typeof part.url === 'string') {
    return {
      type: inferPartType(part),
      mediaUrl: asString(part.url),
    };
  }

  return { type: 'text', content: '[unsupported rikka part]' };
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
    enableWebSearch: false,
    mcpServers: [],
    ttsProviders: [],
    selectedTTSProviderId: '',
    webDavConfig: {
      path: '/cherrikka',
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
  const providerSeed = asString(provider.id) || asString(provider.name) || asString(provider.type) || newId();
  const providerId = ensureUUID(asString(provider.id), `provider:${providerSeed}`);
  const out: Record<string, unknown> = {
    id: providerId,
    name: asString(provider.name) || 'Imported Provider',
  };
  const mappedType = mapProviderTypeToRikka(asString(provider.type));
  out.type = mappedType || 'openai';

  const rawBase = asString(provider.baseUrl) || asString(provider.apiHost);
  if (out.type === 'openai') {
    out.baseUrl = ensureOpenAIBaseUrl(rawBase || 'https://api.openai.com/v1');
    const chatPath = asString(provider.chatCompletionsPath) || asString(provider.apiPath) || '/chat/completions';
    out.chatCompletionsPath = chatPath;
    if (typeof provider.apiKey === 'string' && provider.apiKey.length > 0) out.apiKey = provider.apiKey;
    if (typeof provider.useResponseApi === 'boolean') out.useResponseApi = provider.useResponseApi;
  } else if (out.type === 'claude') {
    out.baseUrl = rawBase || 'https://api.anthropic.com/v1';
    if (typeof provider.apiKey === 'string' && provider.apiKey.length > 0) out.apiKey = provider.apiKey;
  } else if (out.type === 'google') {
    out.baseUrl = rawBase || 'https://generativelanguage.googleapis.com/v1beta';
    if (typeof provider.apiKey === 'string' && provider.apiKey.length > 0) out.apiKey = provider.apiKey;
    if (typeof provider.vertexAI === 'boolean') out.vertexAI = provider.vertexAI;
    if (typeof provider.privateKey === 'string' && provider.privateKey.length > 0) out.privateKey = provider.privateKey;
    if (typeof provider.serviceAccountEmail === 'string' && provider.serviceAccountEmail.length > 0) out.serviceAccountEmail = provider.serviceAccountEmail;
    if (typeof provider.location === 'string' && provider.location.length > 0) out.location = provider.location;
    if (typeof provider.projectId === 'string' && provider.projectId.length > 0) out.projectId = provider.projectId;
  } else {
    out.baseUrl = rawBase;
  }

  const models = asArray(provider.models).map((raw) => {
    const m = asRecord(raw);
    const modelRef = asString(m.modelId) || asString(m.id) || asString(m.name) || asString(m.displayName) || newId();
    const id = ensureUUID(asString(m.id), `model:${providerId}:${modelRef}`);
    const modelType = normalizeRikkaModelType(asString(m.type), warnings);
    const model = {
      id,
      modelId: asString(m.modelId) || modelRef,
      displayName: asString(m.displayName) || asString(m.name) || asString(m.modelId) || modelRef,
      type: modelType,
    };
    const inputModalities = asArray(m.inputModalities);
    if (inputModalities.length > 0) {
      (model as Record<string, unknown>).inputModalities = inputModalities;
    }
    const outputModalities = asArray(m.outputModalities);
    if (outputModalities.length > 0) {
      (model as Record<string, unknown>).outputModalities = outputModalities;
    }
    registerModelAlias(modelAlias, modelRef, id);
    registerModelAlias(modelAlias, asString(m.id), id);
    registerModelAlias(modelAlias, asString(m.displayName), id);
    registerModelAlias(modelAlias, asString(m.name), id);
    registerModelAlias(modelAlias, asString(model.modelId), id);
    registerModelAlias(modelAlias, asString(model.displayName), id);
    registerModelAlias(modelAlias, id, id);
    return model;
  });
  out.models = models;

  const enabled = asBoolean(provider.enabled, true) && models.length > 0 && Boolean(mappedType);
  out.enabled = enabled;
  if (!mappedType) {
    warnings.push(`provider-invalid-disabled:${asString(out.name)}:unsupported-type`);
  }
  if (asBoolean(provider.enabled, true) && models.length === 0) {
    warnings.push(`provider-invalid-disabled:${asString(out.name)}:no-models`);
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
  const allowed = new Set(['CHAT', 'IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT']);
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
  const id = asString(model.id) || asString(model.modelId) || asString(model.name) || asString(model.displayName);
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
  warnings.push(`assistant-name-conflict-renamed:${trimmed}->${candidate}`);
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
