import { describe, expect, it } from 'vitest';
import { marshalGoJSON } from '../../src/engine/util/go_json';

describe('marshalGoJSON', () => {
  it('sorts object keys and applies Go-style HTML escaping', () => {
    const text = marshalGoJSON({
      z: 1,
      a: '<>&\u2028\u2029',
    });

    expect(text).toBe('{"a":"\\u003c\\u003e\\u0026\\u2028\\u2029","z":1}');
  });

  it('supports pretty output with deterministic order', () => {
    const text = marshalGoJSON(
      {
        b: [2, 1],
        a: {
          y: true,
          x: null,
        },
      },
      true,
    );

    expect(text).toBe('{\n  "a": {\n    "x": null,\n    "y": true\n  },\n  "b": [\n    2,\n    1\n  ]\n}');
  });

  it('matches JSON semantics for undefined in object and array', () => {
    const value = {
      a: 1,
      b: undefined,
      c: [1, undefined, null],
    };
    const text = marshalGoJSON(value);
    expect(text).toBe('{"a":1,"c":[1,null,null]}');
  });
});
