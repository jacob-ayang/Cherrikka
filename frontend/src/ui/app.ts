import type { DetectResultFormat, SourceFormat } from '../engine/ir/types';
import { resolveTargetFormat } from '../lib/format';
import { WorkerClient } from '../lib/worker-client';
import { en } from '../i18n/en';
import { zh } from '../i18n/zh';
import type { AppLang, I18nText } from '../i18n/types';
import { createActionPanel } from './components/action-panel';
import { createFormatPanel } from './components/format-panel';
import { createProgressPanel } from './components/progress-panel';
import { createResultPanel } from './components/result-panel';
import { createUploadPanel } from './components/upload-panel';

interface AppState {
  lang: AppLang;
  sourceFile: File | null;
  sourceFormat: SourceFormat;
  detectedFormat: DetectResultFormat;
  redactSecrets: boolean;
  busy: boolean;
}

const worker = new WorkerClient();

export function mountApp(container: HTMLElement): void {
  const state: AppState = {
    lang: detectInitialLang(),
    sourceFile: null,
    sourceFormat: 'auto',
    detectedFormat: 'unknown',
    redactSecrets: false,
    busy: false,
  };

  const render = () => {
    const text = i18n(state.lang);
    container.innerHTML = '';

    const shell = document.createElement('main');
    shell.className = 'shell';

    const topbar = document.createElement('header');
    topbar.className = 'topbar';

    const titleWrap = document.createElement('div');
    const title = document.createElement('h1');
    title.className = 'title';
    title.textContent = text.appTitle;
    const subtitle = document.createElement('p');
    subtitle.className = 'subtitle';
    subtitle.textContent = text.appSubtitle;
    titleWrap.append(title, subtitle);

    const langBtn = document.createElement('button');
    langBtn.type = 'button';
    langBtn.className = 'lang-toggle';
    langBtn.textContent = `${text.language}: ${state.lang.toUpperCase()}`;
    langBtn.addEventListener('click', () => {
      state.lang = state.lang === 'zh' ? 'en' : 'zh';
      render();
    });

    topbar.append(titleWrap, langBtn);

    const grid = document.createElement('section');
    grid.className = 'grid';

    const upload = createUploadPanel(text);
    const format = createFormatPanel(text);
    const actions = createActionPanel(text);
    const progress = createProgressPanel(text);
    const result = createResultPanel(text);

    const selected = document.createElement('div');
    selected.className = 'file-name';
    selected.textContent = state.sourceFile ? `${text.detectSource}: ${state.sourceFile.name}` : '';
    upload.root.appendChild(selected);

    format.sourceSelect.value = state.sourceFormat;
    format.setTarget(resolveTargetFormat(state.sourceFormat, state.detectedFormat));

    actions.redactInput.checked = state.redactSecrets;
    actions.setBusy(state.busy);

    upload.fileInput.addEventListener('change', async () => {
      state.sourceFile = upload.fileInput.files?.[0] ?? null;
      state.detectedFormat = 'unknown';
      selected.textContent = state.sourceFile ? `${text.detectSource}: ${state.sourceFile.name}` : '';
      result.clear();

      if (state.sourceFile && state.sourceFormat === 'auto') {
        try {
          const detected = await worker.detect(state.sourceFile);
          state.detectedFormat = detected.format;
        } catch {
          state.detectedFormat = 'unknown';
        }
      }

      format.setTarget(resolveTargetFormat(state.sourceFormat, state.detectedFormat));
    });

    format.sourceSelect.addEventListener('change', async () => {
      state.sourceFormat = format.sourceSelect.value as SourceFormat;
      if (state.sourceFormat !== 'auto') {
        state.detectedFormat = state.sourceFormat;
        format.setTarget(resolveTargetFormat(state.sourceFormat, state.detectedFormat));
        return;
      }

      if (state.sourceFile) {
        try {
          const detected = await worker.detect(state.sourceFile);
          state.detectedFormat = detected.format;
        } catch {
          state.detectedFormat = 'unknown';
        }
      } else {
        state.detectedFormat = 'unknown';
      }
      format.setTarget(resolveTargetFormat(state.sourceFormat, state.detectedFormat));
    });

    actions.redactInput.addEventListener('change', () => {
      state.redactSecrets = actions.redactInput.checked;
    });

    actions.convertButton.addEventListener('click', async () => {
      if (!state.sourceFile) {
        progress.setError('no source file selected');
        return;
      }

      const target = resolveTargetFormat(state.sourceFormat, state.detectedFormat);
      if (!target) {
        progress.setError('unable to determine target format');
        return;
      }

      state.busy = true;
      actions.setBusy(true);
      result.clear();
      progress.setIdle();

      try {
        const converted = await worker.convert(
          {
            request: {
              inputFile: state.sourceFile,
              from: state.sourceFormat,
              to: target,
              redactSecrets: state.redactSecrets,
            },
          },
          (event) => progress.setEvent(event),
        );
        result.setResult(converted.outputBlob, converted.outputName, converted.manifest);
        progress.setDone();
      } catch (error) {
        progress.setError(error instanceof Error ? error.message : String(error));
      } finally {
        state.busy = false;
        actions.setBusy(false);
      }
    });

    grid.append(upload.root, format.root, actions.root, progress.root, result.root);
    shell.append(topbar, grid);
    container.appendChild(shell);
  };

  render();
}

function detectInitialLang(): AppLang {
  const lang = navigator.language.toLowerCase();
  return lang.startsWith('zh') ? 'zh' : 'en';
}

function i18n(lang: AppLang): I18nText {
  return lang === 'zh' ? zh : en;
}
