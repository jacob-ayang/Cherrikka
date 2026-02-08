import type { BackupFormat, BackupIR, ConfigPrecedence, IRAssistant, IRConversation, IRFile, IRMessage, IRPart, ManifestSource, TargetFormat } from './ir/types';
import { asArray, asRecord, asString, cloneJson, dedupeStrings } from './util/common';
import { basename, extname, normalizePath } from './util/file';
import { ensureUUID } from './util/id';

export interface ParsedSource {
  index: number;
  tag: string;
  name: string;
  format: BackupFormat;
  hints: string[];
  sourceSha256: string;
  latestUnix: number;
  sourceBytes: Uint8Array;
  ir: BackupIR;
}

export interface MergeOptions {
  targetFormat: TargetFormat;
  configPrecedence?: ConfigPrecedence;
  configSourceIndex?: number;
}

export interface MergeReport {
  primarySourceIndex: number;
  sources: ManifestSource[];
  warnings: string[];
}

export function mergeSources(sources: ParsedSource[], opts: MergeOptions): { merged: BackupIR; report: MergeReport } {
  if (sources.length === 0) {
    throw new Error('no input sources');
  }
  const primaryIndex = choosePrimarySourceIndex(sources, opts);
  const report: MergeReport = {
    primarySourceIndex: primaryIndex + 1,
    sources: sources.map((source) => ({
      index: source.index,
      name: source.name,
      sourceApp: source.ir.sourceApp,
      sourceFormat: source.format,
      sourceSha256: source.sourceSha256,
      hints: [...source.hints],
    })),
    warnings: [],
  };

  if (sources.length === 1) {
    return { merged: sources[0].ir, report };
  }

  const primary = sources[primaryIndex];
  const merged: BackupIR = {
    sourceApp: primary.ir.sourceApp,
    sourceFormat: primary.ir.sourceFormat,
    targetFormat: opts.targetFormat,
    assistants: [],
    conversations: [],
    files: [],
    config: cloneRecord(primary.ir.config),
    settings: mergeSettingsFromSources(sources, primaryIndex),
    opaque: {},
    warnings: [],
  };

  const warnings: string[] = [`multi-source-merge:count=${sources.length}`];
  const assistantIdMap = new Map<number, Map<string, string>>();
  const defaultAssistantBySource = new Map<number, string>();
  const usedAssistantNames = new Set<string>();
  const usedAssistantIds = new Set<string>();

  for (const source of sources) {
    const sourceMap = new Map<string, string>();
    assistantIdMap.set(source.index, sourceMap);
    for (const assistant of source.ir.assistants) {
      const clone = cloneAssistant(assistant);
      const oldId = clone.id.trim() || ensureUUID('', `merge:${source.tag}:assistant:missing:${clone.name}`);
      let newId = ensureUUID('', `merge:${source.tag}:assistant:${oldId}:${clone.name}`);
      if (usedAssistantIds.has(newId)) {
        newId = ensureUUID('', `merge:${source.tag}:assistant:${oldId}:${clone.name}:dup`);
      }
      usedAssistantIds.add(newId);
      sourceMap.set(oldId, newId);
      if (assistant.id.trim()) sourceMap.set(assistant.id.trim(), newId);
      clone.id = newId;

      const originalName = clone.name.trim() || 'Imported Assistant';
      clone.name = originalName;
      if (usedAssistantNames.has(originalName.toLowerCase())) {
        clone.name = uniqueAssistantName(originalName, source.tag, usedAssistantNames);
        warnings.push(`merge-assistant-renamed:${originalName}:${clone.name}`);
      } else {
        usedAssistantNames.add(originalName.toLowerCase());
      }
      merged.assistants.push(clone);
      if (!defaultAssistantBySource.has(source.index)) {
        defaultAssistantBySource.set(source.index, clone.id);
      }
    }
    warnings.push(...source.ir.warnings);
  }

  const fileIdMap = new Map<number, Map<string, string>>();
  const usedRikkaPaths = new Set<string>();
  const usedCherryStems = new Set<string>();

  for (const source of sources) {
    const sourceMap = new Map<string, string>();
    fileIdMap.set(source.index, sourceMap);
    for (const file of source.ir.files) {
      const clone = cloneFile(file);
      const oldId = clone.id.trim() || ensureUUID('', `merge:${source.tag}:file:missing:${clone.name}`);
      const newId = ensureUUID('', `merge:${source.tag}:file:${oldId}:${clone.name}:${clone.hashSha256}`);
      sourceMap.set(oldId, newId);
      clone.id = newId;
      clone.metadata = cloneRecord(clone.metadata);
      clone.metadata.mergeSource = source.tag;

      if (opts.targetFormat === 'rikka') {
        const preferred = normalizeRikkaRelativePath(clone);
        let unique = preferred;
        if (usedRikkaPaths.has(unique)) {
          unique = `upload/${deterministicFileName(`${newId}-collision`, clone.ext)}`;
          warnings.push(`merge-file-path-collision:${preferred}:${unique}`);
        }
        usedRikkaPaths.add(unique);
        clone.relativeSrc = unique;
        clone.metadata['rikka.relative_path'] = unique;
      } else {
        const stem = normalizeCherryStem(clone) || deterministicFileName(newId, '').replace(/\..*$/, '');
        let unique = stem;
        if (usedCherryStems.has(unique.toLowerCase())) {
          unique = deterministicFileName(`${newId}-collision`, '').replace(/\..*$/, '');
          warnings.push(`merge-file-path-collision:${stem}:${unique}`);
        }
        usedCherryStems.add(unique.toLowerCase());
        clone.metadata.cherry_id = unique;
      }
      merged.files.push(clone);
    }
  }

  const usedConversationIds = new Set<string>();
  for (const source of sources) {
    const sourceAssistantMap = assistantIdMap.get(source.index) ?? new Map<string, string>();
    const sourceFileMap = fileIdMap.get(source.index) ?? new Map<string, string>();
    for (const conversation of source.ir.conversations) {
      const clone = cloneConversation(conversation);
      const oldConvId = clone.id.trim() || ensureUUID('', `merge:${source.tag}:conversation:missing:${clone.title}`);
      let newConvId = ensureUUID('', `merge:${source.tag}:conversation:${oldConvId}:${clone.title}`);
      if (usedConversationIds.has(newConvId)) {
        newConvId = ensureUUID('', `merge:${source.tag}:conversation:${oldConvId}:${clone.title}:dup`);
      }
      usedConversationIds.add(newConvId);
      clone.id = newConvId;

      const mappedAssistantId = sourceAssistantMap.get(conversation.assistantId.trim() || '');
      if (mappedAssistantId) {
        clone.assistantId = mappedAssistantId;
      } else {
        const fallback = defaultAssistantBySource.get(source.index) || merged.assistants[0]?.id || '';
        if (fallback) {
          clone.assistantId = fallback;
          warnings.push(`merge-conversation-rebound:${source.tag}:${oldConvId}`);
        }
      }

      clone.messages = clone.messages.map((message, idx) => {
        const msg = cloneMessage(message);
        const oldMsgId = msg.id.trim() || ensureUUID('', `merge:${source.tag}:conversation:${oldConvId}:message:${idx}`);
        msg.id = ensureUUID('', `merge:${source.tag}:conversation:${oldConvId}:message:${oldMsgId}:${idx}`);
        msg.parts = remapPartFiles(msg.parts, sourceFileMap, warnings);
        return msg;
      });
      merged.conversations.push(clone);
    }
  }

  merged.settings = merged.settings ?? {};
  merged.settings['core.assistants'] = merged.assistants.map((assistant) => {
    const item: Record<string, unknown> = {
      id: assistant.id,
      name: assistant.name,
      systemPrompt: assistant.prompt,
    };
    const model = asRecord(assistant.model);
    if (asString(model.chatModelId) || asString(model.id) || asString(model.modelId)) {
      item.chatModelId = asString(model.chatModelId) || asString(model.id) || asString(model.modelId);
    }
    return item;
  });
  const selection = asRecord(merged.settings['core.selection']);
  const primaryAssistant = defaultAssistantBySource.get(primary.index);
  if (primaryAssistant) selection.assistantId = primaryAssistant;
  merged.settings['core.selection'] = selection;

  const sourceOpaque: Record<string, unknown> = {};
  for (const source of sources) {
    sourceOpaque[source.tag] = {
      sourceApp: source.ir.sourceApp,
      sourceFormat: source.ir.sourceFormat,
      opaque: cloneRecord(source.ir.opaque),
    };
  }
  merged.opaque = {
    ...merged.opaque,
    'opaque.merge.sources': sourceOpaque,
  };
  merged.warnings = dedupeStrings([...merged.warnings, ...warnings]);
  report.warnings = dedupeStrings(warnings);
  return { merged, report };
}

function choosePrimarySourceIndex(sources: ParsedSource[], opts: MergeOptions): number {
  const mode = (opts.configPrecedence ?? 'latest').trim().toLowerCase() as ConfigPrecedence | '';
  if (!mode || mode === 'latest') {
    let best = 0;
    for (let i = 1; i < sources.length; i += 1) {
      if (sources[i].latestUnix > sources[best].latestUnix) best = i;
    }
    return best;
  }
  if (mode === 'first') return 0;
  if (mode === 'target') {
    const idx = sources.findIndex((source) => source.format === opts.targetFormat);
    return idx >= 0 ? idx : choosePrimarySourceIndex(sources, { ...opts, configPrecedence: 'latest' });
  }
  if (mode === 'source') {
    const sourceIdx = Number(opts.configSourceIndex ?? 0);
    if (sourceIdx >= 1 && sourceIdx <= sources.length) return sourceIdx - 1;
  }
  return choosePrimarySourceIndex(sources, { ...opts, configPrecedence: 'latest' });
}

function mergeSettingsFromSources(sources: ParsedSource[], primary: number): Record<string, unknown> {
  const out = cloneRecord(sources[primary].ir.settings);
  for (let i = 0; i < sources.length; i += 1) {
    if (i === primary) continue;
    const settings = asRecord(sources[i].ir.settings);
    appendUniqueBySignature(out, 'core.providers', asArray(settings['core.providers']));
    appendUniqueBySignature(out, 'core.assistants', asArray(settings['core.assistants']));
    appendUniqueBySignature(out, 'raw.unsupported', asArray(settings['raw.unsupported']));
    mergeMissingRecord(out, 'raw.cherry', asRecord(settings['raw.cherry']));
    mergeMissingRecord(out, 'raw.rikka', asRecord(settings['raw.rikka']));
  }
  return out;
}

function appendUniqueBySignature(target: Record<string, unknown>, key: string, items: unknown[]): void {
  const current = asArray(target[key]);
  const seen = new Set<string>(current.map((item) => JSON.stringify(item)));
  for (const item of items) {
    const sig = JSON.stringify(item);
    if (seen.has(sig)) continue;
    seen.add(sig);
    current.push(cloneJson(item));
  }
  target[key] = current;
}

function mergeMissingRecord(target: Record<string, unknown>, key: string, incoming: Record<string, unknown>): void {
  if (Object.keys(incoming).length === 0) return;
  const base = asRecord(target[key]);
  for (const [k, v] of Object.entries(incoming)) {
    if (k in base) continue;
    base[k] = cloneJson(v);
  }
  target[key] = base;
}

function remapPartFiles(parts: IRPart[], fileMap: Map<string, string>, warnings: string[]): IRPart[] {
  return parts.map((part) => {
    const clone = clonePart(part);
    if (clone.fileId?.trim()) {
      const mapped = fileMap.get(clone.fileId.trim());
      if (mapped) {
        clone.fileId = mapped;
      } else {
        warnings.push(`merge-file-reference-missing:${clone.fileId.trim()}`);
      }
    }
    if (clone.output && clone.output.length > 0) {
      clone.output = remapPartFiles(clone.output, fileMap, warnings);
    }
    return clone;
  });
}

function normalizeRikkaRelativePath(file: IRFile): string {
  const metadata = asRecord(file.metadata);
  const candidates = [asString(metadata['rikka.relative_path']), asString(file.relativeSrc)];
  for (const candidateRaw of candidates) {
    const candidate = normalizePath(candidateRaw || '');
    if (!candidate) continue;
    if (candidate.startsWith('upload/')) return candidate;
    const base = basename(candidate);
    if (base) return `upload/${base}`;
  }
  const baseName = basename(file.name || `${file.id}${file.ext || ''}`) || deterministicFileName(file.id, file.ext);
  return `upload/${baseName}`;
}

function normalizeCherryStem(file: IRFile): string {
  const metadata = asRecord(file.metadata);
  const candidate = (asString(metadata.cherry_id) || file.id || '').replaceAll('-', '').replaceAll(' ', '_').trim();
  return candidate.replace(/^[_./]+|[_./]+$/g, '');
}

function deterministicFileName(seed: string, ext: string): string {
  const normalizedExt = ext && !ext.startsWith('.') ? `.${ext}` : ext;
  const stem = ensureUUID('', `merge:file:${seed}`).replaceAll('-', '');
  return `${stem}${normalizedExt || ''}`;
}

function uniqueAssistantName(baseName: string, tag: string, usedNames: Set<string>): string {
  let candidate = `${baseName} (${tag})`;
  if (!usedNames.has(candidate.toLowerCase())) {
    usedNames.add(candidate.toLowerCase());
    return candidate;
  }
  for (let i = 2; i < 10000; i += 1) {
    candidate = `${baseName} (${tag}-${i})`;
    if (usedNames.has(candidate.toLowerCase())) continue;
    usedNames.add(candidate.toLowerCase());
    return candidate;
  }
  return `${baseName} (${tag}-${Date.now()})`;
}

function cloneAssistant(assistant: IRAssistant): IRAssistant {
  return {
    ...assistant,
    model: cloneRecord(assistant.model),
    settings: cloneRecord(assistant.settings),
    opaque: cloneRecord(assistant.opaque),
  };
}

function cloneConversation(conversation: IRConversation): IRConversation {
  return {
    ...conversation,
    messages: conversation.messages.map((message) => cloneMessage(message)),
    opaque: cloneRecord(conversation.opaque),
  };
}

function cloneMessage(message: IRMessage): IRMessage {
  return {
    ...message,
    parts: message.parts.map((part) => clonePart(part)),
    opaque: cloneRecord(message.opaque),
  };
}

function clonePart(part: IRPart): IRPart {
  return {
    ...part,
    output: (part.output ?? []).map((item) => clonePart(item)),
    metadata: cloneRecord(part.metadata),
  };
}

function cloneFile(file: IRFile): IRFile {
  return {
    ...file,
    bytes: new Uint8Array(file.bytes),
    metadata: cloneRecord(file.metadata),
  };
}

function cloneRecord(value: unknown): Record<string, unknown> {
  return cloneJson(asRecord(value));
}
