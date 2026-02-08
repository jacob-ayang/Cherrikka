import { readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

import { convert } from '../src/engine/service';
import type { SourceFormat, TargetFormat } from '../src/engine/ir/types';

interface CliArgs {
  inputs: string[];
  output: string;
  from: SourceFormat;
  to: TargetFormat;
  redactSecrets: boolean;
  configPrecedence: 'latest' | 'first' | 'target' | 'source';
  configSourceIndex?: number;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    inputs: [],
    output: '',
    from: 'auto',
    to: 'rikka',
    redactSecrets: false,
    configPrecedence: 'latest',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--input':
        if (argv[i + 1]) out.inputs.push(argv[i + 1]);
        i += 1;
        break;
      case '--output':
        out.output = argv[i + 1] ?? '';
        i += 1;
        break;
      case '--from':
        out.from = (argv[i + 1] ?? 'auto') as SourceFormat;
        i += 1;
        break;
      case '--to':
        out.to = (argv[i + 1] ?? 'rikka') as TargetFormat;
        i += 1;
        break;
      case '--redact-secrets':
        out.redactSecrets = true;
        break;
      case '--config-precedence':
        out.configPrecedence = ((argv[i + 1] ?? 'latest').trim().toLowerCase() as CliArgs['configPrecedence']) || 'latest';
        i += 1;
        break;
      case '--config-source-index':
        out.configSourceIndex = Number(argv[i + 1] ?? '0');
        i += 1;
        break;
      default:
        break;
    }
  }

  if (out.inputs.length === 0 || !out.output) {
    throw new Error('usage: convert_with_engine.ts --input <src.zip> [--input <src2.zip> ...] --output <dst.zip> --from auto|cherry|rikka --to cherry|rikka [--redact-secrets] [--config-precedence latest|first|target|source] [--config-source-index <n>]');
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const outputPath = resolve(args.output);
  const files: File[] = [];
  for (const input of args.inputs) {
    const inputPath = resolve(input);
    const bytes = await readFile(inputPath);
    files.push(new File([bytes], basename(inputPath), { type: 'application/zip' }));
  }

  const result = await convert(
    {
      inputFiles: files,
      from: args.from,
      to: args.to,
      redactSecrets: args.redactSecrets,
      configPrecedence: args.configPrecedence,
      configSourceIndex: args.configSourceIndex,
    },
    () => {
      // Intentionally no-op for script use.
    },
  );

  const outputBytes = new Uint8Array(await result.outputBlob.arrayBuffer());
  await writeFile(outputPath, outputBytes);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
