import { BlobReader, BlobWriter, TextReader, Uint8ArrayReader, Uint8ArrayWriter, ZipReader, ZipWriter } from '@zip.js/zip.js';
import { marshalGoJSON } from '../util/go_json';

export type ZipProfile = 'cherry' | 'rikka';

export async function readZipBlob(input: Blob): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  const reader = new ZipReader(new BlobReader(input));
  const entries = await reader.getEntries();
  for (const entry of entries) {
    if (!entry.filename || entry.directory) continue;
    const data = await entry.getData?.(new Uint8ArrayWriter());
    if (!data) continue;
    out.set(entry.filename, data);
  }
  await reader.close();
  return out;
}

function getZipProfileOptions(profile: ZipProfile): Record<string, unknown> {
  // Use store mode for both targets to maximize importer compatibility.
  // This intentionally prioritizes deterministic compatibility over compression ratio.
  return {
    msDosCompatible: true,
    versionMadeBy: 20,
    extendedTimestamp: false,
    useUnicodeFileNames: false,
    compressionMethod: 0,
    level: 0,
    dataDescriptor: false,
    dataDescriptorSignature: false,
  };
}

export async function writeZipBlob(entries: Map<string, Uint8Array>, profile: ZipProfile = 'cherry'): Promise<Blob> {
  const profileOptions = getZipProfileOptions(profile);
  const writer = new ZipWriter(new BlobWriter('application/zip'), {
    ...profileOptions,
    keepOrder: true,
  });
  const names = [...entries.keys()].sort();
  for (const name of names) {
    await writer.add(name, new Uint8ArrayReader(entries.get(name) ?? new Uint8Array()), {
      ...profileOptions,
    });
  }
  return writer.close();
}

export function readTextEntry(entries: Map<string, Uint8Array>, path: string): string | null {
  const raw = entries.get(path);
  if (!raw) return null;
  return new TextDecoder().decode(raw);
}

export function readJsonEntry<T>(entries: Map<string, Uint8Array>, path: string): T | null {
  const text = readTextEntry(entries, path);
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export function writeJsonEntry(entries: Map<string, Uint8Array>, path: string, value: unknown): void {
  const text = marshalGoJSON(value);
  entries.set(path, new TextEncoder().encode(text));
}

export async function textBlob(text: string): Promise<Blob> {
  const reader = new ZipReader(new TextReader(text));
  await reader.close();
  return new Blob([text]);
}
