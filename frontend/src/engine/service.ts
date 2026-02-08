import { detectFormat } from './backup/format';
import { readZipBlob, writeJsonEntry, writeZipBlob } from './backup/zip';
import { parseCherry, buildCherry, hydrateCherryFileHashes } from './cherry/index';
import type { BackupIR, ConvertRequest, ConvertResult, DetectResult, Manifest, ProgressEvent } from './ir/types';
import { mergeSources, type ParsedSource } from './merge';
import { parseRikka, buildRikka } from './rikka/index';
import { dedupeStrings, nowIso } from './util/common';
import { sha256Hex } from './util/hash';
import { redactSecrets } from './util/redact';

export type ProgressSink = (event: ProgressEvent) => void;

export async function detectSource(inputFile: File): Promise<DetectResult> {
  const entries = await readZipBlob(inputFile);
  return detectFormat(entries);
}

export async function convert(request: ConvertRequest, pushProgress?: ProgressSink): Promise<ConvertResult> {
  const inputFiles = resolveInputFiles(request);
  if (inputFiles.length === 0) {
    throw new Error('no input file');
  }
  if (inputFiles.length > 1 && request.from !== 'auto') {
    throw new Error('multi-input convert only supports from=auto');
  }

  const parsedSources: ParsedSource[] = [];
  report(pushProgress, 'read', 4, 'Reading source zip files');
  for (let i = 0; i < inputFiles.length; i += 1) {
    const file = inputFiles[i];
    const stage = `parse_${i + 1}`;
    const sourceEntries = await readZipBlob(file);
    const detected = detectFormat(sourceEntries);
    if (detected.sourceFormat === 'unknown') {
      throw new Error(`cannot detect backup format: ${file.name}`);
    }
    if (request.from !== 'auto' && request.from !== detected.sourceFormat) {
      throw new Error(`source format mismatch: detected=${detected.sourceFormat}, selected=${request.from}`);
    }

    report(pushProgress, stage, 10 + Math.round((40 * i) / Math.max(1, inputFiles.length)), `Parsing ${file.name} (${detected.sourceFormat})`);
    let ir: BackupIR;
    if (detected.sourceFormat === 'cherry') {
      ir = parseCherry(sourceEntries);
    } else {
      ir = await parseRikka(sourceEntries);
    }
    ir.targetFormat = request.to;

    const sourceBytes = new Uint8Array(await file.arrayBuffer());
    parsedSources.push({
      index: i + 1,
      tag: `S${i + 1}`,
      name: file.name,
      format: detected.sourceFormat,
      hints: detected.hints,
      sourceSha256: await sha256Hex(sourceBytes),
      latestUnix: inferLatestUnix(ir),
      sourceBytes,
      ir,
    });
  }

  report(pushProgress, 'merge', 48, 'Merging sources');
  const { merged: ir, report: mergeReport } = mergeSources(parsedSources, {
    targetFormat: request.to,
    configPrecedence: request.configPrecedence,
    configSourceIndex: request.configSourceIndex,
  });

  if (request.redactSecrets) {
    ir.config = redactSecrets(ir.config) as Record<string, unknown>;
    if (ir.settings) {
      ir.settings = redactSecrets(ir.settings) as Record<string, unknown>;
    }
  }

  report(pushProgress, 'build', 58, `Building ${request.to} backup`);
  const outputEntries = new Map<string, Uint8Array>();
  const idMap: Record<string, string> = {};
  let warnings: string[] = [...ir.warnings];

  if (request.to === 'cherry') {
    warnings.push(...buildCherry(ir, outputEntries, idMap, request.redactSecrets));
  } else {
    warnings.push(...(await buildRikka(ir, outputEntries, idMap, request.redactSecrets)));
  }

  report(pushProgress, 'hash', 76, 'Calculating checksums');
  await hydrateCherryFileHashes(ir.files);
  const primaryIndex = Math.max(1, mergeReport.primarySourceIndex);
  const primarySource = parsedSources[primaryIndex - 1] ?? parsedSources[0];
  if (!primarySource) {
    throw new Error('missing merged primary source');
  }

  const manifest: Manifest = {
    schemaVersion: 1,
    sourceApp: primarySource.ir.sourceApp,
    sourceFormat: primarySource.format,
    sourceSha256: primarySource.sourceSha256,
    targetApp: request.to === 'cherry' ? 'cherry-studio' : 'rikkahub',
    targetFormat: request.to,
    idMap,
    redaction: request.redactSecrets,
    createdAt: nowIso(),
    sources: mergeReport.sources,
    warnings: dedupeStrings([...warnings, ...mergeReport.warnings]),
  };

  report(pushProgress, 'sidecar', 86, 'Writing sidecar');
  writeJsonEntry(outputEntries, 'cherrikka/manifest.json', manifest);
  outputEntries.set('cherrikka/raw/source.zip', primarySource.sourceBytes);
  for (const source of parsedSources) {
    outputEntries.set(`cherrikka/raw/source-${source.index}.zip`, source.sourceBytes);
  }

  report(pushProgress, 'pack', 94, 'Packing zip');
  const outputBlob = await writeZipBlob(outputEntries, request.to);

  if (manifest.warnings.length > 0) {
    report(pushProgress, 'warn', 97, `${manifest.warnings.length} warning(s) generated`, 'warning');
  }
  report(pushProgress, 'done', 100, 'Done');
  return {
    outputBlob,
    outputName: `converted-${request.to}-${parsedSources.length}src-${Date.now()}.zip`,
    manifest,
    warnings: manifest.warnings,
    errors: [],
  };
}

function resolveInputFiles(request: ConvertRequest): File[] {
  if (request.inputFiles && request.inputFiles.length > 0) {
    return request.inputFiles.filter((item) => item != null);
  }
  if (request.inputFile) return [request.inputFile];
  return [];
}

function inferLatestUnix(ir: BackupIR): number {
  let best = 0;
  const pushTime = (value: string): void => {
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) return;
    if (parsed > best) best = parsed;
  };
  for (const conversation of ir.conversations) {
    pushTime(conversation.updatedAt);
    pushTime(conversation.createdAt);
    for (const message of conversation.messages) {
      pushTime(message.createdAt);
    }
  }
  if (best > 0) return best;
  return Date.now();
}

function report(
  pushProgress: ProgressSink | undefined,
  stage: string,
  progress: number,
  message: string,
  level: ProgressEvent['level'] = 'info',
): void {
  pushProgress?.({ stage, progress, message, level });
}
