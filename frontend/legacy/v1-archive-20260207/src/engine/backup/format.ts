import type { DetectResult } from '../ir/types';
import type { ArchiveEntries } from './archive';
import { hasFile, hasPrefix } from './archive';

export function detectFormat(entries: ArchiveEntries): DetectResult {
  const hints: string[] = [];
  const hasDataJson = hasFile(entries, 'data.json');
  const hasDataDir = hasPrefix(entries, 'Data');
  const hasSettingsJson = hasFile(entries, 'settings.json');
  const hasRikkaDb = hasFile(entries, 'rikka_hub.db');
  const hasUploadDir = hasPrefix(entries, 'upload');

  if (hasDataJson) hints.push('data.json');
  if (hasDataDir) hints.push('Data/');
  if (hasSettingsJson) hints.push('settings.json');
  if (hasRikkaDb) hints.push('rikka_hub.db');
  if (hasUploadDir) hints.push('upload/');

  if (hasDataJson && hasDataDir) {
    return { format: 'cherry', hints };
  }
  if (hasSettingsJson && (hasRikkaDb || hasUploadDir)) {
    return { format: 'rikka', hints };
  }
  return { format: 'unknown', hints };
}
