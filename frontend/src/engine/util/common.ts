export function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

export function asArray<T = unknown>(value: unknown): T[] {
  if (!Array.isArray(value)) return [];
  return value as T[];
}

export function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

export function asBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  return fallback;
}

export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function dedupeStrings(items: string[]): string[] {
  const seen = new Set<string>();
  for (const item of items) {
    const clean = item.trim();
    if (!clean) continue;
    seen.add(clean);
  }
  return [...seen].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function toRfc3339(value: number | string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function normalizeText(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

export function truncate(input: string, max = 80): string {
  const runes = [...input.trim()];
  if (runes.length <= max) return input.trim();
  return `${runes.slice(0, max).join('')}…`;
}
