const SECRET_KEYS = ['apiKey', 'password', 'secret', 'token', 'accessKey', 'secretAccessKey'];

export function redactSecrets<T>(value: T): T {
  return walk(value) as T;
}

function walk(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => walk(item));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEYS.some((key) => k.toLowerCase().includes(key.toLowerCase()))) {
        out[k] = typeof v === 'string' && v.length > 0 ? '***REDACTED***' : v;
      } else {
        out[k] = walk(v);
      }
    }
    return out;
  }
  return value;
}
