import { describe, expect, it } from 'vitest';
import { detectFormat } from '../../src/engine/backup/format';

describe('detectFormat', () => {
  it('detects cherry backups', () => {
    const entries = new Map<string, Uint8Array>([
      ['data.json', new Uint8Array([1])],
      ['Data/Files/a.txt', new Uint8Array([2])],
    ]);

    const result = detectFormat(entries);
    expect(result.format).toBe('cherry');
    expect(result.hints).toContain('data.json');
    expect(result.hints).toContain('Data/');
  });

  it('detects rikka backups', () => {
    const entries = new Map<string, Uint8Array>([
      ['settings.json', new Uint8Array([1])],
      ['rikka_hub.db', new Uint8Array([2])],
      ['upload/a.txt', new Uint8Array([3])],
    ]);

    const result = detectFormat(entries);
    expect(result.format).toBe('rikka');
    expect(result.hints).toContain('settings.json');
    expect(result.hints).toContain('rikka_hub.db');
  });

  it('falls back to unknown', () => {
    const entries = new Map<string, Uint8Array>([
      ['foo.txt', new Uint8Array([1])],
    ]);

    const result = detectFormat(entries);
    expect(result.format).toBe('unknown');
  });
});
