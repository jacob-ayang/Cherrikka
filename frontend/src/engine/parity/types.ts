export interface SQLiteParityRule {
  // Table-level ignored columns.
  ignoreColumns?: Record<string, string[]>;
  // Message JSON fields to strip from message_node.messages payload.
  stripMessageFields?: string[];
}

export interface ParityProfile {
  json: Record<string, string[]>;
  sqlite: Record<string, SQLiteParityRule>;
}

export interface NormalizedArtifactSnapshot {
  path: string;
  kind: 'json' | 'sqlite' | 'binary';
  contentHash: string;
}

export type ParityPathToken =
  | { kind: 'key'; key: string }
  | { kind: 'array' };
