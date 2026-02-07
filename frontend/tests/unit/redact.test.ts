import { describe, expect, it } from 'vitest';
import { redactAny, shouldRedactKey } from '../../src/engine/util/redact';

describe('redact', () => {
  it('detects secret keys by token', () => {
    expect(shouldRedactKey('apiKey')).toBe(true);
    expect(shouldRedactKey('secret_access_key')).toBe(true);
    expect(shouldRedactKey('displayName')).toBe(false);
  });

  it('redacts nested sensitive keys', () => {
    const input = {
      apiKey: 'abc',
      nested: {
        password: 'pwd',
        keep: 'x',
      },
    };

    const output = redactAny(input) as Record<string, unknown>;
    expect(output.apiKey).toBe('***REDACTED***');
    expect((output.nested as Record<string, unknown>).password).toBe('***REDACTED***');
    expect((output.nested as Record<string, unknown>).keep).toBe('x');
  });
});
