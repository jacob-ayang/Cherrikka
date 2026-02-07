function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortValue(item));
  }
  if (value && typeof value === 'object') {
    const input = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort((a, b) => a.localeCompare(b))) {
      out[key] = sortValue(input[key]);
    }
    return out;
  }
  return value;
}

function escapeForGoJson(text: string): string {
  return text
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function marshalGoJSON(value: unknown): string {
  const sorted = sortValue(value);
  const text = JSON.stringify(sorted);
  return escapeForGoJson(text);
}
