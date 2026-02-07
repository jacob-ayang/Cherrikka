import type {
  ConvertRequest,
  ConvertResult,
  InspectResult,
  ProgressEvent,
  ValidateResult,
} from '../engine/ir/types';
import type {
  WorkerCommand,
  WorkerProgressEnvelope,
  WorkerRequestEnvelope,
  WorkerResponseEnvelope,
} from '../worker/protocol';
import { createActionPanel } from './components/action-panel';
import { createInputPanel } from './components/input-panel';
import { createResultPanel } from './components/result-panel';

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  onProgress?: (event: ProgressEvent) => void;
};

const worker = new Worker(new URL('../worker/index.ts', import.meta.url), { type: 'module' });
const pending = new Map<string, PendingRequest>();
const logLines: string[] = [];

export function mountApp(root: HTMLElement): void {
  root.innerHTML = '';

  const shell = document.createElement('main');
  shell.className = 'tui-shell';
  shell.innerHTML = `
    <h1 class="tui-title">CHERRIKKA LOCAL CONVERTER</h1>
    <p class="tui-subtitle">
      CHERRY STUDIO ↔ RIKKAHUB BACKUP CONVERTER. PURE FRONTEND, LOCAL WORKER, NO SERVER API.
    </p>
    <div id="tui-grid" class="tui-grid"></div>
  `;
  root.appendChild(shell);

  const grid = must<HTMLDivElement>(shell, '#tui-grid');
  const inputPanel = createInputPanel();
  const actionPanel = createActionPanel();
  grid.appendChild(inputPanel.root);
  grid.appendChild(actionPanel.root);

  const resultPanel = createResultPanel();
  shell.appendChild(resultPanel.root);

  worker.addEventListener('message', (event: MessageEvent<WorkerResponseEnvelope>) => {
    const envelope = event.data;
    const pendingItem = pending.get(envelope.requestId);
    if (!pendingItem) {
      return;
    }
    if ('kind' in envelope && envelope.kind === 'progress') {
      const progressEnvelope = envelope as WorkerProgressEnvelope;
      pendingItem.onProgress?.(progressEnvelope.event);
      return;
    }

    pending.delete(envelope.requestId);
    if ('ok' in envelope && envelope.ok) {
      pendingItem.resolve(envelope.result);
      return;
    }
    if ('ok' in envelope && !envelope.ok) {
      pendingItem.reject(new Error(envelope.error));
    }
  });

  actionPanel.refs.inspectButton.addEventListener('click', async () => {
    const source = inputPanel.refs.sourceFile.files?.[0];
    if (!source) {
      setError('SOURCE ZIP IS REQUIRED', resultPanel.refs.output, actionPanel.refs);
      return;
    }
    try {
      await withBusy(actionPanel.refs, async () => {
        const result = await sendWorker<InspectResult>('inspect', { file: source }, (p) => {
          updateProgress(actionPanel.refs, p);
        });
        setResult(resultPanel.refs.output, result);
      });
    } catch (error) {
      setError(toErr(error), resultPanel.refs.output, actionPanel.refs);
    }
  });

  actionPanel.refs.validateButton.addEventListener('click', async () => {
    const source = inputPanel.refs.sourceFile.files?.[0];
    if (!source) {
      setError('SOURCE ZIP IS REQUIRED', resultPanel.refs.output, actionPanel.refs);
      return;
    }
    try {
      await withBusy(actionPanel.refs, async () => {
        const result = await sendWorker<ValidateResult>('validate', { file: source }, (p) => {
          updateProgress(actionPanel.refs, p);
        });
        setResult(resultPanel.refs.output, result);
      });
    } catch (error) {
      setError(toErr(error), resultPanel.refs.output, actionPanel.refs);
    }
  });

  actionPanel.refs.convertButton.addEventListener('click', async () => {
    const source = inputPanel.refs.sourceFile.files?.[0];
    if (!source) {
      setError('SOURCE ZIP IS REQUIRED', resultPanel.refs.output, actionPanel.refs);
      return;
    }
    const request: ConvertRequest = {
      inputFile: source,
      templateFile: inputPanel.refs.templateFile.files?.[0],
      from: inputPanel.refs.fromSelect.value as ConvertRequest['from'],
      to: inputPanel.refs.toSelect.value as ConvertRequest['to'],
      redactSecrets: inputPanel.refs.redactSecrets.checked,
    };

    try {
      await withBusy(actionPanel.refs, async () => {
        const result = await sendWorker<ConvertResult>('convert', { request }, (p) => {
          updateProgress(actionPanel.refs, p);
        });
        const fileName = `converted-${request.to}-${Date.now()}.zip`;
        downloadBlob(result.outputBlob, fileName);
        setResult(resultPanel.refs.output, {
          downloaded: true,
          fileName,
          manifest: result.manifest,
        });
      });
    } catch (error) {
      setError(toErr(error), resultPanel.refs.output, actionPanel.refs);
    }
  });

  resultPanel.refs.clearButton.addEventListener('click', () => {
    setResult(resultPanel.refs.output, {});
    resetProgress(actionPanel.refs);
  });

  resultPanel.refs.copyButton.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(resultPanel.refs.output.textContent ?? '{}');
      appendLog(actionPanel.refs.log, '[ok] copied result json');
    } catch (error) {
      appendLog(actionPanel.refs.log, `[error] copy failed: ${toErr(error)}`);
    }
  });

  resetProgress(actionPanel.refs);
  setResult(resultPanel.refs.output, {});
}

function sendWorker<T>(
  command: WorkerCommand,
  payload: unknown,
  onProgress?: (event: ProgressEvent) => void,
): Promise<T> {
  const requestId = crypto.randomUUID();
  const envelope: WorkerRequestEnvelope = {
    requestId,
    command,
    payload,
  };

  return new Promise<T>((resolve, reject) => {
    pending.set(requestId, {
      resolve: (value: unknown) => resolve(value as T),
      reject,
      onProgress,
    });
    worker.postMessage(envelope);
  });
}

async function withBusy(
  refs: ReturnType<typeof createActionPanel>['refs'],
  action: () => Promise<void>,
): Promise<void> {
  refs.inspectButton.disabled = true;
  refs.validateButton.disabled = true;
  refs.convertButton.disabled = true;
  try {
    await action();
  } finally {
    refs.inspectButton.disabled = false;
    refs.validateButton.disabled = false;
    refs.convertButton.disabled = false;
  }
}

function updateProgress(
  refs: ReturnType<typeof createActionPanel>['refs'],
  event: ProgressEvent,
): void {
  const progress = clampProgress(event.progress);
  refs.stage.textContent = event.stage.toUpperCase();
  refs.percent.textContent = `${Math.round(progress)}%`;
  refs.bar.style.width = `${progress}%`;
  refs.message.textContent = event.message ?? '';
  appendLog(refs.log, `[${event.stage}] ${event.message ?? ''} (${Math.round(progress)}%)`);
}

function resetProgress(refs: ReturnType<typeof createActionPanel>['refs']): void {
  refs.stage.textContent = 'IDLE';
  refs.percent.textContent = '0%';
  refs.bar.style.width = '0%';
  refs.message.textContent = 'READY';
  logLines.length = 0;
  refs.log.textContent = '[idle] waiting for input';
}

function setResult(output: HTMLPreElement, value: unknown): void {
  output.textContent = JSON.stringify(value, null, 2);
}

function setError(
  message: string,
  output: HTMLPreElement,
  refs: ReturnType<typeof createActionPanel>['refs'],
): void {
  setResult(output, { error: message });
  updateProgress(refs, { stage: 'error', progress: 0, message });
}

function appendLog(log: HTMLElement, line: string): void {
  logLines.push(line);
  if (logLines.length > 200) {
    logLines.shift();
  }
  log.textContent = logLines.join('\n');
  log.scrollTop = log.scrollHeight;
}

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function clampProgress(progress: number): number {
  if (!Number.isFinite(progress)) return 0;
  if (progress < 0) return 0;
  if (progress > 100) return 100;
  return progress;
}

function toErr(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function must<T extends Element>(root: ParentNode, selector: string): T {
  const node = root.querySelector<T>(selector);
  if (!node) {
    throw new Error(`missing app element: ${selector}`);
  }
  return node;
}
