import { cloneAny } from '../util/common';
import type { ParityPathToken, ParityProfile, SQLiteParityRule } from './types';

export function parseParityPath(path: string): ParityPathToken[] {
  const trimmed = path.trim();
  if (!trimmed) {
    return [];
  }

  const tokens: ParityPathToken[] = [];
  const segments = trimmed.split('.').map((segment) => segment.trim()).filter(Boolean);
  for (const segment of segments) {
    let remainder = segment;
    let wildcardCount = 0;
    while (remainder.endsWith('[]')) {
      wildcardCount += 1;
      remainder = remainder.slice(0, -2);
    }
    if (remainder) {
      tokens.push({ kind: 'key', key: remainder });
    }
    for (let index = 0; index < wildcardCount; index += 1) {
      tokens.push({ kind: 'array' });
    }
  }
  return tokens;
}

export function stripJsonByPaths<T>(value: T, paths: string[]): T {
  const cloned = cloneAny(value);
  for (const path of paths) {
    const tokens = parseParityPath(path);
    if (tokens.length === 0) {
      continue;
    }
    stripByTokens(cloned as unknown, tokens, 0);
  }
  return cloned;
}

export function parseParityProfile(value: unknown): ParityProfile {
  const fallback: ParityProfile = {
    json: {},
    sqlite: {},
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fallback;
  }

  const source = value as Record<string, unknown>;
  return {
    json: parseJsonSection(source.json),
    sqlite: parseSqliteSection(source.sqlite),
  };
}

function parseJsonSection(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, string[]> = {};
  for (const [path, rules] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(rules)) {
      continue;
    }
    const normalized = rules
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean);
    if (normalized.length > 0) {
      out[path] = normalized;
    }
  }
  return out;
}

function parseSqliteSection(value: unknown): Record<string, SQLiteParityRule> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, SQLiteParityRule> = {};
  for (const [path, rawRule] of Object.entries(value as Record<string, unknown>)) {
    if (!rawRule || typeof rawRule !== 'object' || Array.isArray(rawRule)) {
      continue;
    }
    const ruleMap = rawRule as Record<string, unknown>;
    const rule: SQLiteParityRule = {};
    if (ruleMap.ignoreColumns && typeof ruleMap.ignoreColumns === 'object' && !Array.isArray(ruleMap.ignoreColumns)) {
      const ignoreColumns: Record<string, string[]> = {};
      for (const [table, columns] of Object.entries(ruleMap.ignoreColumns as Record<string, unknown>)) {
        if (!Array.isArray(columns)) {
          continue;
        }
        const normalized = columns
          .filter((item): item is string => typeof item === 'string')
          .map((item) => item.trim())
          .filter(Boolean);
        if (normalized.length > 0) {
          ignoreColumns[table] = normalized;
        }
      }
      if (Object.keys(ignoreColumns).length > 0) {
        rule.ignoreColumns = ignoreColumns;
      }
    }
    if (Array.isArray(ruleMap.stripMessageFields)) {
      const fields = ruleMap.stripMessageFields
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean);
      if (fields.length > 0) {
        rule.stripMessageFields = fields;
      }
    }
    out[path] = rule;
  }
  return out;
}

function stripByTokens(node: unknown, tokens: ParityPathToken[], index: number): void {
  if (index >= tokens.length) {
    return;
  }
  const token = tokens[index];
  if (token.kind === 'key') {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      return;
    }
    const target = node as Record<string, unknown>;
    if (!(token.key in target)) {
      return;
    }
    if (index === tokens.length - 1) {
      delete target[token.key];
      return;
    }
    stripByTokens(target[token.key], tokens, index + 1);
    return;
  }

  if (!Array.isArray(node)) {
    return;
  }
  if (index === tokens.length - 1) {
    node.splice(0, node.length);
    return;
  }
  for (const item of node) {
    stripByTokens(item, tokens, index + 1);
  }
}
