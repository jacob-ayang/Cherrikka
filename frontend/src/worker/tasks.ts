import { convert, detectSource } from '../engine/service';
import type { ProgressEvent } from '../engine/ir/types';
import type { ConvertPayload, DetectPayload, WorkerCommand } from './protocol';

export type ProgressSink = (event: ProgressEvent) => void;

export async function runTask(command: WorkerCommand, payload: unknown, pushProgress: ProgressSink): Promise<unknown> {
  if (command === 'detect') {
    const { file } = payload as DetectPayload;
    return detectSource(file);
  }

  if (command === 'convert') {
    const { request } = payload as ConvertPayload;
    return convert(request, pushProgress);
  }

  throw new Error(`unsupported command: ${command}`);
}
