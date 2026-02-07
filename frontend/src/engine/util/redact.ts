const SECRET_TOKENS = [
  'api_key',
  'apikey',
  'token',
  'secret',
  'password',
  'access_key',
  'secretaccesskey',
];

export function shouldRedactKey(key: string): boolean {
  const normalized = key.trim().toLowerCase();
  return SECRET_TOKENS.some((token) => normalized.includes(token));
}

export function redactAny(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactAny(item));
  }
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (shouldRedactKey(key)) {
        output[key] = '***REDACTED***';
      } else {
        output[key] = redactAny(child);
      }
    }
    return output;
  }
  return value;
}
