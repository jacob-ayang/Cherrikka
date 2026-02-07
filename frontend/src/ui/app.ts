import type { DetectResultFormat, SourceFormat } from '../engine/ir/types';
import { resolveTargetFormat } from '../lib/format';
import { WorkerClient } from '../lib/worker-client';
import { en } from '../i18n/en';
import { zh } from '../i18n/zh';
import type { AppLang, AppTheme, I18nText } from '../i18n/types';
import { createActionPanel } from './components/action-panel';
import { createFormatPanel } from './components/format-panel';
import { createProgressPanel } from './components/progress-panel';
import { createResultPanel } from './components/result-panel';
import { createUploadPanel } from './components/upload-panel';

interface AppState {
  lang: AppLang;
  theme: AppTheme;
  sourceFile: File | null;
  sourceFormat: SourceFormat;
  detectedFormat: DetectResultFormat;
  detectedHints: string[];
  detectedWarnings: string[];
  redactSecrets: boolean;
  busy: boolean;
}

const worker = new WorkerClient();

export function mountApp(container: HTMLElement): void {
  const state: AppState = {
    lang: detectInitialLang(),
    theme: detectInitialTheme(),
    sourceFile: null,
    sourceFormat: 'auto',
    detectedFormat: 'unknown',
    detectedHints: [],
    detectedWarnings: [],
    redactSecrets: false,
    busy: false,
  };

  const render = () => {
    const text = i18n(state.lang);
    container.innerHTML = '';
    document.body.setAttribute('data-theme', state.theme);

    const shell = document.createElement('main');
    shell.className = 'shell';

    const topbar = document.createElement('header');
    topbar.className = 'topbar';

    const brand = document.createElement('div');
    brand.className = 'app-brand';

    const icon = document.createElement('img');
    icon.className = 'app-icon';
    icon.src = '/favicon.svg';
    icon.alt = 'Cherrikka Icon';

    const titleWrap = document.createElement('div');
    const title = document.createElement('h1');
    title.className = 'title';
    title.textContent = text.appTitle;
    const subtitle = document.createElement('p');
    subtitle.className = 'subtitle';
    subtitle.textContent = text.appSubtitle;
    titleWrap.append(title, subtitle);
    brand.append(icon, titleWrap);

    const controls = document.createElement('div');
    controls.className = 'top-controls';

    const themeLabel = document.createElement('div');
    themeLabel.className = 'control-label';
    themeLabel.textContent = text.theme;

    const themeToggle = document.createElement('div');
    themeToggle.className = 'theme-toggle';

    const themeDarkBtn = document.createElement('button');
    themeDarkBtn.type = 'button';
    themeDarkBtn.className = `theme-btn${state.theme === 'dark' ? ' active' : ''}`;
    themeDarkBtn.textContent = text.themeDark;
    themeDarkBtn.addEventListener('click', () => {
      state.theme = 'dark';
      persistTheme(state.theme);
      render();
    });

    const themeLightBtn = document.createElement('button');
    themeLightBtn.type = 'button';
    themeLightBtn.className = `theme-btn${state.theme === 'light' ? ' active' : ''}`;
    themeLightBtn.textContent = text.themeLight;
    themeLightBtn.addEventListener('click', () => {
      state.theme = 'light';
      persistTheme(state.theme);
      render();
    });

    themeToggle.append(themeDarkBtn, themeLightBtn);

    const langBtn = document.createElement('button');
    langBtn.type = 'button';
    langBtn.className = 'lang-toggle';
    langBtn.textContent = `${text.language}: ${state.lang.toUpperCase()}`;
    langBtn.addEventListener('click', () => {
      state.lang = state.lang === 'zh' ? 'en' : 'zh';
      render();
    });

    controls.append(themeLabel, themeToggle, langBtn);
    topbar.append(brand, controls);

    const grid = document.createElement('section');
    grid.className = 'grid';

    const upload = createUploadPanel(text);
    const format = createFormatPanel(text);
    const actions = createActionPanel(text);
    const progress = createProgressPanel(text);
    const result = createResultPanel(text);

    upload.root.classList.add('panel-source');
    format.root.classList.add('panel-direction');
    actions.root.classList.add('panel-options');
    progress.root.classList.add('panel-progress');
    result.root.classList.add('panel-result');

    updateSelectedMeta(upload.fileMeta, state, text);

    format.sourceSelect.value = state.sourceFormat;
    format.setTarget(resolveTargetFormat(state.sourceFormat, state.detectedFormat));

    actions.redactInput.checked = state.redactSecrets;
    actions.setBusy(state.busy);

    const applySelectedFile = async (file: File | null) => {
      state.sourceFile = file;
      state.detectedFormat = 'unknown';
      state.detectedHints = [];
      state.detectedWarnings = [];
      updateSelectedMeta(upload.fileMeta, state, text);
      result.clear();

      if (state.sourceFile && state.sourceFormat === 'auto') {
        await detectAndStore(state, state.sourceFile, text);
      }
      format.setTarget(resolveTargetFormat(state.sourceFormat, state.detectedFormat));
      updateSelectedMeta(upload.fileMeta, state, text);
    };

    upload.fileInput.addEventListener('change', async () => {
      await applySelectedFile(upload.fileInput.files?.[0] ?? null);
    });

    upload.dropZone.addEventListener('dragover', (event) => {
      event.preventDefault();
      if (state.busy) return;
      upload.dropZone.classList.add('drop-zone-active');
    });
    upload.dropZone.addEventListener('dragleave', () => {
      upload.dropZone.classList.remove('drop-zone-active');
    });
    upload.dropZone.addEventListener('drop', async (event) => {
      event.preventDefault();
      upload.dropZone.classList.remove('drop-zone-active');
      if (state.busy) return;
      const file = event.dataTransfer?.files?.[0] ?? null;
      if (!file) return;
      const dt = new DataTransfer();
      dt.items.add(file);
      upload.fileInput.files = dt.files;
      await applySelectedFile(file);
    });

    format.sourceSelect.addEventListener('change', async () => {
      state.sourceFormat = format.sourceSelect.value as SourceFormat;
      if (state.sourceFormat !== 'auto') {
        state.detectedFormat = state.sourceFormat;
        state.detectedHints = [];
        state.detectedWarnings = [];
        format.setTarget(resolveTargetFormat(state.sourceFormat, state.detectedFormat));
        updateSelectedMeta(upload.fileMeta, state, text);
        return;
      }

      if (state.sourceFile) {
        await detectAndStore(state, state.sourceFile, text);
      } else {
        state.detectedFormat = 'unknown';
        state.detectedHints = [];
        state.detectedWarnings = [];
      }
      format.setTarget(resolveTargetFormat(state.sourceFormat, state.detectedFormat));
      updateSelectedMeta(upload.fileMeta, state, text);
    });

    actions.redactInput.addEventListener('change', () => {
      state.redactSecrets = actions.redactInput.checked;
    });

    actions.convertButton.addEventListener('click', async () => {
      if (!state.sourceFile) {
        progress.setError(text.noSourceFile);
        return;
      }

      const target = resolveTargetFormat(state.sourceFormat, state.detectedFormat);
      if (!target) {
        progress.setError(text.unresolvedTarget);
        return;
      }

      state.busy = true;
      actions.setBusy(true);
      result.clear();
      progress.setIdle();

      try {
        const converted = await worker.convert(
          {
            inputFile: state.sourceFile,
            from: state.sourceFormat,
            to: target,
            redactSecrets: state.redactSecrets,
          },
          (event) => progress.setEvent(event),
        );
        result.setResult(
          converted.outputBlob,
          converted.outputName,
          converted.manifest,
          converted.warnings,
          converted.errors,
        );
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

async function detectAndStore(state: AppState, file: File, text: I18nText): Promise<void> {
  try {
    const detected = await worker.detect(file);
    state.detectedFormat = detected.sourceFormat;
    state.detectedHints = detected.hints;
    state.detectedWarnings = detected.warnings;
  } catch {
    state.detectedFormat = 'unknown';
    state.detectedHints = [];
    state.detectedWarnings = [text.detectFailed];
  }
}

function updateSelectedMeta(target: HTMLElement, state: AppState, text: I18nText): void {
  if (!state.sourceFile) {
    target.textContent = text.sourceFileNone;
    return;
  }

  const kb = Math.max(1, Math.round(state.sourceFile.size / 1024));
  const pieces = [
    `${text.sourceFileSelected}: ${state.sourceFile.name} (${kb} KB)`,
    `${text.detectSource}: ${state.detectedFormat}`,
  ];
  if (state.detectedHints.length > 0) {
    pieces.push(`hints=${state.detectedHints.join(', ')}`);
  }
  if (state.detectedWarnings.length > 0) {
    pieces.push(`warnings=${state.detectedWarnings.join(', ')}`);
  }
  target.textContent = pieces.join(' · ');
}

function detectInitialLang(): AppLang {
  const lang = navigator.language.toLowerCase();
  return lang.startsWith('zh') ? 'zh' : 'en';
}

function detectInitialTheme(): AppTheme {
  try {
    const saved = window.localStorage.getItem('cherrikka.theme');
    if (saved === 'dark' || saved === 'light') {
      return saved;
    }
  } catch {
    // ignore storage access failure
  }
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function persistTheme(theme: AppTheme): void {
  try {
    window.localStorage.setItem('cherrikka.theme', theme);
  } catch {
    // ignore storage access failure
  }
}

function i18n(lang: AppLang): I18nText {
  return lang === 'zh' ? zh : en;
}
