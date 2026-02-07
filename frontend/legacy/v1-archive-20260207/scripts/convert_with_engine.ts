#!/usr/bin/env -S npx vite-node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { convert } from '../src/engine/service';

interface CliArgs {
  input: string;
  output: string;
  from: 'auto' | 'cherry' | 'rikka';
  to: 'cherry' | 'rikka';
  template?: string;
  redactSecrets: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args = new Map<string, string | boolean>();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--redact-secrets') {
      args.set('redact-secrets', true);
      continue;
    }
    if (!token.startsWith('--')) {
      throw new Error(`unknown argument: ${token}`);
    }
    const key = token.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`missing value for --${key}`);
    }
    args.set(key, value);
    i += 1;
  }

  const input = String(args.get('input') ?? '');
  const output = String(args.get('output') ?? '');
  const from = String(args.get('from') ?? 'auto') as CliArgs['from'];
  const to = String(args.get('to') ?? '') as CliArgs['to'];
  const template = args.get('template') ? String(args.get('template')) : undefined;
  const redactSecrets = Boolean(args.get('redact-secrets'));

  if (!input) {
    throw new Error('missing required flag: --input <path>');
  }
  if (!output) {
    throw new Error('missing required flag: --output <path>');
  }
  if (from !== 'auto' && from !== 'cherry' && from !== 'rikka') {
    throw new Error(`invalid --from value: ${from}`);
  }
  if (to !== 'cherry' && to !== 'rikka') {
    throw new Error(`invalid --to value: ${to}`);
  }

  return {
    input,
    output,
    from,
    to,
    template,
    redactSecrets,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const inputBytes = await readFile(args.input);
  const inputFile = new File([inputBytes], path.basename(args.input), { type: 'application/zip' });

  let templateFile: File | undefined;
  if (args.template) {
    const templateBytes = await readFile(args.template);
    templateFile = new File([templateBytes], path.basename(args.template), { type: 'application/zip' });
  }

  const result = await convert({
    inputFile,
    from: args.from,
    to: args.to,
    templateFile,
    redactSecrets: args.redactSecrets,
  });

  await mkdir(path.dirname(args.output), { recursive: true });
  const outputBytes = new Uint8Array(await result.outputBlob.arrayBuffer());
  await writeFile(args.output, outputBytes);

  process.stdout.write(
    `${JSON.stringify(
      {
        output: args.output,
        targetFormat: result.manifest.targetFormat,
        warnings: result.manifest.warnings.length,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`convert_with_engine failed: ${String(error)}\n`);
  process.exit(1);
});
