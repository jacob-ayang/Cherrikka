import type { ConvertRequest, ConvertResult, InspectResult, ProgressEvent, ValidateResult } from '../core/ir/types';
import type { WorkerCommand, WorkerProgressEnvelope, WorkerRequestEnvelope, WorkerResponseEnvelope } from '../worker/protocol';

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (reason?: unknown) => void;
  onProgress?: (event: ProgressEvent) => void;
};

const worker = new Worker(new URL('../worker/index.ts', import.meta.url), { type: 'module' });
const pending = new Map<string, PendingRequest>();

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) {
  throw new Error('missing #app root');
}

app.innerHTML = `
  <main class="shell">
    <div class="bg-shape a"></div>
    <div class="bg-shape b"></div>
    <header>
      <p class="eyebrow">Local-Only Converter</p>
      <h1>Cherrikka Frontend</h1>
      <p class="subtitle">Cherry Studio ↔ RikkaHub 备份互转（浏览器本地执行，无后端 API）</p>
    </header>

    <section class="grid">
      <article class="card inputs">
        <h2>Inputs</h2>
        <label for="source-file">Source Backup Zip</label>
        <input id="source-file" type="file" accept=".zip,application/zip" />

        <label for="template-file">Template Zip (Optional)</label>
        <input id="template-file" type="file" accept=".zip,application/zip" />

        <div class="row two">
          <div>
            <label for="from-select">From</label>
            <select id="from-select">
              <option value="auto">auto</option>
              <option value="cherry">cherry</option>
              <option value="rikka">rikka</option>
            </select>
          </div>
          <div>
            <label for="to-select">To</label>
            <select id="to-select">
              <option value="rikka">rikka</option>
              <option value="cherry">cherry</option>
            </select>
          </div>
        </div>

        <label class="inline-check" for="redact-secrets">
          <input id="redact-secrets" type="checkbox" />
          <span>Redact secrets</span>
        </label>
      </article>

      <article class="card actions">
        <h2>Actions</h2>
        <button id="btn-inspect" class="btn">Inspect</button>
        <button id="btn-validate" class="btn">Validate</button>
        <button id="btn-convert" class="btn accent">Convert & Download</button>

        <div class="progress-wrap">
          <div class="progress-head">
            <span id="progress-stage">idle</span>
            <span id="progress-percent">0%</span>
          </div>
          <div class="progress-track">
            <div id="progress-bar" class="progress-bar"></div>
          </div>
          <p id="progress-message" class="progress-message">等待操作</p>
        </div>
      </article>
    </section>

    <section class="card output">
      <div class="output-head">
        <h2>Result</h2>
        <button id="btn-clear" class="btn ghost">Clear</button>
      </div>
      <pre id="result-json">{}</pre>
    </section>
  </main>
`;

const style = document.createElement('style');
style.textContent = `
  :root {
    --bg0: #f1eadb;
    --bg1: #dfd0b8;
    --bg2: #9ebca8;
    --ink: #1a251f;
    --card: #fcf7ec;
    --line: #d3c6af;
    --muted: #5d6b63;
    --accent: #0b6e4f;
    --accent-ink: #e6fff6;
  }

  * { box-sizing: border-box; }

  body {
    margin: 0;
    min-height: 100vh;
    font-family: "IBM Plex Sans", "Trebuchet MS", "Segoe UI", sans-serif;
    color: var(--ink);
    background:
      radial-gradient(circle at 20% 10%, #f8f0df 0, transparent 40%),
      radial-gradient(circle at 80% 90%, #b6d0c0 0, transparent 35%),
      linear-gradient(145deg, var(--bg0), var(--bg1) 60%, var(--bg2));
  }

  .shell {
    position: relative;
    max-width: 1080px;
    margin: 0 auto;
    padding: 32px 20px 40px;
  }

  .bg-shape {
    position: absolute;
    filter: blur(34px);
    opacity: 0.42;
    z-index: 0;
    pointer-events: none;
  }

  .bg-shape.a {
    width: 340px;
    height: 340px;
    background: #a6c8b4;
    border-radius: 38% 62% 48% 52% / 45% 37% 63% 55%;
    top: -90px;
    right: 40px;
  }

  .bg-shape.b {
    width: 280px;
    height: 280px;
    background: #f5d6a5;
    border-radius: 60% 40% 42% 58% / 56% 59% 41% 44%;
    left: -120px;
    top: 240px;
  }

  header,
  .card {
    position: relative;
    z-index: 1;
  }

  .eyebrow {
    margin: 0;
    text-transform: uppercase;
    font-family: "IBM Plex Mono", "Cascadia Code", monospace;
    letter-spacing: 0.08em;
    color: var(--muted);
    font-size: 0.8rem;
  }

  h1 {
    margin: 4px 0 6px;
    font-size: clamp(1.9rem, 4vw, 2.9rem);
    line-height: 1.1;
  }

  .subtitle {
    margin: 0 0 18px;
    color: var(--muted);
  }

  .grid {
    display: grid;
    gap: 14px;
    grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    margin-bottom: 14px;
  }

  .card {
    background: color-mix(in srgb, var(--card) 88%, white 12%);
    border: 1px solid var(--line);
    border-radius: 16px;
    padding: 16px;
    box-shadow: 0 8px 24px rgba(30, 40, 30, 0.07);
  }

  h2 {
    margin: 0 0 10px;
    font-size: 1.1rem;
  }

  label {
    display: block;
    margin: 10px 0 6px;
    font-size: 0.92rem;
  }

  input,
  select,
  button {
    width: 100%;
    border-radius: 10px;
    border: 1px solid var(--line);
    padding: 10px 11px;
    background: #fffef9;
    color: var(--ink);
    font: inherit;
  }

  .row.two {
    margin-top: 8px;
    display: grid;
    gap: 10px;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .inline-check {
    margin-top: 14px;
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
  }

  .inline-check input {
    width: auto;
  }

  .actions {
    display: grid;
    align-content: start;
    gap: 8px;
  }

  .btn {
    cursor: pointer;
    transition: transform .14s ease, box-shadow .14s ease, background .14s ease;
    background: #f4ecdc;
  }

  .btn:hover {
    transform: translateY(-1px);
    box-shadow: 0 4px 14px rgba(24, 42, 34, 0.12);
  }

  .btn:disabled {
    cursor: not-allowed;
    opacity: 0.55;
    transform: none;
    box-shadow: none;
  }

  .btn.accent {
    background: linear-gradient(160deg, var(--accent), #09543d);
    color: var(--accent-ink);
    border-color: transparent;
  }

  .btn.ghost {
    width: auto;
    padding: 7px 10px;
    font-size: 0.84rem;
  }

  .progress-wrap {
    margin-top: 10px;
    border-top: 1px dashed var(--line);
    padding-top: 12px;
  }

  .progress-head {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    font-family: "IBM Plex Mono", "Cascadia Code", monospace;
    font-size: 0.85rem;
    margin-bottom: 6px;
    color: var(--muted);
  }

  .progress-track {
    height: 10px;
    border-radius: 999px;
    overflow: hidden;
    background: #e6dac5;
    border: 1px solid #d2c19e;
  }

  .progress-bar {
    width: 0%;
    height: 100%;
    background: linear-gradient(90deg, #208a67, #6dcf9f);
    transition: width .22s ease;
  }

  .progress-message {
    margin: 8px 0 0;
    color: var(--muted);
    min-height: 1.35em;
    font-size: .9rem;
  }

  .output-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 8px;
  }

  pre {
    margin: 0;
    min-height: 180px;
    max-height: 420px;
    overflow: auto;
    padding: 12px;
    border-radius: 10px;
    border: 1px solid #3d4e45;
    background: #12211b;
    color: #f0fff7;
    font-family: "IBM Plex Mono", "Cascadia Code", monospace;
    font-size: .84rem;
    line-height: 1.45;
  }

  @media (max-width: 700px) {
    .shell { padding: 20px 14px 26px; }
    .row.two { grid-template-columns: 1fr; }
  }
`;
document.head.appendChild(style);

const sourceFileInput = must<HTMLInputElement>('#source-file');
const templateFileInput = must<HTMLInputElement>('#template-file');
const fromSelect = must<HTMLSelectElement>('#from-select');
const toSelect = must<HTMLSelectElement>('#to-select');
const redactCheckbox = must<HTMLInputElement>('#redact-secrets');
const inspectButton = must<HTMLButtonElement>('#btn-inspect');
const validateButton = must<HTMLButtonElement>('#btn-validate');
const convertButton = must<HTMLButtonElement>('#btn-convert');
const clearButton = must<HTMLButtonElement>('#btn-clear');
const resultPre = must<HTMLPreElement>('#result-json');
const progressStage = must<HTMLSpanElement>('#progress-stage');
const progressPercent = must<HTMLSpanElement>('#progress-percent');
const progressBar = must<HTMLDivElement>('#progress-bar');
const progressMessage = must<HTMLParagraphElement>('#progress-message');

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
  } else if ('ok' in envelope && !envelope.ok) {
    pendingItem.reject(new Error(envelope.error));
  }
});

inspectButton.addEventListener('click', async () => {
  const sourceFile = sourceFileInput.files?.[0];
  if (!sourceFile) {
    setError('请先选择 source zip');
    return;
  }
  await withBusy(async () => {
    const result = await sendWorker<InspectResult>('inspect', { file: sourceFile }, updateProgress);
    setResult(result);
  });
});

validateButton.addEventListener('click', async () => {
  const sourceFile = sourceFileInput.files?.[0];
  if (!sourceFile) {
    setError('请先选择 source zip');
    return;
  }
  await withBusy(async () => {
    const result = await sendWorker<ValidateResult>('validate', { file: sourceFile }, updateProgress);
    setResult(result);
  });
});

convertButton.addEventListener('click', async () => {
  const sourceFile = sourceFileInput.files?.[0];
  if (!sourceFile) {
    setError('请先选择 source zip');
    return;
  }

  const request: ConvertRequest = {
    inputFile: sourceFile,
    templateFile: templateFileInput.files?.[0],
    from: fromSelect.value as ConvertRequest['from'],
    to: toSelect.value as ConvertRequest['to'],
    redactSecrets: redactCheckbox.checked,
  };

  await withBusy(async () => {
    const result = await sendWorker<ConvertResult>('convert', { request }, updateProgress);
    downloadBlob(result.outputBlob, `converted-${request.to}-${Date.now()}.zip`);
    setResult({
      downloaded: true,
      fileName: `converted-${request.to}-${Date.now()}.zip`,
      manifest: result.manifest,
    });
  });
});

clearButton.addEventListener('click', () => {
  resultPre.textContent = '{}';
  updateProgress({ stage: 'idle', progress: 0, message: '等待操作' });
});

function sendWorker<T>(command: WorkerCommand, payload: unknown, onProgress?: (event: ProgressEvent) => void): Promise<T> {
  const requestId = crypto.randomUUID();
  const envelope: WorkerRequestEnvelope = {
    requestId,
    command,
    payload,
  };

  return new Promise<T>((resolve, reject) => {
    pending.set(requestId, {
      resolve,
      reject,
      onProgress,
    });
    worker.postMessage(envelope);
  });
}

async function withBusy(action: () => Promise<void>): Promise<void> {
  setBusy(true);
  try {
    await action();
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error));
  } finally {
    setBusy(false);
  }
}

function setBusy(busy: boolean): void {
  inspectButton.disabled = busy;
  validateButton.disabled = busy;
  convertButton.disabled = busy;
}

function updateProgress(event: ProgressEvent): void {
  progressStage.textContent = event.stage;
  progressPercent.textContent = `${Math.max(0, Math.min(100, Math.round(event.progress)))}%`;
  progressBar.style.width = `${Math.max(0, Math.min(100, event.progress))}%`;
  progressMessage.textContent = event.message ?? '';
}

function setResult(value: unknown): void {
  resultPre.textContent = JSON.stringify(value, null, 2);
}

function setError(message: string): void {
  setResult({ error: message });
  updateProgress({ stage: 'error', progress: 0, message });
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

function must<T extends Element>(selector: string): T {
  const value = document.querySelector<T>(selector);
  if (!value) {
    throw new Error(`missing element: ${selector}`);
  }
  return value;
}

updateProgress({ stage: 'idle', progress: 0, message: '等待操作' });
