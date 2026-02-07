import { readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

import { convert } from '../src/engine/service';
import type { SourceFormat, TargetFormat } from '../src/engine/ir/types';

interface CliArgs {
  input: string;
  output: string;
  from: SourceFormat;
  to: TargetFormat;
  redactSecrets: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    input: '',
    output: '',
    from: 'auto',
    to: 'rikka',
    redactSecrets: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--input':
        out.input = argv[i + 1] ?? '';
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
      default:
        break;
    }
  }

  if (!out.input || !out.output) {
    throw new Error('usage: convert_with_engine.ts --input <src.zip> --output <dst.zip> --from auto|cherry|rikka --to cherry|rikka [--redact-secrets]');
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = resolve(args.input);
  const outputPath = resolve(args.output);
  const bytes = await readFile(inputPath);
  const file = new File([bytes], basename(inputPath), { type: 'application/zip' });

  const result = await convert(
    {
      inputFile: file,
      from: args.from,
      to: args.to,
      redactSecrets: args.redactSecrets,
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
