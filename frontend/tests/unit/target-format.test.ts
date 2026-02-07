import { describe, expect, it } from 'vitest';

import { resolveTargetFormat } from '../../src/lib/format';

describe('resolveTargetFormat', () => {
  it('maps explicit cherry -> rikka', () => {
    expect(resolveTargetFormat('cherry', 'unknown')).toBe('rikka');
  });

  it('maps explicit rikka -> cherry', () => {
    expect(resolveTargetFormat('rikka', 'unknown')).toBe('cherry');
  });

  it('maps auto by detected cherry', () => {
    expect(resolveTargetFormat('auto', 'cherry')).toBe('rikka');
  });

  it('maps auto by detected rikka', () => {
    expect(resolveTargetFormat('auto', 'rikka')).toBe('cherry');
  });

  it('returns null when auto unknown', () => {
    expect(resolveTargetFormat('auto', 'unknown')).toBeNull();
  });
});
