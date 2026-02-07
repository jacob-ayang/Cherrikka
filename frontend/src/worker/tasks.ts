import { convert, inspect, validate } from '../engine/service';
import type { ProgressEvent } from '../engine/ir/types';
import type { ConvertPayload, InspectPayload, ValidatePayload, WorkerCommand } from './protocol';

export type ProgressSink = (event: ProgressEvent) => void;

export async function runTask(
  command: WorkerCommand,
  payload: unknown,
  pushProgress: ProgressSink,
): Promise<unknown> {
  if (command === 'inspect') {
    const inspectPayload = payload as InspectPayload;
    return inspect(inspectPayload.file, pushProgress);
  }
  if (command === 'validate') {
    const validatePayload = payload as ValidatePayload;
    return validate(validatePayload.file, pushProgress);
  }
  if (command === 'convert') {
    const convertPayload = payload as ConvertPayload;
    return convert(convertPayload.request, pushProgress);
  }
  throw new Error(`unsupported command: ${command}`);
}
