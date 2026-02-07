import { readJsonEntry, writeJsonEntry } from '../backup/zip';
import type { BackupIR, IRConversation, IRFile, IRMessage, IRPart } from '../ir/types';
import { asArray, asRecord, asString, cloneJson, dedupeStrings, nowIso, normalizeText, toRfc3339, truncate } from '../util/common';
import { extname, guessLogicalType, normalizePath } from '../util/file';
import { marshalGoJSON } from '../util/go_json';
import { sha256Hex } from '../util/hash';
import { ensureUUID, ensureUUIDUrl, newId } from '../util/id';

interface CherryData {
  time?: number;
  version?: number;
  localStorage?: Record<string, unknown>;
  indexedDB?: Record<string, unknown>;
}

export function parseCherry(entries: Map<string, Uint8Array>): BackupIR {
  const root = readJsonEntry<CherryData>(entries, 'data.json');
  if (!root) {
    throw new Error('invalid cherry backup: data.json missing or malformed');
  }

  const localStorage = asRecord(root.localStorage);
  const indexedDB = asRecord(root.indexedDB);

  const persistSlices = decodePersistSlices(asString(localStorage['persist:cherry-studio']));
  const assistantsSlice = asRecord(persistSlices.assistants);
  const cherrySettings = asRecord(persistSlices.settings);
  const cherryLlm = asRecord(persistSlices.llm);

  const assistants = parseAssistants(assistantsSlice);
  const filesById = parseCherryFiles(entries, asArray(indexedDB.files));
  const conversations = parseCherryConversations(asArray(indexedDB.topics), asArray(indexedDB.message_blocks), filesById);
  const unsupported = extractCherryUnsupported(cherrySettings, persistSlices);

  const ir: BackupIR = {
    sourceApp: 'cherry-studio',
    sourceFormat: 'cherry',
    targetFormat: 'rikka',
    assistants,
    conversations,
    files: [...filesById.values()],
    config: {
      'cherry.localStorage': cloneJson(localStorage),
      'cherry.persistSlices': persistSlices,
      'cherry.settings': cherrySettings,
      'cherry.llm': cherryLlm,
      'cherry.indexedDB.extra': extractIndexedDbExtra(indexedDB),
    },
    opaque: Object.keys(unsupported).length > 0 ? { 'interop.cherry.unsupported': unsupported } : {},
    warnings: [],
  };

  for (const file of ir.files) {
    if (file.missing) ir.warnings.push(`missing cherry file payload: ${file.id}`);
  }
  if (Object.keys(unsupported).length > 0) {
    ir.warnings.push('unsupported-isolated:cherry.settings');
  }

  return ir;
}

export function buildCherry(
  ir: BackupIR,
  outEntries: Map<string, Uint8Array>,
  idMap: Record<string, string>,
  redactSecrets: boolean,
): string[] {
  const warnings: string[] = [];
  const persistSlices = buildPersistSlices(ir, redactSecrets, warnings);
  const fileTable = materializeCherryFiles(ir.files, outEntries, idMap, warnings);

  const topics: Record<string, unknown>[] = [];
  const blocks: Record<string, unknown>[] = [];

  for (const conversation of ir.conversations) {
    const topicId = conversation.id || newId();
    idMap[`topic:${conversation.id}`] = topicId;
    const msgRows: Record<string, unknown>[] = [];

    for (const message of conversation.messages) {
      const msgId = message.id || newId();
      idMap[`message:${message.id}`] = msgId;
      const blockIds: string[] = [];

      for (const part of message.parts) {
        const blockId = newId();
        blockIds.push(blockId);
        blocks.push(partToCherryBlock(part, blockId, msgId, idMap, warnings));
      }

      if (blockIds.length === 0) {
        const blockId = newId();
        blockIds.push(blockId);
        blocks.push({
          id: blockId,
          messageId: msgId,
          createdAt: toRfc3339(Date.now()),
          status: 'success',
          type: 'main_text',
          content: '',
        });
      }

      msgRows.push({
        id: msgId,
        role: normalizeRole(message.role),
        assistantId: conversation.assistantId,
        topicId,
        createdAt: fallbackTime(message.createdAt),
        status: 'success',
        blocks: blockIds,
      });
    }

    topics.push({
      id: topicId,
      name: normalizeConversationTitle(conversation.title),
      assistantId: conversation.assistantId,
      createdAt: fallbackTime(conversation.createdAt),
      updatedAt: fallbackTime(conversation.updatedAt),
      messages: msgRows,
    });
  }

  const localStorage: Record<string, unknown> = {
    'persist:cherry-studio': encodePersistSlices(persistSlices),
  };

  const indexedDB: Record<string, unknown> = {
    topics,
    message_blocks: blocks,
    files: fileTable,
  };

  const extras = asRecord(ir.config['cherry.indexedDB.extra']);
  for (const [k, v] of Object.entries(extras)) {
    if (!(k in indexedDB)) indexedDB[k] = v;
  }

  const data: CherryData = {
    time: Date.now(),
    version: 5,
    localStorage,
    indexedDB,
  };

  writeJsonEntry(outEntries, 'data.json', data);
  ensureKeepFile(outEntries);
  return dedupeStrings(warnings);
}

function parseAssistants(slice: Record<string, unknown>): BackupIR['assistants'] {
  const out: BackupIR['assistants'] = [];
  for (const item of asArray(slice.assistants)) {
    const assistant = asRecord(item);
    out.push({
      id: asString(assistant.id) || newId(),
      name: asString(assistant.name) || 'Imported Assistant',
      prompt: asString(assistant.prompt),
      settings: asRecord(assistant.settings),
      model: asRecord(assistant.model),
      opaque: assistant,
    });
  }
  if (out.length === 0) {
    out.push({ id: newId(), name: 'Default Assistant', prompt: '', settings: {}, model: {}, opaque: {} });
  }
  return out;
}

function parseCherryFiles(
  entries: Map<string, Uint8Array>,
  filesRaw: unknown[],
): Map<string, IRFile> {
  const byId = new Map<string, IRFile>();

  for (const raw of filesRaw) {
    const row = asRecord(raw);
    const id = asString(row.id);
    if (!id) continue;

    const origin = asString(row.origin_name) || asString(row.name) || id;
    const ext = asString(row.ext) || extname(origin);
    const relPath = findCherryFilePath(entries, id, ext, asString(row.path));
    const bytes = relPath ? entries.get(relPath) ?? new Uint8Array() : new Uint8Array();
    const mime = asString(row.mime_type) || asString(row.type) || 'application/octet-stream';

    byId.set(id, {
      id,
      name: origin,
      ext,
      mimeType: mime,
      logicalType: guessLogicalType(mime, ext),
      relativeSrc: relPath,
      size: bytes.length,
      createdAt: normalizeTimestamp(row.created_at) || normalizeTimestamp(row.createdAt) || fallbackTime(''),
      updatedAt: normalizeTimestamp(row.updated_at) || normalizeTimestamp(row.updatedAt) || fallbackTime(''),
      hashSha256: '',
      missing: bytes.length === 0,
      orphan: false,
      bytes,
      metadata: {
        cherry_id: id,
        cherry_ext: ext,
      },
    });
  }

  for (const key of entries.keys()) {
    if (!key.startsWith('Data/Files/')) continue;
    const name = key.slice('Data/Files/'.length);
    if (!name || name === '.keep') continue;
    const ext = extname(name);
    const stem = ext ? name.slice(0, -ext.length) : name;
    if (!stem || byId.has(stem)) continue;
    const bytes = entries.get(key) ?? new Uint8Array();
    byId.set(stem, {
      id: stem,
      name,
      ext,
      mimeType: 'application/octet-stream',
      logicalType: guessLogicalType('', ext),
      relativeSrc: key,
      size: bytes.length,
      createdAt: fallbackTime(''),
      updatedAt: fallbackTime(''),
      hashSha256: '',
      missing: bytes.length === 0,
      orphan: true,
      bytes,
      metadata: {
        discovered: true,
      },
    });
  }

  return byId;
}

function parseCherryConversations(
  topicsRaw: unknown[],
  blocksRaw: unknown[],
  filesById: Map<string, IRFile>,
): IRConversation[] {
  const blocksById = new Map<string, Record<string, unknown>>();
  for (const raw of blocksRaw) {
    const block = asRecord(raw);
    const id = asString(block.id);
    if (id) blocksById.set(id, block);
  }

  const conversations: IRConversation[] = [];

  for (const raw of topicsRaw) {
    const topic = asRecord(raw);
    const conv: IRConversation = {
      id: asString(topic.id) || newId(),
      assistantId: asString(topic.assistantId),
      title: asString(topic.name),
      createdAt: fallbackTime(asString(topic.createdAt)),
      updatedAt: fallbackTime(asString(topic.updatedAt)),
      messages: [],
      opaque: {},
    };

    for (const msgRaw of asArray(topic.messages)) {
      const msg = asRecord(msgRaw);
      const parts: IRPart[] = [];
      for (const blockIdRaw of asArray(msg.blocks)) {
        const blockId = asString(blockIdRaw);
        const block = blocksById.get(blockId);
        if (!block) continue;
        parts.push(cherryBlockToPart(block, filesById));
      }
      if (parts.length === 0) {
        const content = asString(msg.content);
        parts.push({ type: 'text', content });
      }
      conv.messages.push({
        id: asString(msg.id) || newId(),
        role: normalizeRole(asString(msg.role)),
        createdAt: fallbackTime(asString(msg.createdAt)),
        modelId: asString(msg.modelId),
        parts,
        opaque: {},
      });
    }

    conversations.push(conv);
  }

  return conversations;
}

function cherryBlockToPart(block: Record<string, unknown>, filesById: Map<string, IRFile>): IRPart {
  const type = asString(block.type);
  const baseMeta: Record<string, unknown> = { cherryBlockType: type };

  if (['main_text', 'code', 'translation', 'compact'].includes(type)) {
    return { type: 'text', content: asString(block.content), metadata: baseMeta };
  }
  if (type === 'thinking') {
    return { type: 'reasoning', content: asString(block.content), metadata: baseMeta };
  }
  if (type === 'tool') {
    return {
      type: 'tool',
      name: asString(block.toolName),
      toolCallId: asString(block.toolId),
      input: stringifyJson(block.arguments),
      output: asString(block.content) ? [{ type: 'text', content: asString(block.content) }] : [],
      metadata: baseMeta,
    };
  }

  const fileMeta = asRecord(block.file);
  const fileId = asString(fileMeta.id);
  const file = filesById.get(fileId);
  const name = asString(fileMeta.origin_name) || asString(fileMeta.name) || file?.name || '';

  if (type === 'image') {
    return {
      type: 'image',
      fileId,
      mediaUrl: asString(block.url),
      name,
      mimeType: file?.mimeType,
      metadata: baseMeta,
    };
  }
  if (type === 'video') {
    return {
      type: 'video',
      fileId,
      mediaUrl: asString(block.url),
      name,
      mimeType: file?.mimeType,
      metadata: baseMeta,
    };
  }
  if (type === 'file') {
    return {
      type: 'document',
      fileId,
      name,
      mimeType: file?.mimeType,
      metadata: baseMeta,
    };
  }

  return {
    type: 'text',
    content: asString(block.content) || `[unsupported cherry block: ${type}]`,
    metadata: {
      ...baseMeta,
      raw: block,
    },
  };
}

function partToCherryBlock(
  part: IRPart,
  blockId: string,
  messageId: string,
  idMap: Record<string, string>,
  warnings: string[],
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: blockId,
    messageId,
    createdAt: fallbackTime(''),
    status: 'success',
  };
  if (part.metadata && Object.keys(part.metadata).length > 0) {
    base.metadata = cloneJson(part.metadata);
  }

  if (part.type === 'reasoning') {
    return { ...base, type: 'thinking', content: part.content ?? '' };
  }

  if (part.type === 'tool') {
    const summarized = summarizeToolPart(part);
    return {
      ...base,
      type: 'main_text',
      content: summarized,
    };
  }

  if (part.type === 'image' || part.type === 'video' || part.type === 'audio' || part.type === 'document') {
    const mappedFileId = part.fileId ? idMap[`file:${part.fileId}`] : '';
    const fileObj = mappedFileId
      ? {
          id: mappedFileId,
          name: `${mappedFileId}${extname(part.name || '')}`,
          origin_name: part.name || mappedFileId,
          ext: extname(part.name || ''),
          type: part.mimeType || 'application/octet-stream',
        }
      : undefined;

    if (!mappedFileId) {
      warnings.push(`missing file mapping for part fileId=${part.fileId ?? ''}`);
    }

    if (part.type === 'image') {
      return { ...base, type: 'image', url: part.mediaUrl ?? '', file: fileObj };
    }
    if (part.type === 'video') {
      return { ...base, type: 'video', url: part.mediaUrl ?? '', file: fileObj };
    }
    return { ...base, type: 'file', content: part.content ?? '', file: fileObj };
  }

  return {
    ...base,
    type: 'main_text',
    content: part.content ?? '',
  };
}

function materializeCherryFiles(
  files: IRFile[],
  outEntries: Map<string, Uint8Array>,
  idMap: Record<string, string>,
  warnings: string[],
): Record<string, unknown>[] {
  const fileTable: Record<string, unknown>[] = [];
  const used = new Set<string>();

  for (const file of files) {
    let fileId = chooseCherryFileId(file);
    if (!fileId || used.has(fileId)) {
      fileId = ensureUUIDUrl('', `${deterministicCherryFileSeed(file)}#dup`);
    }
    used.add(fileId);

    idMap[`file:${file.id}`] = fileId;
    const ext = file.ext || extname(file.name);
    const entryName = `${fileId}${ext}`;
    const entryPath = `Data/Files/${entryName}`;
    const bytes = file.bytes ?? new Uint8Array();
    outEntries.set(entryPath, bytes);

    if (bytes.length === 0) {
      warnings.push(`file ${file.id} has empty payload in output`);
    }

    fileTable.push({
      id: fileId,
      name: entryName,
      origin_name: file.name || entryName,
      path: entryPath,
      size: bytes.length,
      ext,
      type: file.logicalType || file.mimeType || 'other',
      created_at: fallbackTime(file.createdAt),
      count: 1,
    });
  }

  return fileTable;
}

function buildPersistSlices(ir: BackupIR, redact: boolean, warnings: string[]): Record<string, unknown> {
  const existing = asRecord(ir.config['cherry.persistSlices']);
  const slices: Record<string, unknown> = Object.keys(existing).length > 0 ? cloneJson(existing) : {};

  const assistants = buildCherryAssistants(ir.assistants, ir.conversations);
  slices.assistants = {
    defaultAssistant: {
      id: 'default',
      name: 'Default',
      prompt: assistants[0]?.prompt ?? '',
      settings: { contextCount: 32, streamOutput: true, temperature: 0.7 },
      type: 'assistant',
      topics: [],
      regularPhrases: [],
      emoji: '😀',
    },
    assistants,
    tagsOrder: [],
    collapsedTags: {},
    presets: [],
    unifiedListOrder: [],
  };

  slices.llm = buildCherryLlm(ir, warnings);
  slices.settings = asRecord(slices.settings);
  slices.backup = asRecord(slices.backup);

  if (redact) {
    return redactPersistSlices(slices);
  }
  return slices;
}

function buildCherryAssistants(assistants: BackupIR['assistants'], conversations: IRConversation[]): Record<string, unknown>[] {
  const convMap = new Map<string, IRConversation[]>();
  for (const conv of conversations) {
    const list = convMap.get(conv.assistantId) ?? [];
    list.push(conv);
    convMap.set(conv.assistantId, list);
  }

  const source = assistants.length > 0 ? assistants : [{ id: newId(), name: 'Imported Assistant', prompt: '' }];
  const usedNames = new Set<string>();

  return source.map((assistant, index) => {
    const baseName = assistant.name || `Assistant ${index + 1}`;
    const uniqueName = uniqueAssistantName(baseName, usedNames);
    const topics = (convMap.get(assistant.id) ?? []).map((conv) => ({
      id: conv.id,
      assistantId: assistant.id,
      name: normalizeConversationTitle(conv.title),
      createdAt: fallbackTime(conv.createdAt),
      updatedAt: fallbackTime(conv.updatedAt),
      messages: [],
      isNameManuallyEdited: true,
    }));

    return {
      id: assistant.id || newId(),
      name: uniqueName,
      prompt: assistant.prompt || '',
      topics,
      type: 'assistant',
      emoji: '😀',
      settings: asRecord(assistant.settings),
      regularPhrases: [],
    };
  });
}

function buildCherryLlm(ir: BackupIR, warnings: string[]): Record<string, unknown> {
  const fromCherry = asRecord(asRecord(ir.config['cherry.persistSlices']).llm);
  if (Object.keys(fromCherry).length > 0) {
    return cloneJson(fromCherry);
  }

  const rikka = asRecord(ir.config['rikka.settings']);
  const providers = asArray(rikka.providers).map((raw) => {
    const provider = asRecord(raw);
    const providerId = asString(provider.id) || newId();
    const mappedType = mapProviderTypeToCherry(asString(provider.type));
    const models = asArray(provider.models).map((mRaw) => {
      const m = asRecord(mRaw);
      const id = asString(m.id) || asString(m.modelId) || newId();
      const out: Record<string, unknown> = {
        id,
        modelId: asString(m.modelId) || id,
        name: asString(m.displayName) || asString(m.name) || asString(m.modelId) || id,
        displayName: asString(m.displayName) || asString(m.name) || asString(m.modelId) || id,
        provider: providerId,
        group: 'default',
        type: 'CHAT',
      };
      if (Array.isArray(m.abilities) && m.abilities.length > 0) out.abilities = cloneJson(m.abilities);
      if (Array.isArray(m.inputModalities) && m.inputModalities.length > 0) out.inputModalities = cloneJson(m.inputModalities);
      if (Array.isArray(m.outputModalities) && m.outputModalities.length > 0) out.outputModalities = cloneJson(m.outputModalities);
      if (Array.isArray(m.tools) && m.tools.length > 0) out.tools = cloneJson(m.tools);
      return out;
    });
    if (models.length === 0) {
      warnings.push(`provider-invalid-disabled:${asString(provider.name) || providerId}:no-models`);
    }
    return {
      id: providerId,
      name: asString(provider.name) || 'Imported Provider',
      type: mappedType,
      apiHost: asString(provider.baseUrl),
      baseUrl: asString(provider.baseUrl),
      enabled: provider.enabled !== false && models.length > 0,
      models,
    };
  });

  const allModels = providers.flatMap((p) => asArray<Record<string, unknown>>(p.models));
  const fallbackModel = allModels[0] ?? {
    id: 'default-model',
    modelId: 'gpt-4o-mini',
    name: 'gpt-4o-mini',
    displayName: 'gpt-4o-mini',
    provider: asString(providers[0]?.id) || 'openai',
    group: 'default',
    type: 'CHAT',
  };
  const defaultModel = pickRikkaSelectionModel(allModels, asString(rikka.chatModelId), fallbackModel);
  const quickModel = pickRikkaSelectionModel(allModels, asString(rikka.suggestionModelId), defaultModel);
  const translateModel = pickRikkaSelectionModel(allModels, asString(rikka.translateModeId), defaultModel);
  const topicNamingModel = pickRikkaSelectionModel(allModels, asString(rikka.titleModelId), defaultModel);

  return {
    providers,
    defaultModel,
    quickModel,
    translateModel,
    topicNamingModel,
  };
}

function decodePersistSlices(payload: string): Record<string, unknown> {
  if (!payload) return {};
  try {
    const outer = asRecord(JSON.parse(payload));
    const decoded: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(outer)) {
      if (typeof v === 'string') {
        try {
          decoded[k] = JSON.parse(v);
        } catch {
          decoded[k] = v;
        }
      } else {
        decoded[k] = v;
      }
    }
    return decoded;
  } catch {
    return {};
  }
}

function encodePersistSlices(slices: Record<string, unknown>): string {
  const outer: Record<string, string> = {};
  for (const [k, v] of Object.entries(slices)) {
    outer[k] = marshalGoJSON(v);
  }
  return marshalGoJSON(outer);
}

function normalizeRole(role: string): string {
  const clean = role.trim().toLowerCase();
  if (clean === 'assistant' || clean === 'user' || clean === 'system') return clean;
  if (clean === 'tool') return 'assistant';
  return 'assistant';
}

function normalizeConversationTitle(input: string): string {
  const clean = normalizeText(input);
  if (!clean) return 'Imported Conversation';
  return truncate(clean, 80);
}

function normalizeTimestamp(value: unknown): string {
  const s = asString(value);
  if (s) return fallbackTime(s);
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return toRfc3339(n);
  return '';
}

function fallbackTime(value: string): string {
  const clean = value.trim();
  if (!clean) return toRfc3339(Date.now());
  const parsed = Date.parse(clean);
  if (Number.isNaN(parsed)) return clean;
  return toRfc3339(parsed);
}

function summarizeToolPart(part: IRPart): string {
  const lines: string[] = [];
  lines.push(`[tool] ${part.name || 'unknown'}`);
  if (part.input) lines.push(`input: ${part.input}`);
  if (part.output && part.output.length > 0) {
    lines.push(`output: ${part.output.map((o) => o.content ?? '').join(' | ')}`);
  }
  if (part.content) lines.push(`content: ${part.content}`);
  return lines.join('\n');
}

function stringifyJson(value: unknown): string {
  try {
    if (value === undefined) return '';
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function findCherryFilePath(entries: Map<string, Uint8Array>, id: string, ext: string, recordedPath: string): string {
  const candidateA = normalizePath(recordedPath);
  if (candidateA && entries.has(candidateA)) return candidateA;
  const candidateB = `Data/Files/${id}${ext}`;
  if (entries.has(candidateB)) return candidateB;
  for (const key of entries.keys()) {
    if (!key.startsWith('Data/Files/')) continue;
    const fileName = key.slice('Data/Files/'.length);
    if (fileName === id || fileName.startsWith(`${id}.`)) return key;
  }
  return '';
}

function ensureKeepFile(entries: Map<string, Uint8Array>): void {
  let hasFile = false;
  for (const key of entries.keys()) {
    if (key.startsWith('Data/Files/') && key !== 'Data/Files/.keep') {
      hasFile = true;
      break;
    }
  }
  if (!hasFile) {
    entries.set('Data/Files/.keep', new Uint8Array());
  }
}

function chooseCherryFileId(file: IRFile): string {
  const metadata = asRecord(file.metadata);
  const fromMeta = asString(metadata.cherry_id);
  if (isSafeFileStem(fromMeta)) return fromMeta;
  if (isSafeFileStem(file.id)) return file.id;
  return ensureUUIDUrl('', deterministicCherryFileSeed(file));
}

function isSafeFileStem(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

function deterministicCherryFileSeed(file: IRFile): string {
  const seed = [file.id.trim(), file.name.trim(), file.ext.trim(), file.relativeSrc.trim(), file.hashSha256.trim()].join('|');
  return seed || 'cherrikka:file:unknown';
}

function uniqueAssistantName(name: string, used: Set<string>): string {
  const clean = normalizeText(name) || 'Imported Assistant';
  if (!used.has(clean)) {
    used.add(clean);
    return clean;
  }
  let index = 2;
  let candidate = `${clean} (${index})`;
  while (used.has(candidate)) {
    index += 1;
    candidate = `${clean} (${index})`;
  }
  used.add(candidate);
  return candidate;
}

function mapProviderTypeToCherry(rawType: string): string {
  const clean = rawType.trim().toLowerCase();
  if (clean === 'claude' || clean === 'anthropic' || clean === 'vertex-anthropic') return 'anthropic';
  if (clean === 'google' || clean === 'gemini' || clean === 'vertexai') return 'gemini';
  return 'openai';
}

function pickRikkaSelectionModel(
  models: Record<string, unknown>[],
  selectedId: string,
  fallbackModel: Record<string, unknown>,
): Record<string, unknown> {
  if (selectedId) {
    const selected = models.find((model) => asString(model.id) === selectedId || asString(model.modelId) === selectedId);
    if (selected) return selected;
  }
  return fallbackModel;
}

function extractIndexedDbExtra(indexedDb: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(indexedDb)) {
    if (k === 'topics' || k === 'message_blocks' || k === 'files') continue;
    out[k] = v;
  }
  return out;
}

function extractCherryUnsupported(
  settings: Record<string, unknown>,
  persistSlices: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  const settingsUnsupported: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (key.toLowerCase().includes('memory') && isMeaningfulUnsupported(value)) {
      settingsUnsupported[key] = cloneJson(value);
    }
  }
  if (Object.keys(settingsUnsupported).length > 0) {
    out.settings = settingsUnsupported;
  }

  const persistUnsupported: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(persistSlices)) {
    if (key.toLowerCase().includes('memory') && isMeaningfulUnsupported(value)) {
      persistUnsupported[key] = cloneJson(value);
    }
  }
  if (Object.keys(persistUnsupported).length > 0) {
    out.persistSlices = persistUnsupported;
  }

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

function redactPersistSlices(slices: Record<string, unknown>): Record<string, unknown> {
  const clone = cloneJson(slices);
  const llm = asRecord(clone.llm);
  const providers = asArray(llm.providers);
  for (const raw of providers) {
    const provider = asRecord(raw);
    if (typeof provider.apiKey === 'string' && provider.apiKey.length > 0) {
      provider.apiKey = '***REDACTED***';
    }
  }
  clone.llm = llm;
  return clone;
}

export async function hydrateCherryFileHashes(files: IRFile[]): Promise<void> {
  for (const file of files) {
    file.hashSha256 = file.bytes.length ? await sha256Hex(file.bytes) : '';
  }
}
