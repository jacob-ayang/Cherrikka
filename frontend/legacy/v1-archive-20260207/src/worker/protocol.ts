import type { ConvertRequest, ConvertResult, InspectResult, ProgressEvent, ValidateResult } from '../engine/ir/types';

export type WorkerCommand = 'inspect' | 'validate' | 'convert';

export interface WorkerRequestEnvelope {
  requestId: string;
  command: WorkerCommand;
  payload: unknown;
}

export interface WorkerSuccessEnvelope {
  requestId: string;
  ok: true;
  result: InspectResult | ValidateResult | ConvertResult;
}

export interface WorkerErrorEnvelope {
  requestId: string;
  ok: false;
  error: string;
}

export interface WorkerProgressEnvelope {
  requestId: string;
  kind: 'progress';
  event: ProgressEvent;
}

export type WorkerResponseEnvelope = WorkerSuccessEnvelope | WorkerErrorEnvelope | WorkerProgressEnvelope;

export interface InspectPayload {
  file: File;
}

export interface ValidatePayload {
  file: File;
}

export interface ConvertPayload {
  request: ConvertRequest;
}
