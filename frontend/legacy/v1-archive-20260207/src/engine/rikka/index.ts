import type { Database } from 'sql.js';
import { validate as uuidValidate, v5 as uuidv5 } from 'uuid';
import type { ArchiveEntries } from '../backup/archive';
import {
  hasFile,
  listByPrefix,
  readJson,
  removeByPrefix,
  writeJson,
} from '../backup/archive';
import type { BackupIR, IRConversation, IRFile, IRMessage, IRPart } from '../ir/types';
import {
  asArray,
  asMap,
  asString,
  cloneAny,
  dedupeStrings,
  isoNow,
  pickFirstString,
} from '../util/common';
import { extFromFileName, inferLogicalType, isSafeStem } from '../util/file';
import { sha256Hex } from '../util/hash';
import { marshalGoJSON } from '../util/go_json';
import { newId } from '../util/id';
import { redactAny } from '../util/redact';
import {
  DEFAULT_ASSISTANT_ID,
  buildRikkaSettingsFromIR,
  ensureNormalizedSettings,
  normalizeFromRikkaConfig,
} from '../mapping/settings';
import { openDatabase } from '../../vendor/sql';

const DEFAULT_IDENTITY_HASH = '6973cccf653b3a6e80900c4e065ed25e';
const UUID_NAMESPACE_OID = '6ba7b812-9dad-11d1-80b4-00c04fd430c8';

const SCHEMA_SQL = [
  "CREATE TABLE IF NOT EXISTS ConversationEntity (`id` TEXT NOT NULL, `assistant_id` TEXT NOT NULL DEFAULT '0950e2dc-9bd5-4801-afa3-aa887aa36b4e', `title` TEXT NOT NULL, `nodes` TEXT NOT NULL, `create_at` INTEGER NOT NULL, `update_at` INTEGER NOT NULL, `truncate_index` INTEGER NOT NULL DEFAULT -1, `suggestions` TEXT NOT NULL DEFAULT '[]', `is_pinned` INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(`id`))",
  'CREATE TABLE IF NOT EXISTS MemoryEntity (`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, `assistant_id` TEXT NOT NULL, `content` TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS GenMediaEntity (`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, `path` TEXT NOT NULL, `model_id` TEXT NOT NULL, `prompt` TEXT NOT NULL, `create_at` INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS message_node (`id` TEXT NOT NULL, `conversation_id` TEXT NOT NULL, `node_index` INTEGER NOT NULL, `messages` TEXT NOT NULL, `select_index` INTEGER NOT NULL, PRIMARY KEY(`id`), FOREIGN KEY(`conversation_id`) REFERENCES `ConversationEntity`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE )',
  'CREATE TABLE IF NOT EXISTS managed_files (`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, `folder` TEXT NOT NULL, `relative_path` TEXT NOT NULL, `display_name` TEXT NOT NULL, `mime_type` TEXT NOT NULL, `size_bytes` INTEGER NOT NULL, `created_at` INTEGER NOT NULL, `updated_at` INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS `index_message_node_conversation_id` ON `message_node` (`conversation_id`)',
  'CREATE UNIQUE INDEX IF NOT EXISTS `index_managed_files_relative_path` ON `managed_files` (`relative_path`)',
  'CREATE INDEX IF NOT EXISTS `index_managed_files_folder` ON `managed_files` (`folder`)',
  'CREATE TABLE IF NOT EXISTS room_master_table (id INTEGER PRIMARY KEY,identity_hash TEXT)',
];

export async function validateRikkaArchive(entries: ArchiveEntries): Promise<{ errors: string[]; warnings: string[] }> {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!hasFile(entries, 'settings.json')) {
    errors.push('missing settings.json');
  }
  if (!hasFile(entries, 'rikka_hub.db')) {
    errors.push('missing rikka_hub.db');
  }
  if (errors.length > 0) {
    return { errors: dedupeStrings(errors), warnings: dedupeStrings(warnings) };
  }

  const dbBytes = entries.get('rikka_hub.db');
  if (!dbBytes) {
    errors.push('missing rikka_hub.db payload');
    return { errors: dedupeStrings(errors), warnings: dedupeStrings(warnings) };
  }

  let db: Database | null = null;
  try {
    db = await openDatabase(dbBytes);
    const settings = readJson<Record<string, unknown>>(entries, 'settings.json') ?? {};
    const validAssistantIds = new Set<string>();
    const enabledModelIds = new Set<string>();
    for (const providerValue of asArray(settings.providers)) {
      const provider = asMap(providerValue);
      const providerId = asString(provider.id);
      const enabled = asBool(provider.enabled) ?? true;
      const models = asArray(provider.models);
      if (enabled && models.length === 0) {
        errors.push(`enabled provider has no models: ${providerId}`);
      }
      for (const modelValue of models) {
        const model = asMap(modelValue);
        const modelId = pickFirstString(model.id, model.modelId);
        if (!modelId) {
          continue;
        }
        if (enabled) {
          enabledModelIds.add(modelId);
        }
      }
    }

    const checkModelRef = (field: string, modelId: string): void => {
      const normalized = modelId.trim();
      if (!normalized) {
        return;
      }
      if (!enabledModelIds.has(normalized)) {
        errors.push(`${field} not found in enabled providers: ${normalized}`);
      }
    };

    for (const key of ['chatModelId', 'titleModelId', 'translateModeId', 'suggestionModelId', 'imageGenerationModelId']) {
      checkModelRef(`settings.${key}`, asString(settings[key]));
    }

    for (const assistantValue of asArray(settings.assistants)) {
      const assistant = asMap(assistantValue);
      const assistantId = asString(assistant.id).trim();
      if (assistantId) {
        validAssistantIds.add(assistantId);
      }
      checkModelRef('assistant.chatModelId', asString(assistant.chatModelId));
    }

    const hasManagedTable = tableExists(db, 'managed_files');
    const managed = new Set<string>();
    if (hasManagedTable) {
      for (const row of queryRows(db, 'SELECT relative_path FROM managed_files')) {
        const rel = asString(row.relative_path);
        if (!rel) continue;
        managed.add(rel);
        if (!entries.has(rel)) {
          errors.push(`managed_files payload missing: ${rel}`);
        }
      }
    } else {
      warnings.push('managed_files table missing; skipping managed file index');
    }

    for (const row of queryRows(db, 'SELECT messages FROM message_node')) {
      const messagesText = asString(row.messages);
      if (!messagesText) continue;
      let messages: unknown[] = [];
      try {
        messages = JSON.parse(messagesText) as unknown[];
      } catch {
        continue;
      }
      for (const messageValue of messages) {
        const message = asMap(messageValue);
        for (const partValue of asArray(message.parts)) {
          const part = asMap(partValue);
          const url = asString(part.url);
          if (!url.startsWith('file://')) continue;
          const fileName = fileNameFromUrl(url);
          if (!fileName) continue;
          const rel = `upload/${fileName}`;
          if (hasManagedTable) {
            if (!managed.has(rel)) {
              errors.push(`message_node file url has no managed_files entry: ${rel}`);
            }
            continue;
          }
          if (!entries.has(rel)) {
            errors.push(`message_node file url payload missing: ${rel}`);
          }
        }
      }
    }

    if (validAssistantIds.size > 0) {
      for (const row of queryRows(db, 'SELECT DISTINCT assistant_id FROM ConversationEntity')) {
        const assistantId = asString(row.assistant_id).trim();
        if (!assistantId) continue;
        if (!validAssistantIds.has(assistantId)) {
          errors.push(`conversation assistant_id missing in settings.assistants: ${assistantId}`);
        }
      }
    }
  } catch (error) {
    errors.push(`open rikka_hub.db failed: ${toErr(error)}`);
  } finally {
    db?.close();
  }

  return { errors: dedupeStrings(errors), warnings: dedupeStrings(warnings) };
}

export async function parseRikkaArchive(entries: ArchiveEntries): Promise<BackupIR> {
  const settings = readJson<Record<string, unknown>>(entries, 'settings.json') ?? {};

  const ir: BackupIR = {
    sourceApp: 'rikkahub',
    sourceFormat: 'rikka',
    createdAt: isoNow(),
    assistants: [],
    conversations: [],
    files: [],
    config: {
      'rikka.settings': settings,
    },
    settings: {},
    opaque: {},
    secrets: {},
    warnings: [],
  };
  if (hasFile(entries, 'cherrikka/manifest.json') && hasFile(entries, 'cherrikka/raw/source.zip')) {
    ir.opaque['interop.sidecar.available'] = true;
  }
  const isolatedUnsupported = extractRikkaUnsupportedSettings(settings);
  if (Object.keys(isolatedUnsupported).length > 0) {
    ir.opaque['interop.rikka.unsupported'] = isolatedUnsupported;
    ir.warnings.push('unsupported-isolated:rikka.settings');
  }

  const dbBytes = entries.get('rikka_hub.db');
  if (!dbBytes) {
    ir.warnings.push('missing rikka_hub.db payload');
    const [normalized, warnings] = normalizeFromRikkaConfig(ir.config);
    ir.settings = normalized;
    ir.warnings = dedupeStrings([...ir.warnings, ...warnings]);
    return ir;
  }

  const filesByRel = new Map<string, IRFile>();
  const fileWarnings: string[] = [];

  const db = await openDatabase(dbBytes);
  try {
    const hasManagedTable = tableExists(db, 'managed_files');
    if (hasManagedTable) {
      for (const row of queryRows(db, 'SELECT id, folder, relative_path, display_name, mime_type, size_bytes, created_at, updated_at FROM managed_files')) {
        const managedId = row.id;
        const relPath = asString(row.relative_path);
        if (!relPath) {
          continue;
        }
        const displayName = pickFirstString(row.display_name, relPath.split('/').at(-1));
        const bytes = entries.get(relPath);
        const ext = extFromFileName(displayName);
        const file: IRFile = {
          id: `managed:${String(managedId ?? newId())}`,
          name: displayName,
          relativeSrc: relPath,
          bytes: bytes ? new Uint8Array(bytes) : undefined,
          size: numberOrUndefined(row.size_bytes) ?? bytes?.byteLength,
          mimeType: asString(row.mime_type),
          ext,
          createdAt: millisToIso(row.created_at),
          updatedAt: millisToIso(row.updated_at),
          logicalType: inferLogicalType(asString(row.mime_type), ext),
          missing: !bytes,
          metadata: {
            managed_id: managedId,
            folder: asString(row.folder),
            created_at: row.created_at,
            updated_at: row.updated_at,
            'rikka.relative_path': relPath,
            'rikka.display_name': displayName,
            'rikka.original_mime': asString(row.mime_type),
            'rikka.original_bytes': numberOrUndefined(row.size_bytes),
          },
        };
        if (bytes) {
          file.hashSha256 = await sha256Hex(bytes);
        } else {
          fileWarnings.push(`missing managed file payload: ${relPath}`);
        }
        filesByRel.set(relPath, file);
      }
    } else {
      fileWarnings.push('managed_files table missing; skipping managed file index');
    }

    for (const relPath of listByPrefix(entries, 'upload')) {
      if (filesByRel.has(relPath)) {
        continue;
      }
      const bytes = entries.get(relPath);
      if (!bytes) continue;
      const name = relPath.split('/').at(-1) ?? relPath;
      const ext = extFromFileName(name);
      filesByRel.set(relPath, {
        id: `upload:${name}`,
        name,
        relativeSrc: relPath,
        bytes: new Uint8Array(bytes),
        size: bytes.byteLength,
        ext,
        hashSha256: await sha256Hex(bytes),
        createdAt: isoNow(),
        updatedAt: isoNow(),
        logicalType: inferLogicalType('', ext),
        orphan: true,
        metadata: {
          discovered: true,
          'rikka.relative_path': relPath,
        },
      });
      fileWarnings.push(`orphan upload file discovered: ${relPath}`);
    }

    ir.files = Array.from(filesByRel.values()).sort((a, b) => a.id.localeCompare(b.id));

    for (const row of queryRows(
      db,
      'SELECT id, assistant_id, title, create_at, update_at, truncate_index, suggestions, is_pinned FROM ConversationEntity ORDER BY update_at DESC',
    )) {
      const conversationId = pickFirstString(row.id, newId());
      const conversation: IRConversation = {
        id: conversationId,
        assistantId: asString(row.assistant_id),
        title: asString(row.title),
        createdAt: millisToIso(row.create_at),
        updatedAt: millisToIso(row.update_at),
        messages: [],
        opaque: {
          truncateIndex: row.truncate_index,
          suggestions: row.suggestions,
          isPinned: row.is_pinned,
        },
      };

      for (const node of queryRows(
        db,
        'SELECT id, node_index, messages, select_index FROM message_node WHERE conversation_id = ? ORDER BY node_index ASC',
        [conversationId],
      )) {
        const nodeId = pickFirstString(node.id, newId());
        const messagesText = asString(node.messages);
        if (!messagesText) {
          continue;
        }

        let messages: unknown[] = [];
        try {
          messages = JSON.parse(messagesText) as unknown[];
        } catch {
          conversation.opaque = conversation.opaque ?? {};
          conversation.opaque[`node_unparsed:${nodeId}`] = messagesText;
          continue;
        }
        if (messages.length === 0) {
          continue;
        }

        let selectedIndex = numberOrZero(node.select_index);
        if (selectedIndex < 0 || selectedIndex >= messages.length) {
          selectedIndex = 0;
        }

        const selected = asMap(messages[selectedIndex]);
        const parsedMessage = parseRikkaMessage(selected, filesByRel);
        if (!parsedMessage.id) {
          parsedMessage.id = newId();
        }
        if (!parsedMessage.role) {
          parsedMessage.role = 'assistant';
        }
        conversation.messages.push(parsedMessage);

        if (messages.length > 1) {
          conversation.opaque = conversation.opaque ?? {};
          conversation.opaque[`node:${nodeId}:branches`] = messages;
        }
      }

      ir.conversations.push(conversation);
    }
  } finally {
    db.close();
  }

  const assistants = asArray(settings.assistants);
  for (const rawValue of assistants) {
    const assistant = asMap(rawValue);
    const assistantId = rawString(assistant.id);
    ir.assistants.push({
      id: assistantId || newId(),
      name: rawString(assistant.name),
      prompt: rawString(assistant.systemPrompt),
      description: '',
      model: {
        chatModelId: assistant.chatModelId,
      },
      settings: {},
      opaque: assistant,
    });
  }

  const [normalized, warnings] = normalizeFromRikkaConfig(ir.config);
  ir.settings = normalized;
  ir.warnings = dedupeStrings([...ir.warnings, ...warnings, ...fileWarnings]);

  return ir;
}

export async function buildRikkaArchiveFromIR(
  ir: BackupIR,
  outputEntries: ArchiveEntries,
  redactSecrets: boolean,
  idMap: Record<string, string>,
): Promise<string[]> {
  const warnings: string[] = [];
  warnings.push(...ensureNormalizedSettings(ir));

  let baseSettings = readJson<Record<string, unknown>>(outputEntries, 'settings.json') ?? {};
  if (Object.keys(baseSettings).length === 0) {
    baseSettings = asMap(ir.config['rikka.settings']);
  }

  let mappedSettings: Record<string, unknown>;
  let mappingWarnings: string[];
  [mappedSettings, mappingWarnings] = buildRikkaSettingsFromIR(ir, baseSettings);
  warnings.push(...mappingWarnings);
  if (redactSecrets) {
    mappedSettings = redactAny(mappedSettings) as Record<string, unknown>;
  }
  writeJson(outputEntries, 'settings.json', mappedSettings, false);

  const identityHash = await resolveIdentityHash(outputEntries);
  removeByPrefix(outputEntries, 'upload');

  const db = await openDatabase();
  try {
    for (const statement of SCHEMA_SQL) {
      db.run(statement);
    }
    db.run('INSERT OR REPLACE INTO room_master_table (id, identity_hash) VALUES(42, ?)', [identityHash]);

    const filePathById: Record<string, string> = {};
    const fileWarnings = materializeFiles(db, outputEntries, ir.files, filePathById, idMap);
    warnings.push(...fileWarnings);

    const resolveAssistantId = createAssistantResolver(mappedSettings);
    const flattenToolCalls = asString(ir.sourceFormat).toLowerCase() === 'cherry';
    const conversationWarnings = writeConversations(
      db,
      ir.conversations,
      filePathById,
      idMap,
      resolveAssistantId,
      flattenToolCalls,
    );
    warnings.push(...conversationWarnings);

    const dbBytes = db.export();
    outputEntries.set('rikka_hub.db', dbBytes);
    // Force target restore flow to replace stale local WAL/SHM files.
    outputEntries.set('rikka_hub-wal', new Uint8Array());
    outputEntries.set('rikka_hub-shm', new Uint8Array());
  } finally {
    db.close();
  }

  return dedupeStrings(warnings);
}

export async function seedRikkaTemplate(entries: ArchiveEntries): Promise<void> {
  if (!hasFile(entries, 'settings.json')) {
    writeJson(
      entries,
      'settings.json',
      {
        assistantId: DEFAULT_ASSISTANT_ID,
        providers: [],
        assistants: [],
      },
      false,
    );
  }
  if (!hasFile(entries, 'rikka_hub.db')) {
    const db = await openDatabase();
    try {
      for (const statement of SCHEMA_SQL) {
        db.run(statement);
      }
      db.run('INSERT OR REPLACE INTO room_master_table (id, identity_hash) VALUES(42, ?)', [DEFAULT_IDENTITY_HASH]);
      entries.set('rikka_hub.db', db.export());
    } finally {
      db.close();
    }
  }
}

function parseRikkaMessage(raw: Record<string, unknown>, filesByRel: Map<string, IRFile>): IRMessage {
  const message: IRMessage = {
    id: pickFirstString(raw.id, newId()),
    role: pickFirstString(raw.role).toLowerCase() || 'assistant',
    createdAt: pickFirstString(raw.createdAt),
    modelId: pickFirstString(raw.modelId),
    parts: [],
    opaque: {},
  };

  for (const partRaw of asArray(raw.parts)) {
    const part = parseRikkaPart(asMap(partRaw), filesByRel);
    message.parts.push(part);
  }

  if (message.parts.length === 0) {
    message.parts.push({ type: 'text', content: '' });
  }

  return message;
}

function parseRikkaPart(raw: Record<string, unknown>, filesByRel: Map<string, IRFile>): IRPart {
  const typeString = pickFirstString(raw.type);
  const metadata: Record<string, unknown> = { rikkaType: typeString };
  const part: IRPart = {
    type: 'text',
    metadata,
  };

  if (Object.prototype.hasOwnProperty.call(raw, 'text')) {
    part.type = 'text';
    part.content = rawString(raw.text);
    return part;
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'reasoning')) {
    part.type = 'reasoning';
    part.content = rawString(raw.reasoning);
    return part;
  }
  if (
    Object.prototype.hasOwnProperty.call(raw, 'toolCallId')
    && Object.prototype.hasOwnProperty.call(raw, 'toolName')
    && Object.prototype.hasOwnProperty.call(raw, 'input')
  ) {
    part.type = 'tool';
    part.toolCallId = rawString(raw.toolCallId);
    part.name = rawString(raw.toolName);
    part.input = rawString(raw.input);
    part.output = [];
    for (const outputPartRaw of asArray(raw.output)) {
      const outputPart = asMap(outputPartRaw);
      if (Object.prototype.hasOwnProperty.call(outputPart, 'text')) {
        part.output.push({
          type: 'text',
          content: rawString(outputPart.text),
        });
      }
    }
    return part;
  }

  if (Object.prototype.hasOwnProperty.call(raw, 'fileName') && Object.prototype.hasOwnProperty.call(raw, 'url')) {
    part.type = 'document';
    part.name = rawString(raw.fileName);
    part.mimeType = rawString(raw.mime);
    mapPartUrlFile(part, rawString(raw.url), filesByRel);
    return part;
  }

  if (Object.prototype.hasOwnProperty.call(raw, 'url')) {
    const url = rawString(raw.url);
    part.type = inferMediaType(url, typeString);
    mapPartUrlFile(part, url, filesByRel);
    return part;
  }

  part.type = 'text';
  part.content = '[unsupported rikka part]';
  metadata.raw = raw;
  return part;
}

function mapPartUrlFile(part: IRPart, url: string, filesByRel: Map<string, IRFile>): void {
  if (!url) {
    return;
  }
  part.mediaUrl = url;
  if (!url.startsWith('file://')) {
    return;
  }
  const fileName = fileNameFromUrl(url);
  if (!fileName) {
    return;
  }
  const rel = `upload/${fileName}`;
  const file = filesByRel.get(rel);
  if (!file) {
    return;
  }

  part.fileId = file.id;
  if (!part.name) {
    part.name = file.name;
  }
  if (!part.mimeType) {
    part.mimeType = file.mimeType;
  }
}

function inferMediaType(url: string, typeField: string): IRPart['type'] {
  const lowerType = typeField.toLowerCase();
  if (lowerType.includes('.video')) return 'video';
  if (lowerType.includes('.audio')) return 'audio';
  if (lowerType.includes('.image')) return 'image';
  const ext = extFromFileName(url).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) return 'image';
  if (['.mp4', '.mov', '.mkv', '.webm'].includes(ext)) return 'video';
  if (['.mp3', '.wav', '.m4a', '.aac', '.ogg'].includes(ext)) return 'audio';
  return 'document';
}

function materializeFiles(
  db: Database,
  outputEntries: ArchiveEntries,
  files: IRFile[],
  filePathById: Record<string, string>,
  idMap: Record<string, string>,
): string[] {
  const warnings: string[] = [];
  const usedRelPath = new Set<string>();

  for (const file of files) {
    let fileId = pickFirstString(file.id, newId());
    const ext = pickFirstString(file.ext, extFromFileName(file.name));

    let relPath = preferredRikkaRelPath(file, ext);
    if (usedRelPath.has(relPath)) {
      relPath = `upload/${newId()}${ext}`;
    }
    usedRelPath.add(relPath);

    const fileName = relPath.split('/').at(-1) ?? `${newId()}${ext}`;
    const payload = file.bytes ?? new Uint8Array();
    if (!file.bytes) {
      warnings.push(`file ${fileId} missing source payload; created empty placeholder`);
    }

    outputEntries.set(relPath, payload);

    const createdAt = parseMillisOrNow(file.createdAt);
    const updatedAt = parseMillisOrNow(file.updatedAt);
    const mime = pickFirstString(file.mimeType, 'application/octet-stream');
    const displayName = pickFirstString(file.name, fileName);
    const sizeBytes = numberOrUndefined(file.size) ?? payload.byteLength;

    db.run(
      'INSERT INTO managed_files (folder, relative_path, display_name, mime_type, size_bytes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['upload', relPath, displayName, mime, sizeBytes, createdAt, updatedAt],
    );

    filePathById[fileId] = absRikkaUploadPath(fileName);
    idMap[`file:${file.id}`] = relPath;
  }

  return dedupeStrings(warnings);
}

function writeConversations(
  db: Database,
  conversations: IRConversation[],
  filePathById: Record<string, string>,
  idMap: Record<string, string>,
  resolveAssistantId: (candidate: string) => string,
  flattenToolCalls: boolean,
): string[] {
  const warnings: string[] = [];

  for (const conversation of conversations) {
    const convId = ensureUuid(asString(conversation.id), `conversation:${pickFirstString(conversation.id, conversation.title)}`);
    idMap[`topic:${conversation.id}`] = convId;

    db.run(
      'INSERT INTO ConversationEntity (id, assistant_id, title, nodes, create_at, update_at, truncate_index, suggestions, is_pinned) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        convId,
        resolveAssistantId(asString(conversation.assistantId)),
        deriveRikkaConversationTitle(conversation),
        '[]',
        parseTimeMillis(conversation.createdAt),
        parseTimeMillis(conversation.updatedAt),
        -1,
        '[]',
        0,
      ],
    );

    conversation.messages.forEach((message, index) => {
      for (const part of message.parts) {
        if (!part.fileId) continue;
        if (!filePathById[part.fileId]) {
          warnings.push(`conversation ${convId} message ${message.id} references missing file ${part.fileId}`);
        }
      }

      const nodeId = newId();
      const serializedMessage = rikkaMessageFromIR(message, filePathById, flattenToolCalls);
      db.run(
        'INSERT INTO message_node (id, conversation_id, node_index, messages, select_index) VALUES (?, ?, ?, ?, ?)',
        [nodeId, convId, index, marshalGoJSON([serializedMessage]), 0],
      );
      idMap[`message:${message.id}`] = pickFirstString(serializedMessage.id);
    });
  }

  return dedupeStrings(warnings);
}

function deriveRikkaConversationTitle(conversation: IRConversation): string {
  const existing = normalizeConversationTitleText(conversation.title ?? '');
  if (existing) {
    return existing;
  }
  const fromUser = deriveTitleFromMessages(conversation.messages, true);
  if (fromUser) {
    return fromUser;
  }
  const fromAny = deriveTitleFromMessages(conversation.messages, false);
  if (fromAny) {
    return fromAny;
  }
  return 'Imported Conversation';
}

function deriveTitleFromMessages(messages: IRMessage[], preferUser: boolean): string {
  for (const message of messages) {
    if (preferUser && normalizeRikkaRole(message.role) !== 'user') {
      continue;
    }
    for (const part of message.parts) {
      if (part.type === 'text' || part.type === 'reasoning') {
        const title = normalizeConversationTitleText(part.content ?? '');
        if (title) return title;
      } else if (part.type === 'tool') {
        const byName = normalizeConversationTitleText(part.name ?? '');
        if (byName) return byName;
        const byContent = normalizeConversationTitleText(part.content ?? '');
        if (byContent) return byContent;
      } else if (part.type === 'document' || part.type === 'image' || part.type === 'video' || part.type === 'audio') {
        const title = normalizeConversationTitleText(part.name ?? '');
        if (title) return title;
      }
    }
  }
  return '';
}

function normalizeConversationTitleText(input: string): string {
  const normalized = input.trim().replace(/\s+/g, ' ');
  if (!normalized) {
    return '';
  }
  const chars = Array.from(normalized);
  const maxChars = 80;
  if (chars.length > maxChars) {
    return `${chars.slice(0, maxChars).join('').trim()}…`;
  }
  return normalized;
}

function rikkaMessageFromIR(
  message: IRMessage,
  filePathById: Record<string, string>,
  flattenToolCalls: boolean,
): Record<string, unknown> {
  const messageId = ensureUuid(asString(message.id), `message:${pickFirstString(message.id, message.role)}`);
  const toolIdSeen = new Map<string, number>();
  const parts = message.parts.map(
    (part, index) => rikkaPartFromIR(messageId, index, part, filePathById, toolIdSeen, flattenToolCalls),
  );
  if (parts.length === 0) {
    parts.push({
      type: 'me.rerere.ai.ui.UIMessagePart.Text',
      text: '',
    });
  }
  return {
    id: messageId,
    role: normalizeRikkaRole(message.role),
    parts,
    annotations: [],
  };
}

function rikkaPartFromIR(
  messageId: string,
  partIndex: number,
  part: IRPart,
  filePathById: Record<string, string>,
  toolIdSeen: Map<string, number>,
  flattenToolCalls: boolean,
): Record<string, unknown> {
  switch (part.type) {
    case 'reasoning':
      return {
        type: 'me.rerere.ai.ui.UIMessagePart.Reasoning',
        reasoning: part.content ?? '',
      };
    case 'tool':
      {
      if (flattenToolCalls) {
        return {
          type: 'me.rerere.ai.ui.UIMessagePart.Text',
          text: renderToolPartAsText(part),
        };
      }
      const toolCallId = uniqueToolCallId(
        asString(part.toolCallId),
        `tool-call:${messageId}:${pickFirstString(part.name, 'tool')}:${partIndex}`,
        toolIdSeen,
      );
      return {
        type: 'me.rerere.ai.ui.UIMessagePart.Tool',
        toolCallId,
        toolName: pickFirstString(part.name, 'tool'),
        input: pickFirstString(part.input, '{}'),
        output: (part.output ?? []).map((item) => ({
          type: 'me.rerere.ai.ui.UIMessagePart.Text',
          text: item.content ?? '',
        })),
      };
      }
    case 'image':
      return {
        type: 'me.rerere.ai.ui.UIMessagePart.Image',
        url: chooseMediaUrl(part, filePathById),
      };
    case 'video':
      return {
        type: 'me.rerere.ai.ui.UIMessagePart.Video',
        url: chooseMediaUrl(part, filePathById),
      };
    case 'audio':
      return {
        type: 'me.rerere.ai.ui.UIMessagePart.Audio',
        url: chooseMediaUrl(part, filePathById),
      };
    case 'document':
      return {
        type: 'me.rerere.ai.ui.UIMessagePart.Document',
        url: chooseMediaUrl(part, filePathById),
        fileName: pickFirstString(part.name, 'document'),
        mime: pickFirstString(part.mimeType, 'application/octet-stream'),
      };
    default:
      return {
        type: 'me.rerere.ai.ui.UIMessagePart.Text',
        text: part.content ?? '',
      };
  }
}

function renderToolPartAsText(part: IRPart): string {
  const name = pickFirstString(part.name, 'tool');
  const lines = [`[Tool Call] ${name}`];
  const input = pickFirstString(part.input).trim();
  if (input && input !== '{}') {
    lines.push(`Input: ${input}`);
  }
  const content = pickFirstString(part.content).trim();
  if (content) {
    lines.push(`Content: ${content}`);
  }
  const output = (part.output ?? [])
    .map((item) => pickFirstString(item.content).trim())
    .filter((text) => text.length > 0);
  if (output.length > 0) {
    lines.push(`Output: ${output.join('\n')}`);
  }
  return lines.join('\n');
}

function uniqueToolCallId(candidate: string, seed: string, seen: Map<string, number>): string {
  const base = ensureUuid(candidate, seed);
  if (!seen.has(base)) {
    seen.set(base, 1);
    return base;
  }

  let attempt = seen.get(base) ?? 1;
  while (true) {
    const alt = ensureUuid('', `${seed}#${attempt}`);
    if (!seen.has(alt)) {
      seen.set(base, attempt + 1);
      seen.set(alt, 1);
      return alt;
    }
    attempt += 1;
  }
}

function chooseMediaUrl(part: IRPart, filePathById: Record<string, string>): string {
  if (part.fileId && filePathById[part.fileId]) {
    return `file://${filePathById[part.fileId]}`;
  }
  if ((part.mediaUrl ?? '').startsWith('file://')) {
    return part.mediaUrl ?? '';
  }
  if (part.mediaUrl) {
    return part.mediaUrl;
  }
  return '';
}

function preferredRikkaRelPath(file: IRFile, ext: string): string {
  const metadata = asMap(file.metadata);
  const fromMeta = pickRelPath(metadata['rikka.relative_path']);
  if (fromMeta) {
    return fromMeta;
  }
  const fromSrc = pickRelPath(file.relativeSrc);
  if (fromSrc) {
    return fromSrc;
  }

  let stem = pickFirstString(file.id);
  if (!isSafeStem(stem)) {
    stem = newId();
  }
  return `upload/${stem}${ext}`;
}

function pickRelPath(value: unknown): string {
  const normalized = asString(value).replace(/\\/g, '/');
  if (!normalized) return '';
  if (normalized.startsWith('upload/')) {
    return normalized;
  }
  const base = normalized.split('/').at(-1) ?? '';
  if (!base || base === '.' || base === '/') {
    return '';
  }
  return `upload/${base}`;
}

function absRikkaUploadPath(fileName: string): string {
  return `/data/user/0/me.rerere.rikkahub/files/upload/${fileName}`;
}

function normalizeRikkaRole(role: string): string {
  const normalized = role.trim().toLowerCase();
  if (['user', 'assistant', 'system', 'tool'].includes(normalized)) {
    return normalized;
  }
  return 'assistant';
}

function parseTimeMillis(value?: string): number {
  if (!value) {
    return Date.now();
  }
  const millis = Date.parse(value);
  if (Number.isNaN(millis)) {
    return Date.now();
  }
  return millis;
}

function parseMillisOrNow(value?: string): number {
  if (!value) {
    return Date.now();
  }
  const millis = Date.parse(value);
  if (Number.isNaN(millis)) {
    return Date.now();
  }
  return millis;
}

function millisToIso(value: unknown): string {
  const millis = numberOrUndefined(value);
  if (millis === undefined) {
    return isoNow();
  }
  return new Date(millis).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function numberOrZero(value: unknown): number {
  const maybe = numberOrUndefined(value);
  if (maybe === undefined) return 0;
  return maybe;
}

function numberOrUndefined(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function extractRikkaUnsupportedSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ['modeInjections', 'lorebooks', 'memoryEntities', 'memories']) {
    if (Object.prototype.hasOwnProperty.call(settings, key) && isMeaningfulUnsupported(settings[key])) {
      out[key] = cloneAny(settings[key]);
    }
  }

  const assistantFields = ['modeInjectionIds', 'lorebookIds', 'enableMemory', 'useGlobalMemory', 'regexes', 'localTools'];
  const assistants: Record<string, unknown>[] = [];
  for (const assistantValue of asArray(settings.assistants)) {
    const assistant = asMap(assistantValue);
    const entry: Record<string, unknown> = {};
    const id = asString(assistant.id);
    const name = asString(assistant.name);
    if (id) {
      entry.id = id;
    }
    if (name) {
      entry.name = name;
    }
    for (const field of assistantFields) {
      if (Object.prototype.hasOwnProperty.call(assistant, field) && isMeaningfulUnsupported(assistant[field])) {
        entry[field] = cloneAny(assistant[field]);
      }
    }
    if (Object.keys(entry).length > 0) {
      assistants.push(entry);
    }
  }
  if (assistants.length > 0) {
    out.assistants = assistants;
  }
  return out;
}

function isMeaningfulUnsupported(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === 'string') {
    return value.trim() !== '';
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>).length > 0;
  }
  return true;
}

function createAssistantResolver(settings: Record<string, unknown>): (candidate: string) => string {
  const validAssistantIds = new Set<string>();
  let first = '';
  for (const assistantValue of asArray(settings.assistants)) {
    const assistant = asMap(assistantValue);
    const id = asString(assistant.id);
    if (!id || !uuidValidate(id)) continue;
    validAssistantIds.add(id);
    if (!first) first = id;
  }

  let fallback = asString(settings.assistantId);
  if (!fallback || !validAssistantIds.has(fallback)) {
    fallback = first || DEFAULT_ASSISTANT_ID;
  }

  return (candidate: string): string => {
    const normalized = candidate.trim();
    if (!normalized) {
      return fallback;
    }
    if (validAssistantIds.has(normalized)) {
      return normalized;
    }
    const deterministic = ensureUuid(normalized, `assistant:${normalized}`);
    if (validAssistantIds.has(deterministic)) {
      return deterministic;
    }
    return fallback;
  };
}

function ensureUuid(candidate: string, seed: string): string {
  const normalized = candidate.trim();
  if (normalized && uuidValidate(normalized)) {
    return normalized;
  }
  const finalSeed = seed.trim() || newId();
  return uuidv5(finalSeed, UUID_NAMESPACE_OID);
}

function fileNameFromUrl(url: string): string {
  const stripped = url.replace(/^file:\/\//, '');
  const base = stripped.split('/').filter(Boolean).at(-1) ?? '';
  if (base === '.' || base === '/') {
    return '';
  }
  return base;
}

function rawString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function toErr(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function queryRows(db: Database, sql: string, params: unknown[] = []): Array<Record<string, unknown>> {
  const statement = db.prepare(sql, params as never);
  const rows: Array<Record<string, unknown>> = [];
  try {
    while (statement.step()) {
      rows.push(statement.getAsObject());
    }
  } finally {
    statement.free();
  }
  return rows;
}

function tableExists(db: Database, tableName: string): boolean {
  const rows = queryRows(
    db,
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`,
    [tableName],
  );
  return rows.length > 0;
}

async function resolveIdentityHash(entries: ArchiveEntries): Promise<string> {
  const bytes = entries.get('rikka_hub.db');
  if (!bytes || bytes.length === 0) {
    return DEFAULT_IDENTITY_HASH;
  }
  let db: Database | null = null;
  try {
    db = await openDatabase(bytes);
    const rows = queryRows(db, 'SELECT identity_hash FROM room_master_table WHERE id = 42');
    const hash = pickFirstString(rows[0]?.identity_hash);
    if (!hash) {
      return DEFAULT_IDENTITY_HASH;
    }
    return hash;
  } catch {
    return DEFAULT_IDENTITY_HASH;
  } finally {
    db?.close();
  }
}
