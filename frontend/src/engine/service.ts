import { detectFormat } from './backup/format';
import { readZipBlob, writeJsonEntry, writeZipBlob } from './backup/zip';
import { parseCherry, buildCherry, hydrateCherryFileHashes } from './cherry/index';
import type { BackupIR, ConvertRequest, ConvertResult, DetectResult, Manifest, ProgressEvent } from './ir/types';
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
  report(pushProgress, 'read', 4, 'Reading source zip');
  const sourceEntries = await readZipBlob(request.inputFile);

  report(pushProgress, 'detect', 10, 'Detecting source format');
  const detected = detectFormat(sourceEntries);
  if (detected.sourceFormat === 'unknown') {
    throw new Error('cannot detect source backup format');
  }

  if (request.from !== 'auto' && request.from !== detected.sourceFormat) {
    throw new Error(`source format mismatch: detected=${detected.sourceFormat}, selected=${request.from}`);
  }

  report(pushProgress, 'parse', 24, `Parsing ${detected.sourceFormat} backup`);
  let ir: BackupIR;
  if (detected.sourceFormat === 'cherry') {
    ir = parseCherry(sourceEntries);
  } else {
    ir = await parseRikka(sourceEntries);
  }

  ir.targetFormat = request.to;

  if (request.redactSecrets) {
    ir.config = redactSecrets(ir.config) as Record<string, unknown>;
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
  const sourceBytes = new Uint8Array(await request.inputFile.arrayBuffer());
  const sourceSha = await sha256Hex(sourceBytes);

  const manifest: Manifest = {
    schemaVersion: 1,
    sourceApp: ir.sourceApp,
    sourceFormat: detected.sourceFormat,
    sourceSha256: sourceSha,
    targetApp: request.to === 'cherry' ? 'cherry-studio' : 'rikkahub',
    targetFormat: request.to,
    idMap,
    redaction: request.redactSecrets,
    createdAt: nowIso(),
    warnings: dedupeStrings(warnings),
  };

  report(pushProgress, 'sidecar', 86, 'Writing sidecar');
  writeJsonEntry(outputEntries, 'cherrikka/manifest.json', manifest);
  outputEntries.set('cherrikka/raw/source.zip', sourceBytes);

  report(pushProgress, 'pack', 94, 'Packing zip');
  const outputBlob = await writeZipBlob(outputEntries);

  if (manifest.warnings.length > 0) {
    report(pushProgress, 'warn', 97, `${manifest.warnings.length} warning(s) generated`, 'warning');
  }
  report(pushProgress, 'done', 100, 'Done');
  return {
    outputBlob,
    outputName: `converted-${request.to}-${Date.now()}.zip`,
    manifest,
    warnings: manifest.warnings,
    errors: [],
  };
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
