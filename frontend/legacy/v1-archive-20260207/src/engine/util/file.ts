export function inferLogicalType(mimeType: string, ext: string): string {
  const mime = mimeType.trim().toLowerCase();
  const suffix = ext.trim().toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('text/')) return 'text';
  switch (suffix) {
    case '.png':
    case '.jpg':
    case '.jpeg':
    case '.gif':
    case '.webp':
      return 'image';
    case '.mp4':
    case '.mov':
    case '.mkv':
    case '.webm':
      return 'video';
    case '.mp3':
    case '.wav':
    case '.m4a':
    case '.aac':
    case '.ogg':
      return 'audio';
    case '.txt':
    case '.md':
    case '.csv':
      return 'text';
    default:
      return 'document';
  }
}

export function extFromFileName(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx) : '';
}

export function isSafeStem(stem: string): boolean {
  if (!stem.trim()) return false;
  for (const ch of stem) {
    const code = ch.charCodeAt(0);
    const isLower = code >= 97 && code <= 122;
    const isUpper = code >= 65 && code <= 90;
    const isDigit = code >= 48 && code <= 57;
    if (!isLower && !isUpper && !isDigit && ch !== '-' && ch !== '_') {
      return false;
    }
  }
  return true;
}
