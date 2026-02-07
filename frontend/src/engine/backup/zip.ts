import { BlobReader, BlobWriter, TextReader, Uint8ArrayReader, Uint8ArrayWriter, ZipReader, ZipWriter } from '@zip.js/zip.js';
import { marshalGoJSON } from '../util/go_json';

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

export async function writeZipBlob(entries: Map<string, Uint8Array>): Promise<Blob> {
  const writer = new ZipWriter(new BlobWriter('application/zip'), {
    // Match Go archive/zip compatibility profile as closely as possible.
    msDosCompatible: true,
    versionMadeBy: 20,
    // zip.js adds PKWARE NTFS extra fields when extended timestamps are on;
    // disabling avoids Android importer edge cases and aligns with CLI flags.
    extendedTimestamp: false,
    useUnicodeFileNames: false,
    // Go archive/zip writes signed streaming data descriptors (PK\x07\x08).
    // Some importers are stricter and may fail without the signature.
    dataDescriptorSignature: true,
    keepOrder: true,
  });
  const names = [...entries.keys()].sort();
  for (const name of names) {
    await writer.add(name, new Uint8ArrayReader(entries.get(name) ?? new Uint8Array()), {
      msDosCompatible: true,
      versionMadeBy: 20,
      extendedTimestamp: false,
      useUnicodeFileNames: false,
      dataDescriptorSignature: true,
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
