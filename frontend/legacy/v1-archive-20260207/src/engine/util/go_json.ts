export function marshalGoJSON(value: unknown, pretty = false): string {
  return stringifyValue(value, 0, pretty);
}

function stringifyValue(value: unknown, depth: number, pretty: boolean): string {
  if (value === null) {
    return 'null';
  }

  const valueType = typeof value;
  if (valueType === 'string') {
    return stringifyString(value as string);
  }
  if (valueType === 'number') {
    const numeric = value as number;
    if (!Number.isFinite(numeric)) {
      return 'null';
    }
    return String(numeric);
  }
  if (valueType === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (valueType === 'bigint' || valueType === 'function' || valueType === 'symbol' || valueType === 'undefined') {
    return 'null';
  }

  if (Array.isArray(value)) {
    return stringifyArray(value, depth, pretty);
  }

  if (value instanceof Uint8Array) {
    return stringifyArray(Array.from(value), depth, pretty);
  }

  if (value instanceof Date) {
    return stringifyString(value.toISOString());
  }

  if (valueType === 'object') {
    return stringifyObject(value as Record<string, unknown>, depth, pretty);
  }

  return 'null';
}

function stringifyArray(values: unknown[], depth: number, pretty: boolean): string {
  if (values.length === 0) {
    return '[]';
  }

  if (!pretty) {
    const compactItems = values.map((item) => stringifyValue(item, depth + 1, false));
    return `[${compactItems.join(',')}]`;
  }

  const indent = '  '.repeat(depth + 1);
  const closeIndent = '  '.repeat(depth);
  const lines = values.map((item) => `${indent}${stringifyValue(item, depth + 1, true)}`);
  return `[\n${lines.join(',\n')}\n${closeIndent}]`;
}

function stringifyObject(obj: Record<string, unknown>, depth: number, pretty: boolean): string {
  const keys = Object.keys(obj).sort((a, b) => compareKeys(a, b));
  const pairs: Array<{ key: string; value: unknown }> = [];

  for (const key of keys) {
    const raw = obj[key];
    if (raw === undefined || typeof raw === 'function' || typeof raw === 'symbol') {
      continue;
    }
    pairs.push({ key, value: raw });
  }

  if (pairs.length === 0) {
    return '{}';
  }

  if (!pretty) {
    const compact = pairs.map(({ key, value }) => `${stringifyString(key)}:${stringifyValue(value, depth + 1, false)}`);
    return `{${compact.join(',')}}`;
  }

  const indent = '  '.repeat(depth + 1);
  const closeIndent = '  '.repeat(depth);
  const lines = pairs.map(({ key, value }) => (
    `${indent}${stringifyString(key)}: ${stringifyValue(value, depth + 1, true)}`
  ));
  return `{\n${lines.join(',\n')}\n${closeIndent}}`;
}

function stringifyString(text: string): string {
  const quoted = JSON.stringify(text);
  return quoted.replace(/[<>&\u2028\u2029]/g, (char) => {
    if (char === '<') return '\\u003c';
    if (char === '>') return '\\u003e';
    if (char === '&') return '\\u0026';
    if (char === '\u2028') return '\\u2028';
    return '\\u2029';
  });
}

function compareKeys(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
