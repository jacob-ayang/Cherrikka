import { describe, expect, it } from 'vitest';
import { encodePersistSlicesForStorage } from '../../src/engine/cherry/index';

describe('encodePersistSlicesForStorage', () => {
  it('encodes outer and inner json using go-style serializer', () => {
    const encoded = encodePersistSlicesForStorage({
      llm: { z: 1, a: '<tag>' },
      settings: { b: true, a: 1 },
    });

    // Outer JSON is an object with sorted keys and string values.
    expect(encoded).toBe(
      '{"llm":"{\\"a\\":\\"\\\\u003ctag\\\\u003e\\",\\"z\\":1}","settings":"{\\"a\\":1,\\"b\\":true}"}',
    );

    const outer = JSON.parse(encoded) as Record<string, string>;
    expect(outer.llm).toBe('{"a":"\\u003ctag\\u003e","z":1}');
    expect(outer.settings).toBe('{"a":1,"b":true}');
  });
});
