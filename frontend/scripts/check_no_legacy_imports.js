import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SRC_DIR = join(ROOT, 'src');
const blocked = ['legacy/', '/legacy/', 'frontend/legacy/'];
const offenders = [];

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full);
      continue;
    }
    if (!entry.isFile() || !/\.(ts|tsx|js|jsx)$/.test(entry.name)) {
      continue;
    }

    const text = await readFile(full, 'utf8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line.includes('import') && !line.includes('from')) continue;
      if (blocked.some((needle) => line.includes(needle))) {
        offenders.push(`${relative(ROOT, full)}:${i + 1}`);
      }
    }
  }
}

await walk(SRC_DIR);

if (offenders.length > 0) {
  console.error('Found blocked legacy imports:');
  for (const entry of offenders) {
    console.error(`- ${entry}`);
  }
  process.exit(1);
}

console.log('No legacy imports found under frontend/src.');
