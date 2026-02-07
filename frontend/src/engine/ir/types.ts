export type BackupFormat = 'cherry' | 'rikka' | 'unknown';

export interface IRAssistant {
  id: string;
  name: string;
  prompt?: string;
  description?: string;
  model?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  opaque?: Record<string, unknown>;
}

export interface IRPart {
  type: 'text' | 'reasoning' | 'tool' | 'image' | 'video' | 'audio' | 'document';
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

export interface IRMessage {
  id: string;
  role: string;
  createdAt?: string;
  modelId?: string;
  parts: IRPart[];
  opaque?: Record<string, unknown>;
}

export interface IRConversation {
  id: string;
  assistantId?: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  messages: IRMessage[];
  opaque?: Record<string, unknown>;
}

export interface IRFile {
  id: string;
  name: string;
  relativeSrc?: string;
  size?: number;
  mimeType?: string;
  ext?: string;
  createdAt?: string;
  updatedAt?: string;
  hashSha256?: string;
  logicalType?: string;
  missing?: boolean;
  orphan?: boolean;
  metadata?: Record<string, unknown>;
  bytes?: Uint8Array;
}

export interface BackupIR {
  sourceApp: string;
  sourceFormat: BackupFormat;
  targetFormat?: Exclude<BackupFormat, 'unknown'>;
  detectedHints?: string[];
  createdAt: string;
  assistants: IRAssistant[];
  conversations: IRConversation[];
  files: IRFile[];
  config: Record<string, unknown>;
  settings: Record<string, unknown>;
  opaque: Record<string, unknown>;
  secrets: Record<string, string>;
  warnings: string[];
}

export interface Manifest {
  schemaVersion: number;
  sourceApp: string;
  sourceFormat: string;
  sourceSha256: string;
  targetApp: string;
  targetFormat: string;
  idMap?: Record<string, string>;
  redaction: boolean;
  createdAt: string;
  warnings?: string[];
}

export interface ConfigSummary {
  providers: number;
  assistants: number;
  hasWebdav: boolean;
  hasS3: boolean;
  isolatedConfigItems?: number;
  rehydrationAvailable?: boolean;
}

export interface FileSummary {
  total: number;
  referenced: number;
  orphan: number;
  missing: number;
}

export interface InspectResult {
  format: BackupFormat;
  hints: string[];
  conversations: number;
  assistants: number;
  files: number;
  sourceApp: string;
  configSummary?: ConfigSummary;
  fileSummary?: FileSummary;
}

export interface ValidateResult {
  valid: boolean;
  format: BackupFormat;
  issues: string[];
  errors: string[];
  warnings: string[];
  configSummary?: ConfigSummary;
  fileSummary?: FileSummary;
}

export interface ConvertRequest {
  inputFile: File;
  templateFile?: File;
  from: 'auto' | 'cherry' | 'rikka';
  to: 'cherry' | 'rikka';
  redactSecrets: boolean;
}

export interface ConvertResult {
  outputBlob: Blob;
  manifest: Manifest;
}

export interface DetectResult {
  format: BackupFormat;
  hints: string[];
}

export interface ProgressEvent {
  stage: string;
  progress: number;
  message?: string;
}
