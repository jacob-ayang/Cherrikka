import type { Database } from 'sql.js';

import { readJsonEntry, writeJsonEntry } from '../backup/zip';
import type { BackupIR, IRConversation, IRFile, IRMessage, IRPart } from '../ir/types';
import { asArray, asBoolean, asNumber, asRecord, asString, cloneJson, dedupeStrings, nowIso, normalizeText, truncate } from '../util/common';
import { basename, ensureOpenAIBaseUrl, extname, guessLogicalType } from '../util/file';
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
    assistants.push({
      id: asString(assistant.id) || newId(),
      name: asString(assistant.name) || 'Imported Assistant',
      prompt: asString(assistant.systemPrompt),
      model: {
        chatModelId: asString(assistant.chatModelId),
      },
      settings: {
        contextCount: asNumber(assistant.contextMessageSize, 32),
        streamOutput: asBoolean(assistant.streamOutput, true),
        temperature: asNumber(assistant.temperature, 0.7),
        maxTokens: asNumber(assistant.maxTokens, 0),
      },
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

  const providers = providersRaw.map((raw) => normalizeProvider(asRecord(raw), warnings));

  const modelIndex = new Map<string, string>();
  for (const provider of providers) {
    for (const modelRaw of asArray(provider.models)) {
      const model = asRecord(modelRaw);
      const id = asString(model.id) || asString(model.modelId);
      if (id) modelIndex.set(id, asString(provider.id));
    }
  }

  const fallbackModel = modelIndex.keys().next().value || newId();
  const assistants = buildRikkaAssistants(ir.assistants, fallbackModel);

  const settings: Record<string, unknown> = {
    providers,
    assistants,
    assistantId: asString(assistants[0]?.id),
    chatModelId: pickCherrySelectedModel(llm, 'defaultModel', fallbackModel),
    titleModelId: pickCherrySelectedModel(llm, 'topicNamingModel', fallbackModel),
    translateModeId: pickCherrySelectedModel(llm, 'translateModel', fallbackModel),
    suggestionModelId: pickCherrySelectedModel(llm, 'quickModel', fallbackModel),
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
  const providers = asArray(settings.providers).map((raw) => normalizeProvider(asRecord(raw), warnings));
  settings.providers = providers;

  const modelIds = new Set<string>();
  for (const providerRaw of providers) {
    const provider = asRecord(providerRaw);
    const models = asArray(provider.models);
    for (const modelRaw of models) {
      const model = asRecord(modelRaw);
      const id = asString(model.id) || asString(model.modelId);
      if (id) modelIds.add(id);
    }
  }

  const fallbackModel = modelIds.values().next().value || newId();

  const assistants = asArray(settings.assistants).map((raw) => {
    const assistant = asRecord(raw);
    const id = asString(assistant.id) || newId();
    let chatModelId = asString(assistant.chatModelId);
    if (!chatModelId || !modelIds.has(chatModelId)) {
      chatModelId = fallbackModel;
      warnings.push(`assistant-model-fallback:${id}`);
    }

    const out: Record<string, unknown> = {
      id,
      name: asString(assistant.name) || 'Imported Assistant',
      systemPrompt: asString(assistant.systemPrompt),
      chatModelId,
      contextMessageSize: asNumber(assistant.contextMessageSize, 32),
      streamOutput: asBoolean(assistant.streamOutput, true),
      temperature: asNumber(assistant.temperature, 0.7),
      topP: asNumber(assistant.topP, 1),
    };

    const maxTokens = asNumber(assistant.maxTokens, 0);
    if (maxTokens > 0) {
      out.maxTokens = maxTokens;
    }

    return out;
  });

  settings.assistants = assistants;
  settings.assistantId = asString(settings.assistantId) || asString(assistants[0]?.id);

  for (const key of ['chatModelId', 'titleModelId', 'translateModeId', 'suggestionModelId', 'imageGenerationModelId']) {
    const current = asString(settings[key]);
    settings[key] = current && modelIds.has(current) ? current : fallbackModel;
  }
}

function normalizeProvider(provider: Record<string, unknown>, warnings: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {
    ...provider,
  };
  out.id = asString(provider.id) || newId();
  out.name = asString(provider.name) || 'Imported Provider';
  out.type = asString(provider.type) || 'openai';

  const rawBase = asString(provider.baseUrl) || asString(provider.apiHost);
  out.baseUrl = out.type === 'openai' ? ensureOpenAIBaseUrl(rawBase) : rawBase;

  const models = asArray(provider.models).map((raw) => {
    const m = asRecord(raw);
    const id = asString(m.id) || asString(m.modelId) || newId();
    return {
      id,
      modelId: asString(m.modelId) || id,
      displayName: asString(m.displayName) || asString(m.name) || asString(m.modelId) || id,
      type: 'CHAT',
      inputModalities: asArray(m.inputModalities).length ? asArray(m.inputModalities) : ['TEXT'],
      outputModalities: asArray(m.outputModalities).length ? asArray(m.outputModalities) : ['TEXT'],
    };
  });
  out.models = models;

  const enabled = asBoolean(provider.enabled, true) && models.length > 0;
  out.enabled = enabled;
  if (asBoolean(provider.enabled, true) && models.length === 0) {
    warnings.push(`provider-invalid-disabled:${asString(out.name)}:no-models`);
  }

  return out;
}

function buildRikkaAssistants(assistants: BackupIR['assistants'], fallbackModelId: string): Record<string, unknown>[] {
  const source = assistants.length > 0 ? assistants : [{ id: newId(), name: 'Imported Assistant', prompt: '' }];

  return source.map((assistant) => {
    const rawSettings = asRecord(assistant.settings);
    const maxTokens = asNumber(rawSettings.maxTokens, 0);

    const out: Record<string, unknown> = {
      id: ensureUUID(assistant.id, `assistant:${assistant.id}:${assistant.name}`),
      name: assistant.name || 'Imported Assistant',
      systemPrompt: assistant.prompt || '',
      chatModelId: asString(asRecord(assistant.model).chatModelId) || fallbackModelId,
      contextMessageSize: asNumber(rawSettings.contextCount, 32),
      streamOutput: asBoolean(rawSettings.streamOutput, true),
      temperature: asNumber(rawSettings.temperature, 0.7),
      topP: asNumber(rawSettings.topP, 1),
    };

    if (maxTokens > 0) {
      out.maxTokens = maxTokens;
    }

    return out;
  });
}

function pickCherrySelectedModel(llm: Record<string, unknown>, key: string, fallback: string): string {
  const model = asRecord(llm[key]);
  const id = asString(model.id) || asString(model.modelId);
  return id || fallback;
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
        [nodeId, convId, i, JSON.stringify([serialized]), 0],
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
