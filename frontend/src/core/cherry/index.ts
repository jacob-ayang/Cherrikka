import type { ArchiveEntries } from '../backup/archive';
import {
  hasFile,
  hasPrefix,
  listByPrefix,
  readJson,
  writeJson,
  writeText,
  removeByPrefix,
} from '../backup/archive';
import type { BackupIR, IRConversation, IRFile, IRMessage, IRPart } from '../ir/types';
import {
  asArray,
  asMap,
  asString,
  dedupeStrings,
  isoNow,
  pickFirstString,
} from '../util/common';
import { extFromFileName, inferLogicalType, isSafeStem } from '../util/file';
import { sha256Hex } from '../util/hash';
import { newId } from '../util/id';
import { redactAny } from '../util/redact';
import { buildCherryPersistSlicesFromIR, normalizeFromCherryConfig } from '../mapping/settings';

export async function parseCherryArchive(entries: ArchiveEntries): Promise<BackupIR> {
  const root = readJson<Record<string, unknown>>(entries, 'data.json') ?? {};
  const localStorage = asMap(root.localStorage);
  const indexedDB = asMap(root.indexedDB);

  const ir: BackupIR = {
    sourceApp: 'cherry-studio',
    sourceFormat: 'cherry',
    createdAt: isoNow(),
    assistants: [],
    conversations: [],
    files: [],
    config: {
      'cherry.localStorageRaw': localStorage,
    },
    settings: {},
    opaque: {},
    secrets: {},
    warnings: [],
  };

  const blocksById: Record<string, Record<string, unknown>> = {};
  for (const item of asArray(indexedDB.message_blocks)) {
    const block = asMap(item);
    const id = asString(block.id);
    if (id) {
      blocksById[id] = block;
    }
  }

  const filesById: Record<string, IRFile> = {};
  for (const item of asArray(indexedDB.files)) {
    const record = asMap(item);
    const id = asString(record.id);
    if (!id) {
      continue;
    }
    const name = pickFirstString(record.origin_name, record.name, id);
    const ext = pickFirstString(record.ext, extFromFileName(name));
    const resolvedPath = resolveCherryFilePath(entries, id, ext);
    const bytes = resolvedPath ? entries.get(resolvedPath) : undefined;

    const file: IRFile = {
      id,
      name,
      ext,
      mimeType: asString(record.type),
      relativeSrc: resolvedPath,
      bytes: bytes ? new Uint8Array(bytes) : undefined,
      size: typeof record.size === 'number' ? record.size : bytes?.byteLength,
      createdAt: pickFirstString(record.created_at, record.createdAt),
      logicalType: inferLogicalType(asString(record.type), ext),
      missing: !bytes,
      metadata: {
        ...record,
        cherry_id: id,
        cherry_ext: ext,
      },
    };
    if (bytes) {
      file.hashSha256 = await sha256Hex(bytes);
    }
    filesById[id] = file;
  }

  for (const path of listByPrefix(entries, 'Data/Files')) {
    const bytes = entries.get(path);
    if (!bytes) continue;
    const fileName = path.split('/').at(-1) ?? '';
    const ext = extFromFileName(fileName);
    const id = ext ? fileName.slice(0, fileName.length - ext.length) : fileName;
    if (!id || filesById[id]) {
      continue;
    }
    filesById[id] = {
      id,
      name: fileName,
      ext,
      logicalType: inferLogicalType('', ext),
      orphan: true,
      relativeSrc: path,
      bytes: new Uint8Array(bytes),
      size: bytes.byteLength,
      hashSha256: await sha256Hex(bytes),
      createdAt: isoNow(),
      updatedAt: isoNow(),
      metadata: {
        discovered: true,
        cherry_id: id,
        cherry_ext: ext,
      },
    };
  }

  ir.files = Object.values(filesById).sort((a, b) => a.id.localeCompare(b.id));

  for (const topicRaw of asArray(indexedDB.topics)) {
    const topic = asMap(topicRaw);
    const conversation: IRConversation = {
      id: pickFirstString(topic.id, newId()),
      assistantId: asString(topic.assistantId),
      title: pickFirstString(topic.name),
      messages: [],
      opaque: {},
    };

    for (const messageRaw of asArray(topic.messages)) {
      const messageMap = asMap(messageRaw);
      const message = toIRMessage(messageMap, blocksById, filesById);
      conversation.messages.push(message);
    }

    ir.conversations.push(conversation);
  }

  parsePersistSlices(ir, localStorage);

  const unknownTables: Record<string, unknown> = {};
  for (const [table, value] of Object.entries(indexedDB)) {
    if (table === 'topics' || table === 'message_blocks' || table === 'files') {
      continue;
    }
    unknownTables[table] = value;
  }
  if (Object.keys(unknownTables).length > 0) {
    ir.opaque['cherry.indexedDB.extra'] = unknownTables;
  }

  const [normalized, warnings] = normalizeFromCherryConfig(ir.config);
  ir.settings = normalized;
  ir.warnings = dedupeStrings([
    ...ir.warnings,
    ...warnings,
    ...ir.files.filter((f) => f.missing).map((f) => `missing cherry file payload: ${f.id}`),
  ]);

  return ir;
}

export function validateCherryArchive(entries: ArchiveEntries): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!hasFile(entries, 'data.json')) {
    errors.push('missing data.json');
  }
  if (!hasPrefix(entries, 'Data')) {
    errors.push('missing Data directory');
  }
  if (errors.length > 0) {
    return { errors: dedupeStrings(errors), warnings: dedupeStrings(warnings) };
  }

  const root = readJson<Record<string, unknown>>(entries, 'data.json');
  if (!root) {
    errors.push('invalid data.json');
    return { errors: dedupeStrings(errors), warnings: dedupeStrings(warnings) };
  }

  const indexedDB = asMap(root.indexedDB);
  const fileIds = new Set<string>();

  for (const item of asArray(indexedDB.files)) {
    const record = asMap(item);
    const id = asString(record.id);
    if (!id) {
      continue;
    }
    fileIds.add(id);
    const ext = pickFirstString(record.ext);
    const resolvedPath = resolveCherryFilePath(entries, id, ext);
    if (!resolvedPath || !entries.has(resolvedPath)) {
      errors.push(`indexedDB.files entry missing payload: ${id}`);
    }
  }

  for (const item of asArray(indexedDB.message_blocks)) {
    const block = asMap(item);
    const file = asMap(block.file);
    const fileId = asString(file.id);
    if (!fileId) {
      continue;
    }
    if (!fileIds.has(fileId)) {
      errors.push(`message_blocks.file.id not found in indexedDB.files: ${fileId}`);
    }
  }

  return { errors: dedupeStrings(errors), warnings: dedupeStrings(warnings) };
}

export async function buildCherryArchiveFromIR(
  ir: BackupIR,
  outputEntries: ArchiveEntries,
  redactSecrets: boolean,
  idMap: Record<string, string>,
): Promise<string[]> {
  const warnings: string[] = [];

  const baseData = readJson<Record<string, unknown>>(outputEntries, 'data.json') ?? {};
  const indexedDB = asMap(baseData.indexedDB);
  const localStorage = asMap(baseData.localStorage);

  removeByPrefix(outputEntries, 'Data/Files');

  const { fileTable, warnings: fileWarnings } = await materializeCherryFiles(outputEntries, ir.files, idMap);
  warnings.push(...fileWarnings);
  indexedDB.files = fileTable;

  const convByAssistant: Record<string, IRConversation[]> = {};
  for (const conversation of ir.conversations) {
    const key = conversation.assistantId ?? '';
    if (!convByAssistant[key]) convByAssistant[key] = [];
    convByAssistant[key].push(conversation);
  }

  const messageBlocks: Record<string, unknown>[] = [];
  const topics: Record<string, unknown>[] = [];

  for (const conversation of ir.conversations) {
    const topicId = conversation.id || newId();
    idMap[`topic:${conversation.id}`] = topicId;

    const topicMessages: Record<string, unknown>[] = [];
    for (const message of conversation.messages) {
      const messageId = message.id || newId();
      idMap[`message:${message.id}`] = messageId;
      const blockIds: string[] = [];

      for (const part of message.parts) {
        const blockId = newId();
        blockIds.push(blockId);
        messageBlocks.push(partToCherryBlock(blockId, messageId, part, ir.files, idMap));
      }

      topicMessages.push({
        id: messageId,
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
      messages: topicMessages,
      name: conversation.title,
      assistantId: conversation.assistantId,
    });
  }

  indexedDB.topics = topics;
  indexedDB.message_blocks = messageBlocks;

  const extraTables = asMap(ir.opaque['cherry.indexedDB.extra']);
  for (const [table, value] of Object.entries(extraTables)) {
    if (table in indexedDB) continue;
    indexedDB[table] = cloneTableValue(value);
  }

  let persistSlices = asMap(ir.config['cherry.persistSlices']);
  if (Object.keys(persistSlices).length === 0) {
    persistSlices = defaultPersistSlices();
  }

  const assistantsSlice = buildAssistantsSlice(ir.assistants, convByAssistant);
  let nextSlices: Record<string, unknown>;
  let mappingWarnings: string[];
  [nextSlices, mappingWarnings] = buildCherryPersistSlicesFromIR(ir, persistSlices, assistantsSlice);
  warnings.push(...mappingWarnings);

  if (redactSecrets) {
    nextSlices = redactAny(nextSlices) as Record<string, unknown>;
  }

  const persistRaw: Record<string, string> = {};
  for (const [key, value] of Object.entries(nextSlices)) {
    persistRaw[key] = JSON.stringify(value);
  }
  localStorage['persist:cherry-studio'] = JSON.stringify(persistRaw);

  const data = {
    ...baseData,
    time: Date.now(),
    version: 5,
    localStorage,
    indexedDB,
  };

  writeJson(outputEntries, 'data.json', data, false);
  return dedupeStrings(warnings);
}

function parsePersistSlices(ir: BackupIR, localStorage: Record<string, unknown>): void {
  const persistRaw = asString(localStorage['persist:cherry-studio']);
  if (!persistRaw) {
    return;
  }

  let persistSlices: Record<string, unknown>;
  try {
    persistSlices = JSON.parse(persistRaw) as Record<string, unknown>;
  } catch {
    ir.warnings.push('parse persist:cherry-studio failed');
    return;
  }

  const decoded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(persistSlices)) {
    const text = asString(value);
    if (!text) {
      decoded[key] = value;
      continue;
    }
    try {
      decoded[key] = JSON.parse(text) as unknown;
    } catch {
      decoded[key] = value;
    }
  }

  ir.config['cherry.persistSlices'] = decoded;

  const assistants = asArray(asMap(decoded.assistants).assistants);
  for (const item of assistants) {
    const assistant = asMap(item);
    ir.assistants.push({
      id: pickFirstString(assistant.id, newId()),
      name: pickFirstString(assistant.name),
      prompt: pickFirstString(assistant.prompt),
      description: pickFirstString(assistant.description),
      model: asMap(assistant.model),
      settings: asMap(assistant.settings),
      opaque: {},
    });
  }

  if (decoded.settings) {
    ir.config['cherry.settings'] = decoded.settings;
  }
  if (decoded.llm) {
    ir.config['cherry.llm'] = decoded.llm;
  }
}

function toIRMessage(
  messageMap: Record<string, unknown>,
  blocksById: Record<string, Record<string, unknown>>,
  filesById: Record<string, IRFile>,
): IRMessage {
  const message: IRMessage = {
    id: pickFirstString(messageMap.id, newId()),
    role: pickFirstString(messageMap.role, 'user'),
    createdAt: pickFirstString(messageMap.createdAt),
    modelId: pickFirstString(messageMap.modelId),
    parts: [],
    opaque: {},
  };

  for (const blockIdValue of asArray(messageMap.blocks)) {
    const blockId = asString(blockIdValue);
    if (!blockId) continue;
    const block = blocksById[blockId];
    if (!block) continue;
    message.parts.push(mapBlockToPart(block, filesById));
  }

  if (message.parts.length === 0) {
    message.parts.push({ type: 'text', content: pickFirstString(messageMap.content) });
  }
  if (message.parts.length === 0) {
    message.parts.push({ type: 'text', content: '' });
  }
  return message;
}

function mapBlockToPart(block: Record<string, unknown>, filesById: Record<string, IRFile>): IRPart {
  const blockType = pickFirstString(block.type);
  const basePart: IRPart = {
    type: 'text',
    metadata: {
      cherryBlockType: blockType,
    },
  };

  if (['main_text', 'code', 'translation', 'compact'].includes(blockType)) {
    basePart.type = 'text';
    basePart.content = pickFirstString(block.content);
  } else if (blockType === 'thinking') {
    basePart.type = 'reasoning';
    basePart.content = pickFirstString(block.content);
  } else if (blockType === 'tool') {
    basePart.type = 'tool';
    basePart.name = pickFirstString(block.toolName);
    basePart.toolCallId = pickFirstString(block.toolId);
    if (block.arguments !== undefined) {
      basePart.input = JSON.stringify(block.arguments);
    }
    if (asString(block.content)) {
      basePart.output = [{ type: 'text', content: pickFirstString(block.content) }];
    }
  } else if (blockType === 'image' || blockType === 'video') {
    basePart.type = blockType;
    basePart.mediaUrl = pickFirstString(block.url);
    fillPartFileInfo(basePart, block, filesById);
  } else if (blockType === 'file') {
    basePart.type = 'document';
    fillPartFileInfo(basePart, block, filesById);
    if (!basePart.name) {
      basePart.name = pickFirstString(block.name);
    }
  } else {
    basePart.type = 'text';
    basePart.content = pickFirstString(block.content, `[unsupported cherry block: ${blockType}]`);
    (basePart.metadata as Record<string, unknown>).raw = block;
  }

  return basePart;
}

function fillPartFileInfo(part: IRPart, block: Record<string, unknown>, filesById: Record<string, IRFile>): void {
  const file = asMap(block.file);
  if (Object.keys(file).length === 0) return;
  const fileId = pickFirstString(file.id);
  if (fileId) {
    part.fileId = fileId;
  }
  part.name = part.name ?? pickFirstString(file.origin_name, file.name);
  if (!part.mimeType && fileId && filesById[fileId]) {
    part.mimeType = filesById[fileId].mimeType;
  }
}

async function materializeCherryFiles(
  outputEntries: ArchiveEntries,
  files: IRFile[],
  idMap: Record<string, string>,
): Promise<{ fileTable: Record<string, unknown>[]; warnings: string[] }> {
  const warnings: string[] = [];
  const fileTable: Record<string, unknown>[] = [];
  const usedIds = new Set<string>();

  for (const file of files) {
    let fileId = chooseCherryFileId(file);
    if (usedIds.has(fileId)) {
      fileId = newId();
    }
    usedIds.add(fileId);
    idMap[`file:${file.id}`] = fileId;

    const ext = pickFirstString(file.ext, extFromFileName(file.name));
    const fileName = `${fileId}${ext}`;
    const path = `Data/Files/${fileName}`;

    const bytes = file.bytes ?? new Uint8Array();
    if (!file.bytes) {
      warnings.push(`file ${file.id} missing source payload; created empty placeholder`);
    }
    outputEntries.set(path, bytes);

    fileTable.push({
      id: fileId,
      name: fileName,
      origin_name: pickFirstString(file.name, fileName),
      path,
      size: file.size ?? bytes.byteLength,
      ext,
      type: pickFirstString(file.logicalType, file.mimeType, 'other'),
      created_at: fallbackTime(file.createdAt),
      count: 1,
    });
  }

  return { fileTable, warnings: dedupeStrings(warnings) };
}

function partToCherryBlock(
  blockId: string,
  messageId: string,
  part: IRPart,
  files: IRFile[],
  idMap: Record<string, string>,
): Record<string, unknown> {
  const block: Record<string, unknown> = {
    id: blockId,
    messageId,
    createdAt: isoNow(),
    status: 'success',
  };

  if (part.metadata) {
    block.metadata = part.metadata;
  }

  const findFileRef = (fileId: string): Record<string, unknown> | undefined => {
    const mapped = idMap[`file:${fileId}`];
    for (const file of files) {
      if (file.id !== fileId && idMap[`file:${file.id}`] !== mapped) {
        continue;
      }
      const resolvedId = mapped || file.id;
      const ext = pickFirstString(file.ext, extFromFileName(file.name));
      return {
        id: resolvedId,
        name: `${resolvedId}${ext}`,
        origin_name: file.name,
        ext,
        size: file.size ?? file.bytes?.byteLength ?? 0,
        type: pickFirstString(file.logicalType, file.mimeType, 'other'),
      };
    }
    return undefined;
  };

  switch (part.type) {
    case 'reasoning':
      block.type = 'thinking';
      block.content = part.content ?? '';
      break;
    case 'tool':
      block.type = 'tool';
      block.toolId = pickFirstString(part.toolCallId, newId());
      block.toolName = pickFirstString(part.name, 'tool');
      if (part.input) {
        try {
          block.arguments = JSON.parse(part.input) as unknown;
        } catch {
          block.arguments = { raw: part.input };
        }
      }
      if (part.output && part.output.length > 0) {
        block.content = part.output[0].content ?? '';
      }
      break;
    case 'image':
    case 'video':
      block.type = part.type;
      block.url = part.mediaUrl ?? '';
      if (part.fileId) {
        const file = findFileRef(part.fileId);
        if (file) block.file = file;
      }
      break;
    case 'audio':
    case 'document':
      block.type = 'file';
      if (part.fileId) {
        const file = findFileRef(part.fileId);
        if (file) block.file = file;
      }
      if (part.content) {
        block.content = part.content;
      }
      break;
    default:
      block.type = 'main_text';
      block.content = part.content ?? '';
  }

  return block;
}

function buildAssistantsSlice(
  assistants: BackupIR['assistants'],
  convByAssistant: Record<string, IRConversation[]>,
): Record<string, unknown> {
  const normalized = assistants.length > 0 ? assistants : [{ id: 'default', name: 'Default' }];

  const list = normalized.map((assistant, index) => {
    const assistantId = pickFirstString(assistant.id, newId());
    const topics = (convByAssistant[assistantId] ?? []).map((conversation) => ({
      id: pickFirstString(conversation.id, newId()),
      assistantId,
      name: pickFirstString(conversation.title, 'New Topic'),
      createdAt: fallbackTime(conversation.createdAt),
      updatedAt: fallbackTime(conversation.updatedAt),
      messages: [],
      isNameManuallyEdited: true,
    }));

    if (topics.length === 0) {
      topics.push({
        id: newId(),
        assistantId,
        name: 'New Topic',
        createdAt: isoNow(),
        updatedAt: isoNow(),
        messages: [],
        isNameManuallyEdited: false,
      });
    }

    return {
      id: assistantId,
      name: pickFirstString(assistant.name, `Assistant ${index + 1}`),
      prompt: assistant.prompt ?? '',
      topics,
      type: 'assistant',
      emoji: '😀',
      settings: Object.keys(asMap(assistant.settings)).length > 0
        ? assistant.settings
        : { contextCount: 32, temperature: 0.7, streamOutput: true },
      regularPhrases: [],
    };
  });

  const defaultAssistant = { ...list[0], id: 'default', name: 'Default' };
  return {
    defaultAssistant,
    assistants: list,
    tagsOrder: [],
    collapsedTags: {},
    presets: [],
    unifiedListOrder: [],
  };
}

function defaultPersistSlices(): Record<string, unknown> {
  return {
    settings: {
      userId: newId(),
      userName: '',
      skipBackupFile: false,
    },
    llm: {
      defaultModel: {
        id: 'default-model',
        provider: 'openai',
        name: 'gpt-4o-mini',
        group: 'default',
      },
      quickModel: null,
      translateModel: null,
      topicNamingModel: null,
    },
    backup: {
      webdavSync: { lastSyncTime: null, syncing: false, lastSyncError: null },
      localBackupSync: { lastSyncTime: null, syncing: false, lastSyncError: null },
      s3Sync: { lastSyncTime: null, syncing: false, lastSyncError: null },
    },
  };
}

function resolveCherryFilePath(entries: ArchiveEntries, id: string, ext: string): string | undefined {
  const direct = `Data/Files/${id}${ext}`;
  if (entries.has(direct)) {
    return direct;
  }
  for (const path of listByPrefix(entries, 'Data/Files')) {
    const fileName = path.split('/').at(-1) ?? '';
    if (fileName === id || fileName.startsWith(`${id}.`)) {
      return path;
    }
  }
  return undefined;
}

function chooseCherryFileId(file: IRFile): string {
  const metadata = asMap(file.metadata);
  const metadataId = asString(metadata.cherry_id);
  if (metadataId && isSafeStem(metadataId)) {
    return metadataId;
  }
  if (isSafeStem(file.id)) {
    return file.id;
  }
  return newId();
}

function fallbackTime(value?: string): string {
  return pickFirstString(value, isoNow());
}

function normalizeRole(role: string): string {
  const normalized = role.trim().toLowerCase();
  if (normalized === 'assistant' || normalized === 'user' || normalized === 'system') {
    return normalized;
  }
  return 'assistant';
}

function cloneTableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => cloneTableValue(item));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = cloneTableValue(child);
    }
    return out;
  }
  return value;
}

export function seedCherryTemplate(entries: ArchiveEntries): void {
  if (!hasFile(entries, 'data.json')) {
    const skeleton = {
      time: Date.now(),
      version: 5,
      localStorage: {},
      indexedDB: {},
    };
    writeText(entries, 'data.json', JSON.stringify(skeleton));
  }
}
