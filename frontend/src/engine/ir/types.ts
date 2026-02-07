export type BackupFormat = 'cherry' | 'rikka';
export type SourceFormat = 'auto' | BackupFormat;
export type TargetFormat = BackupFormat;
export type DetectResultFormat = BackupFormat | 'unknown';
export type ProgressLevel = 'info' | 'warning' | 'error';

export interface ProgressEvent {
  stage: string;
  progress: number;
  message: string;
  level: ProgressLevel;
}

export interface DetectResult {
  sourceFormat: DetectResultFormat;
  targetFormat: TargetFormat | null;
  hints: string[];
  warnings: string[];
}

export interface ConvertRequest {
  inputFile: File;
  from: SourceFormat;
  to: TargetFormat;
  redactSecrets: boolean;
}

export interface Manifest {
  schemaVersion: number;
  sourceApp: string;
  sourceFormat: BackupFormat;
  sourceSha256: string;
  targetApp: string;
  targetFormat: TargetFormat;
  idMap: Record<string, string>;
  redaction: boolean;
  createdAt: string;
  warnings: string[];
}

export interface ConvertResult {
  outputBlob: Blob;
  outputName: string;
  manifest: Manifest;
  warnings: string[];
  errors: string[];
}

export interface BackupIR {
  sourceApp: string;
  sourceFormat: BackupFormat;
  targetFormat: TargetFormat;
  assistants: IRAssistant[];
  conversations: IRConversation[];
  files: IRFile[];
  config: Record<string, unknown>;
  opaque: Record<string, unknown>;
  warnings: string[];
}

export interface IRAssistant {
  id: string;
  name: string;
  prompt: string;
  model?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  opaque?: Record<string, unknown>;
}

export interface IRConversation {
  id: string;
  assistantId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: IRMessage[];
  opaque?: Record<string, unknown>;
}

export interface IRMessage {
  id: string;
  role: string;
  createdAt: string;
  modelId: string;
  parts: IRPart[];
  opaque?: Record<string, unknown>;
}

export type IRPartType = 'text' | 'reasoning' | 'tool' | 'image' | 'video' | 'audio' | 'document';

export interface IRPart {
  type: IRPartType;
  content?: string;
  name?: string;
  fileId?: string;
  mediaUrl?: string;
  mimeType?: string;
  input?: string;
  toolCallId?: string;
  output?: IRPart[];
  metadata?: Record<string, unknown>;
}

export interface IRFile {
  id: string;
  name: string;
  ext: string;
  mimeType: string;
  logicalType: string;
  relativeSrc: string;
  size: number;
  createdAt: string;
  updatedAt: string;
  hashSha256: string;
  missing: boolean;
  orphan: boolean;
  bytes: Uint8Array;
  metadata?: Record<string, unknown>;
}
