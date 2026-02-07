export function extname(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx) : '';
}

export function basename(path: string): string {
  const normalized = path.replaceAll('\\\\', '/');
  const idx = normalized.lastIndexOf('/');
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}

export function normalizePath(path: string): string {
  return path.replaceAll('\\\\', '/').replace(/^\/+/, '');
}

export function guessLogicalType(mime: string, ext: string): string {
  const m = mime.toLowerCase();
  const e = ext.toLowerCase();
  if (m.startsWith('image/') || ['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(e)) return 'image';
  if (m.startsWith('video/') || ['.mp4', '.mov', '.mkv', '.webm'].includes(e)) return 'video';
  if (m.startsWith('audio/') || ['.mp3', '.wav', '.m4a', '.aac', '.ogg'].includes(e)) return 'audio';
  if (m.startsWith('text/') || ['.txt', '.md', '.csv', '.json'].includes(e)) return 'text';
  return 'document';
}

export function ensureOpenAIBaseUrl(url: string): string {
  const clean = url.trim();
  if (!clean) return clean;
  if (/\/v\d+\/?$/i.test(clean)) return clean.replace(/\/$/, '');
  return `${clean.replace(/\/$/, '')}/v1`;
}
