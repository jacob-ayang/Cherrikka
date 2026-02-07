/// <reference lib="webworker" />

import { convert, inspect, validate } from '../core/service';
import type { ConvertPayload, InspectPayload, ValidatePayload, WorkerRequestEnvelope, WorkerResponseEnvelope } from './protocol';

const scope: DedicatedWorkerGlobalScope = self as DedicatedWorkerGlobalScope;

scope.onmessage = async (event: MessageEvent<WorkerRequestEnvelope>) => {
  const request = event.data;
  if (!request || !request.requestId || !request.command) {
    return;
  }

  const pushProgress = (stage: string, progress: number, message: string): void => {
    const envelope: WorkerResponseEnvelope = {
      requestId: request.requestId,
      kind: 'progress',
      event: {
        stage,
        progress,
        message,
      },
    };
    scope.postMessage(envelope);
  };

  try {
    if (request.command === 'inspect') {
      const payload = request.payload as InspectPayload;
      const result = await inspect(payload.file, (p) => pushProgress(p.stage, p.progress, p.message ?? ''));
      scope.postMessage({
        requestId: request.requestId,
        ok: true,
        result,
      } satisfies WorkerResponseEnvelope);
      return;
    }

    if (request.command === 'validate') {
      const payload = request.payload as ValidatePayload;
      const result = await validate(payload.file, (p) => pushProgress(p.stage, p.progress, p.message ?? ''));
      scope.postMessage({
        requestId: request.requestId,
        ok: true,
        result,
      } satisfies WorkerResponseEnvelope);
      return;
    }

    if (request.command === 'convert') {
      const payload = request.payload as ConvertPayload;
      const result = await convert(payload.request, (p) => pushProgress(p.stage, p.progress, p.message ?? ''));
      scope.postMessage({
        requestId: request.requestId,
        ok: true,
        result,
      } satisfies WorkerResponseEnvelope);
      return;
    }

    scope.postMessage({
      requestId: request.requestId,
      ok: false,
      error: `unsupported command: ${request.command}`,
    } satisfies WorkerResponseEnvelope);
  } catch (error) {
    scope.postMessage({
      requestId: request.requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    } satisfies WorkerResponseEnvelope);
  }
};
