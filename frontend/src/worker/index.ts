/// <reference lib="webworker" />

import { runTask } from './tasks';
import type { WorkerProgressEnvelope, WorkerRequestEnvelope, WorkerResponseEnvelope } from './protocol';

self.onmessage = async (event: MessageEvent<WorkerRequestEnvelope>) => {
  const request = event.data;

  const pushProgress = (progress: WorkerProgressEnvelope['event']) => {
    const packet: WorkerProgressEnvelope = {
      id: request.id,
      type: 'progress',
      event: progress,
    };
    self.postMessage(packet);
  };

  try {
    const result = await runTask(request.command, request.payload, pushProgress);
    const response: WorkerResponseEnvelope = {
      id: request.id,
      ok: true,
      result: result as never,
    };
    self.postMessage(response);
  } catch (error) {
    const response: WorkerResponseEnvelope = {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(response);
  }
};
