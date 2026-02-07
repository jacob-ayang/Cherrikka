import { convert, detectSource } from '../engine/service';
import type { ConvertRequest, ProgressEvent } from '../engine/ir/types';
import type { DetectPayload, WorkerCommand } from './protocol';

export type ProgressSink = (event: ProgressEvent) => void;

export async function runTask(command: WorkerCommand, payload: unknown, pushProgress: ProgressSink): Promise<unknown> {
  if (command === 'detect') {
    const { file } = payload as DetectPayload;
    return detectSource(file);
  }

  if (command === 'convert') {
    return convert(payload as ConvertRequest, pushProgress);
  }

  throw new Error(`unsupported command: ${command}`);
}
