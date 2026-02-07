export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const normalized = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? (bytes.buffer as ArrayBuffer)
    : (bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  const digest = await crypto.subtle.digest('SHA-256', normalized);
  const arr = Array.from(new Uint8Array(digest));
  return arr.map((v) => v.toString(16).padStart(2, '0')).join('');
}
