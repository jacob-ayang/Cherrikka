import {
  BlobReader,
  BlobWriter,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipReader,
  ZipWriter,
} from '@zip.js/zip.js';
import { marshalGoJSON } from '../util/go_json';

export type ArchiveEntries = Map<string, Uint8Array>;

export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '').trim();
}

export function cloneEntries(entries: ArchiveEntries): ArchiveEntries {
  const out: ArchiveEntries = new Map();
  for (const [path, bytes] of entries.entries()) {
    out.set(path, new Uint8Array(bytes));
  }
  return out;
}

export async function readZipBlob(blob: Blob): Promise<ArchiveEntries> {
  const reader = new ZipReader(new BlobReader(blob));
  const entries = await reader.getEntries();
  const out: ArchiveEntries = new Map();

  for (const entry of entries) {
    if (entry.directory) {
      continue;
    }
    const path = normalizePath(entry.filename);
    if (!path) {
      continue;
    }
    const bytes = await entry.getData?.(new Uint8ArrayWriter());
    out.set(path, bytes ?? new Uint8Array());
  }

  await reader.close();
  return out;
}

export async function writeZipBlob(entries: ArchiveEntries): Promise<Blob> {
  const writer = new ZipWriter(new BlobWriter('application/zip'));
  const paths = Array.from(entries.keys()).sort((a, b) => a.localeCompare(b));
  for (const path of paths) {
    const normalized = normalizePath(path);
    if (!normalized) {
      continue;
    }
    const bytes = entries.get(path) ?? new Uint8Array();
    await writer.add(normalized, new Uint8ArrayReader(bytes));
  }
  return writer.close();
}

export function hasFile(entries: ArchiveEntries, path: string): boolean {
  return entries.has(normalizePath(path));
}

export function hasPrefix(entries: ArchiveEntries, prefix: string): boolean {
  const normalized = normalizePath(prefix);
  for (const path of entries.keys()) {
    if (path.startsWith(normalized.endsWith('/') ? normalized : normalized + '/')) {
      return true;
    }
  }
  return false;
}

export function readText(entries: ArchiveEntries, path: string): string | undefined {
  const bytes = entries.get(normalizePath(path));
  if (!bytes) return undefined;
  return new TextDecoder().decode(bytes);
}

export function readJson<T>(entries: ArchiveEntries, path: string): T | undefined {
  const text = readText(entries, path);
  if (!text) return undefined;
  return JSON.parse(text) as T;
}

export function writeText(entries: ArchiveEntries, path: string, text: string): void {
  entries.set(normalizePath(path), new TextEncoder().encode(text));
}

export function writeJson(entries: ArchiveEntries, path: string, value: unknown, pretty = false): void {
  writeText(entries, path, marshalGoJSON(value, pretty));
}

export function listByPrefix(entries: ArchiveEntries, prefix: string): string[] {
  const normalized = normalizePath(prefix);
  const full = normalized.endsWith('/') ? normalized : normalized + '/';
  return Array.from(entries.keys()).filter((path) => path.startsWith(full)).sort();
}

export function removeByPrefix(entries: ArchiveEntries, prefix: string): void {
  for (const path of listByPrefix(entries, prefix)) {
    entries.delete(path);
  }
}
