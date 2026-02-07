import type { DetectResultFormat, SourceFormat, TargetFormat } from '../engine/ir/types';

export function resolveTargetFormat(source: SourceFormat, detected: DetectResultFormat): TargetFormat | null {
  if (source === 'cherry') return 'rikka';
  if (source === 'rikka') return 'cherry';
  if (detected === 'cherry') return 'rikka';
  if (detected === 'rikka') return 'cherry';
  return null;
}
