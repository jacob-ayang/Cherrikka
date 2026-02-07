/// <reference lib="webworker" />

import type { WorkerRequestEnvelope, WorkerResponseEnvelope } from './protocol';
import { runTask } from './tasks';

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
    const result = await runTask(request.command, request.payload, (p) => {
      pushProgress(p.stage, p.progress, p.message ?? '');
    });
    scope.postMessage({
      requestId: request.requestId,
      ok: true,
      result,
    } satisfies WorkerResponseEnvelope);
  } catch (error) {
    scope.postMessage({
      requestId: request.requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    } satisfies WorkerResponseEnvelope);
  }
};
