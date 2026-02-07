import type { DetectResult } from '../ir/types';

export function detectFormat(entries: Map<string, Uint8Array>): DetectResult {
  const names = [...entries.keys()];
  const hasDataJson = names.includes('data.json');
  const hasDataDir = names.some((n) => n.startsWith('Data/'));
  const hasSettings = names.includes('settings.json');
  const hasDb = names.includes('rikka_hub.db');
  const hasUpload = names.some((n) => n.startsWith('upload/'));

  if (hasDataJson && hasDataDir) return { format: 'cherry', hints: ['data.json', 'Data/'] };
  if (hasSettings && hasDb) {
    const hints = ['settings.json', 'rikka_hub.db'];
    if (hasUpload) hints.push('upload/');
    return { format: 'rikka', hints };
  }
  return { format: 'unknown', hints: [] };
}
