import type { ConfigPrecedence, DetectResult, DetectResultFormat, SourceFormat, TargetFormat } from '../engine/ir/types';
import { WorkerClient } from '../lib/worker-client';
import { en } from '../i18n/en';
import { zh } from '../i18n/zh';
import type { AppLang, AppTheme, I18nText } from '../i18n/types';
import { createActionPanel } from './components/action-panel';
import { createFormatPanel } from './components/format-panel';
import { createProgressPanel } from './components/progress-panel';
import { createResultPanel } from './components/result-panel';
import { createUploadPanel } from './components/upload-panel';

interface DetectedFileInfo {
  format: DetectResultFormat;
  hints: string[];
  warnings: string[];
}

interface AppState {
  lang: AppLang;
  theme: AppTheme;
  sourceFiles: File[];
  sourceFormat: SourceFormat;
  targetFormat: TargetFormat;
  configPrecedence: ConfigPrecedence;
  configSourceIndex: number;
  detected: DetectedFileInfo[];
  redactSecrets: boolean;
  busy: boolean;
}

const worker = new WorkerClient();

export function mountApp(container: HTMLElement): void {
  const state: AppState = {
    lang: detectInitialLang(),
    theme: detectInitialTheme(),
    sourceFiles: [],
    sourceFormat: 'auto',
    targetFormat: 'rikka',
    configPrecedence: 'latest',
    configSourceIndex: 1,
    detected: [],
    redactSecrets: false,
    busy: false,
  };

  const render = () => {
    const text = i18n(state.lang);
    container.innerHTML = '';
    document.body.setAttribute('data-theme', state.theme);

    const shell = document.createElement('main');
    shell.className = 'shell';

    const topbar = createTopbar(state, text, render);
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

    format.sourceSelect.value = state.sourceFormat;
    format.targetSelect.value = state.targetFormat;
    format.precedenceSelect.value = state.configPrecedence;
    format.setSourceIndexOptions(state.sourceFiles.length, state.configSourceIndex);
    format.sourceIndexSelect.disabled = state.configPrecedence !== 'source';
    actions.redactInput.checked = state.redactSecrets;
    actions.setBusy(state.busy);

    updateSelectedMeta(upload.fileMeta, state, text);
    renderFileList(upload.fileList, state, text, async (index) => {
      if (state.busy) return;
      const next = state.sourceFiles.filter((_, i) => i !== index);
      await applySelectedFiles(state, next, text);
      render();
    });

    const setFilesFromInput = async (fileList: FileList | null) => {
      const next = Array.from(fileList ?? []).filter((file) => file.name.toLowerCase().endsWith('.zip'));
      await applySelectedFiles(state, next, text);
      render();
    };

    upload.fileInput.addEventListener('change', async () => {
      await setFilesFromInput(upload.fileInput.files);
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
      const dropped = Array.from(event.dataTransfer?.files ?? []).filter((file) => file.name.toLowerCase().endsWith('.zip'));
      if (dropped.length === 0) return;
      const merged = dedupeFiles([...state.sourceFiles, ...dropped]);
      await applySelectedFiles(state, merged, text);
      render();
    });

    format.sourceSelect.addEventListener('change', async () => {
      state.sourceFormat = format.sourceSelect.value as SourceFormat;
      await refreshDetections(state, text);
      render();
    });

    format.targetSelect.addEventListener('change', () => {
      state.targetFormat = format.targetSelect.value as TargetFormat;
    });

    format.precedenceSelect.addEventListener('change', () => {
      state.configPrecedence = format.precedenceSelect.value as ConfigPrecedence;
      if (state.configPrecedence !== 'source') {
        format.sourceIndexSelect.disabled = true;
      } else {
        format.sourceIndexSelect.disabled = false;
      }
    });

    format.sourceIndexSelect.addEventListener('change', () => {
      state.configSourceIndex = Number(format.sourceIndexSelect.value || '1');
    });

    actions.redactInput.addEventListener('change', () => {
      state.redactSecrets = actions.redactInput.checked;
    });

    actions.convertButton.addEventListener('click', async () => {
      if (state.sourceFiles.length === 0) {
        progress.setError(text.noSourceFile);
        return;
      }
      if (state.sourceFiles.length > 1 && state.sourceFormat !== 'auto') {
        progress.setError(text.multiSourceAutoOnly);
        return;
      }

      state.busy = true;
      actions.setBusy(true);
      result.clear();
      progress.setIdle();

      try {
        const converted = await worker.convert(
          {
            inputFiles: state.sourceFiles,
            from: state.sourceFormat,
            to: state.targetFormat,
            redactSecrets: state.redactSecrets,
            configPrecedence: state.configPrecedence,
            configSourceIndex: state.configSourceIndex,
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

function createTopbar(state: AppState, text: I18nText, rerender: () => void): HTMLElement {
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
    rerender();
  });
  const themeLightBtn = document.createElement('button');
  themeLightBtn.type = 'button';
  themeLightBtn.className = `theme-btn${state.theme === 'light' ? ' active' : ''}`;
  themeLightBtn.textContent = text.themeLight;
  themeLightBtn.addEventListener('click', () => {
    state.theme = 'light';
    persistTheme(state.theme);
    rerender();
  });
  themeToggle.append(themeDarkBtn, themeLightBtn);

  const langBtn = document.createElement('button');
  langBtn.type = 'button';
  langBtn.className = 'lang-toggle';
  langBtn.textContent = `${text.language}: ${state.lang.toUpperCase()}`;
  langBtn.addEventListener('click', () => {
    state.lang = state.lang === 'zh' ? 'en' : 'zh';
    rerender();
  });

  controls.append(themeLabel, themeToggle, langBtn);
  topbar.append(brand, controls);
  return topbar;
}

async function applySelectedFiles(state: AppState, files: File[], text: I18nText): Promise<void> {
  state.sourceFiles = dedupeFiles(files);
  state.configSourceIndex = Math.min(Math.max(state.configSourceIndex, 1), Math.max(1, state.sourceFiles.length));
  await refreshDetections(state, text);
}

async function refreshDetections(state: AppState, text: I18nText): Promise<void> {
  if (state.sourceFiles.length === 0) {
    state.detected = [];
    return;
  }
  if (state.sourceFormat !== 'auto') {
    state.detected = state.sourceFiles.map(() => ({
      format: state.sourceFormat,
      hints: [],
      warnings: [],
    }));
    return;
  }
  const detected: DetectedFileInfo[] = [];
  for (const file of state.sourceFiles) {
    try {
      const result: DetectResult = await worker.detect(file);
      detected.push({
        format: result.sourceFormat,
        hints: result.hints,
        warnings: result.warnings,
      });
    } catch {
      detected.push({
        format: 'unknown',
        hints: [],
        warnings: [text.detectFailed],
      });
    }
  }
  state.detected = detected;
}

function renderFileList(
  container: HTMLElement,
  state: AppState,
  text: I18nText,
  onRemove: (index: number) => void,
): void {
  container.innerHTML = '';
  if (state.sourceFiles.length === 0) {
    return;
  }
  state.sourceFiles.forEach((file, index) => {
    const row = document.createElement('div');
    row.className = 'file-row';

    const info = document.createElement('div');
    info.className = 'file-row-info';
    const kb = Math.max(1, Math.round(file.size / 1024));
    const detect = state.detected[index];
    const details = detect ? `${text.detectSource}: ${detect.format}` : `${text.detectSource}: unknown`;
    info.textContent = `${index + 1}. ${file.name} (${kb} KB) · ${details}`;

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn-secondary btn-remove';
    removeBtn.textContent = text.sourceFileRemove;
    removeBtn.addEventListener('click', () => void onRemove(index));
    row.append(info, removeBtn);

    if (detect && (detect.hints.length > 0 || detect.warnings.length > 0)) {
      const meta = document.createElement('div');
      meta.className = 'file-row-meta';
      const chunks: string[] = [];
      if (detect.hints.length > 0) chunks.push(`hints=${detect.hints.join(', ')}`);
      if (detect.warnings.length > 0) chunks.push(`warnings=${detect.warnings.join(', ')}`);
      meta.textContent = chunks.join(' · ');
      container.append(row, meta);
      return;
    }
    container.appendChild(row);
  });
}

function updateSelectedMeta(target: HTMLElement, state: AppState, text: I18nText): void {
  if (state.sourceFiles.length === 0) {
    target.textContent = text.sourceFileNone;
    return;
  }
  target.textContent = `${text.sourceFilesCount}: ${state.sourceFiles.length}`;
}

function dedupeFiles(files: File[]): File[] {
  const seen = new Set<string>();
  const out: File[] = [];
  for (const file of files) {
    const key = `${file.name}:${file.size}:${file.lastModified}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(file);
  }
  return out;
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
