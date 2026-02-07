import { describe, expect, it } from 'vitest';

import { marshalGoJSON } from '../../src/engine/util/go_json';

describe('marshalGoJSON', () => {
  it('sorts object keys recursively', () => {
    const text = marshalGoJSON({
      b: 1,
      a: {
        d: 2,
        c: 3,
      },
    });
    expect(text).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('escapes html-sensitive characters like Go encoding/json', () => {
    const text = marshalGoJSON({ s: '<tag>&value>' });
    expect(text).toBe('{"s":"\\u003ctag\\u003e\\u0026value\\u003e"}');
  });
});
