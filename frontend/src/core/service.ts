import { cloneEntries, readZipBlob, writeJson, writeZipBlob } from './backup/archive';
import { detectFormat } from './backup/format';
import { buildCherryArchiveFromIR, parseCherryArchive, seedCherryTemplate, validateCherryArchive } from './cherry/index';
import type {
  BackupIR,
  ConfigSummary,
  ConvertRequest,
  ConvertResult,
  FileSummary,
  InspectResult,
  Manifest,
  ProgressEvent,
  ValidateResult,
} from './ir/types';
import { ensureNormalizedSettings } from './mapping/settings';
import { buildRikkaArchiveFromIR, parseRikkaArchive, seedRikkaTemplate, validateRikkaArchive } from './rikka/index';
import { dedupeStrings, isoNow } from './util/common';
import { sha256Hex } from './util/hash';
import { redactAny } from './util/redact';

export type ProgressReporter = (event: ProgressEvent) => void;

export async function inspect(file: File, onProgress?: ProgressReporter): Promise<InspectResult> {
  report(onProgress, 'read', 5, 'Reading input zip');
  const entries = await readZipBlob(file);

  report(onProgress, 'detect', 15, 'Detecting backup format');
  const detected = detectFormat(entries);
  if (detected.format === 'unknown') {
    return {
      format: 'unknown',
      hints: detected.hints,
      conversations: 0,
      assistants: 0,
      files: 0,
      sourceApp: '',
      configSummary: {
        providers: 0,
        assistants: 0,
        hasWebdav: false,
        hasS3: false,
      },
      fileSummary: {
        total: 0,
        referenced: 0,
        orphan: 0,
        missing: 0,
      },
    };
  }

  report(onProgress, 'parse', 45, `Parsing ${detected.format} backup`);
  const ir = await parseByFormat(detected.format, entries);

  report(onProgress, 'summary', 90, 'Building summary');
  return {
    format: detected.format,
    hints: detected.hints,
    conversations: ir.conversations.length,
    assistants: ir.assistants.length,
    files: ir.files.length,
    sourceApp: ir.sourceApp,
    configSummary: summarizeConfig(ir),
    fileSummary: summarizeFiles(ir),
  };
}

export async function validate(file: File, onProgress?: ProgressReporter): Promise<ValidateResult> {
  report(onProgress, 'read', 5, 'Reading input zip');
  const entries = await readZipBlob(file);

  report(onProgress, 'detect', 15, 'Detecting backup format');
  const detected = detectFormat(entries);
  if (detected.format === 'unknown') {
    return {
      valid: false,
      format: 'unknown',
      issues: ['unknown backup format'],
      errors: ['unknown backup format'],
      warnings: [],
      configSummary: {
        providers: 0,
        assistants: 0,
        hasWebdav: false,
        hasS3: false,
      },
      fileSummary: {
        total: 0,
        referenced: 0,
        orphan: 0,
        missing: 0,
      },
    };
  }

  const errors: string[] = [];
  const warnings: string[] = [];

  report(onProgress, 'structure', 30, 'Running structural validation');
  if (detected.format === 'cherry') {
    const res = validateCherryArchive(entries);
    errors.push(...res.errors);
    warnings.push(...res.warnings);
  } else {
    const res = await validateRikkaArchive(entries);
    errors.push(...res.errors);
    warnings.push(...res.warnings);
  }

  report(onProgress, 'parse', 55, 'Parsing for semantic checks');
  let ir: BackupIR | null = null;
  try {
    ir = await parseByFormat(detected.format, entries);
    warnings.push(...ir.warnings);
    if (ir.conversations.length === 0) {
      errors.push('no conversations found');
    }
    const fileSummary = summarizeFiles(ir);
    if (fileSummary.missing > 0) {
      warnings.push(`found ${fileSummary.missing} missing file payload(s)`);
    }
  } catch (error) {
    errors.push(`parse failed: ${toErr(error)}`);
  }

  const dedupedErrors = dedupeStrings(errors);
  const dedupedWarnings = dedupeStrings(warnings);
  const issues = dedupeStrings([...dedupedErrors, ...dedupedWarnings]);

  report(onProgress, 'done', 100, 'Validation complete');
  return {
    valid: dedupedErrors.length === 0,
    format: detected.format,
    issues,
    errors: dedupedErrors,
    warnings: dedupedWarnings,
    configSummary: summarizeConfig(ir),
    fileSummary: summarizeFiles(ir),
  };
}

export async function convert(request: ConvertRequest, onProgress?: ProgressReporter): Promise<ConvertResult> {
  report(onProgress, 'read', 4, 'Reading source zip');
  const sourceEntries = await readZipBlob(request.inputFile);

  report(onProgress, 'detect', 12, 'Detecting source format');
  const detected = detectFormat(sourceEntries);
  if (detected.format === 'unknown') {
    throw new Error('cannot detect backup format');
  }

  if (request.from !== 'auto' && request.from !== detected.format) {
    throw new Error(`source format mismatch: detected=${detected.format} flag=${request.from}`);
  }

  report(onProgress, 'parse', 24, `Parsing ${detected.format} backup`);
  const sourceIr = await parseByFormat(detected.format, sourceEntries);
  sourceIr.targetFormat = request.to;
  sourceIr.detectedHints = detected.hints;
  sourceIr.warnings.push(...ensureNormalizedSettings(sourceIr));

  if (request.redactSecrets) {
    sourceIr.config = redactAny(sourceIr.config) as Record<string, unknown>;
    sourceIr.settings = redactAny(sourceIr.settings) as Record<string, unknown>;
  }

  let outputEntries = new Map<string, Uint8Array>();
  if (request.templateFile) {
    report(onProgress, 'template', 34, 'Reading template zip');
    outputEntries = cloneEntries(await readZipBlob(request.templateFile));
  }

  const idMap: Record<string, string> = {};
  let buildWarnings: string[] = [];

  if (request.to === 'cherry') {
    report(onProgress, 'build', 56, 'Building Cherry backup');
    seedCherryTemplate(outputEntries);
    buildWarnings = await buildCherryArchiveFromIR(sourceIr, outputEntries, request.redactSecrets, idMap);
  } else {
    report(onProgress, 'build', 56, 'Building Rikka backup');
    await seedRikkaTemplate(outputEntries);
    buildWarnings = await buildRikkaArchiveFromIR(sourceIr, outputEntries, request.redactSecrets, idMap);
  }

  report(onProgress, 'sidecar', 78, 'Writing sidecar metadata');
  const sourceBytes = new Uint8Array(await request.inputFile.arrayBuffer());
  const manifest: Manifest = {
    schemaVersion: 1,
    sourceApp: sourceIr.sourceApp,
    sourceFormat: detected.format,
    sourceSha256: await sha256Hex(sourceBytes),
    targetApp: request.to === 'cherry' ? 'cherry-studio' : 'rikkahub',
    targetFormat: request.to,
    idMap,
    redaction: request.redactSecrets,
    createdAt: isoNow(),
    warnings: dedupeStrings([...sourceIr.warnings, ...buildWarnings]),
  };

  writeJson(outputEntries, 'cherrikka/manifest.json', manifest, true);
  outputEntries.set('cherrikka/raw/source.zip', sourceBytes);

  report(onProgress, 'pack', 92, 'Packaging target zip');
  const outputBlob = await writeZipBlob(outputEntries);

  report(onProgress, 'done', 100, 'Convert complete');
  return {
    outputBlob,
    manifest,
  };
}

async function parseByFormat(format: 'cherry' | 'rikka', entries: Map<string, Uint8Array>): Promise<BackupIR> {
  if (format === 'cherry') {
    return parseCherryArchive(entries);
  }
  return parseRikkaArchive(entries);
}

function summarizeConfig(ir: BackupIR | null): ConfigSummary {
  if (!ir) {
    return {
      providers: 0,
      assistants: 0,
      hasWebdav: false,
      hasS3: false,
    };
  }
  if (Object.keys(ir.settings).length === 0) {
    ensureNormalizedSettings(ir);
  }
  return {
    providers: asArrayLen(ir.settings['core.providers']),
    assistants: asArrayLen(ir.settings['core.assistants']),
    hasWebdav: Object.keys(asObject(ir.settings['sync.webdav'])).length > 0,
    hasS3: Object.keys(asObject(ir.settings['sync.s3'])).length > 0,
  };
}

function summarizeFiles(ir: BackupIR | null): FileSummary {
  if (!ir) {
    return {
      total: 0,
      referenced: 0,
      orphan: 0,
      missing: 0,
    };
  }
  const referenced = referencedFileIds(ir);
  let orphan = 0;
  let missing = 0;
  for (const file of ir.files) {
    if (file.orphan) {
      orphan += 1;
    }
    if (file.missing || !file.bytes) {
      missing += 1;
    }
  }
  return {
    total: ir.files.length,
    referenced: referenced.size,
    orphan,
    missing,
  };
}

function referencedFileIds(ir: BackupIR): Set<string> {
  const result = new Set<string>();
  for (const conversation of ir.conversations) {
    for (const message of conversation.messages) {
      for (const part of message.parts) {
        if (part.fileId) {
          result.add(part.fileId);
        }
      }
    }
  }
  return result;
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function asArrayLen(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function report(onProgress: ProgressReporter | undefined, stage: string, progress: number, message: string): void {
  if (!onProgress) {
    return;
  }
  onProgress({ stage, progress, message });
}

function toErr(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
