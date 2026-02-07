export function asMap(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function asBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export function cloneAny<T>(value: T): T {
  if (value === null || value === undefined) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return new Uint8Array(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => cloneAny(item)) as T;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = cloneAny(item);
    }
    return out as T;
  }
  return value;
}

export function dedupeStrings(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const normalized = item.trim();
    if (!normalized) {
      continue;
    }
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  out.sort();
  return out;
}

export function pickFirstString(...values: unknown[]): string {
  for (const value of values) {
    const str = asString(value);
    if (str) {
      return str;
    }
  }
  return '';
}

export function setIfPresent(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value === null || value === undefined) {
    return;
  }
  if (typeof value === 'string' && value.trim() === '') {
    return;
  }
  if (Array.isArray(value) && value.length === 0) {
    return;
  }
  if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value as Record<string, unknown>).length === 0) {
    return;
  }
  target[key] = value;
}

export function mergeMissing(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    if (Object.prototype.hasOwnProperty.call(target, key)) {
      continue;
    }
    target[key] = cloneAny(value);
  }
}

export function isoNow(): string {
  return new Date().toISOString();
}
