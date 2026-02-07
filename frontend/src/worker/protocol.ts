import type { ConvertRequest, ConvertResult, DetectResult, ProgressEvent } from '../engine/ir/types';

export type WorkerCommand = 'detect' | 'convert';

export interface DetectPayload {
  file: File;
}

export interface WorkerRequestEnvelope {
  id: string;
  command: WorkerCommand;
  payload: DetectPayload | ConvertRequest;
}

export interface WorkerSuccessEnvelope {
  id: string;
  ok: true;
  result: DetectResult | ConvertResult;
}

export interface WorkerErrorEnvelope {
  id: string;
  ok: false;
  error: string;
}

export interface WorkerProgressEnvelope {
  id: string;
  type: 'progress';
  event: ProgressEvent;
}

export type WorkerResponseEnvelope = WorkerSuccessEnvelope | WorkerErrorEnvelope | WorkerProgressEnvelope;
