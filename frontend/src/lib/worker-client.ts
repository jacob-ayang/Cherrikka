import { newId } from '../engine/util/id';
import type { ConvertResult, DetectResult, ProgressEvent } from '../engine/ir/types';
import type { ConvertPayload, DetectPayload, WorkerRequestEnvelope, WorkerResponseEnvelope } from '../worker/protocol';

type PendingItem = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  onProgress?: (event: ProgressEvent) => void;
};

export class WorkerClient {
  private worker: Worker;
  private pending = new Map<string, PendingItem>();

  constructor() {
    this.worker = new Worker(new URL('../worker/index.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<WorkerResponseEnvelope>) => {
      const packet = event.data;
      const pending = this.pending.get(packet.id);
      if (!pending) return;

      if ('type' in packet && packet.type === 'progress') {
        pending.onProgress?.(packet.event);
        return;
      }

      this.pending.delete(packet.id);
      if (packet.ok) {
        pending.resolve(packet.result);
      } else {
        pending.reject(new Error(packet.error));
      }
    };
  }

  async detect(file: File): Promise<DetectResult> {
    const payload: DetectPayload = { file };
    return this.send<DetectResult>('detect', payload);
  }

  async convert(
    payload: ConvertPayload,
    onProgress?: (event: ProgressEvent) => void,
  ): Promise<ConvertResult> {
    return this.send<ConvertResult>('convert', payload, onProgress);
  }

  private send<T>(
    command: WorkerRequestEnvelope['command'],
    payload: WorkerRequestEnvelope['payload'],
    onProgress?: (event: ProgressEvent) => void,
  ): Promise<T> {
    const id = newId();
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, onProgress });
      const request: WorkerRequestEnvelope = { id, command, payload };
      this.worker.postMessage(request);
    });
  }
}
