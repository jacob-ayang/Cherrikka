import type { ProgressEvent } from '../../engine/ir/types';
import type { I18nText } from '../../i18n/types';

export interface ProgressPanelHandle {
  root: HTMLElement;
  setIdle: () => void;
  setEvent: (event: ProgressEvent) => void;
  setError: (message: string) => void;
  setDone: () => void;
}

export function createProgressPanel(text: I18nText): ProgressPanelHandle {
  const root = document.createElement('section');
  root.className = 'panel';

  const title = document.createElement('h2');
  title.className = 'panel-title';
  title.textContent = text.sectionProgress;

  const status = document.createElement('div');
  status.className = 'status';
  status.textContent = text.statusIdle;

  const bar = document.createElement('div');
  bar.className = 'progress-bar';

  const fill = document.createElement('div');
  fill.className = 'progress-fill';
  fill.style.width = '0%';

  const log = document.createElement('div');
  log.className = 'log';
  const lines: string[] = [];

  bar.appendChild(fill);
  root.append(title, status, bar, log);

  const setIdle = () => {
    status.textContent = text.statusIdle;
    fill.style.width = '0%';
    lines.length = 0;
    log.textContent = '';
  };

  const setEvent = (event: ProgressEvent) => {
    const pct = Math.max(0, Math.min(100, event.progress));
    const prefix = event.level === 'warning' ? text.warningPrefix : event.level === 'error' ? text.errorPrefix : text.progress;
    status.textContent = `${text.statusRunning} · ${event.stage} · ${pct}%`;
    fill.style.width = `${pct}%`;
    lines.unshift(`[${prefix}] ${event.message}`);
    if (lines.length > 8) lines.length = 8;
    log.textContent = lines.join('\n');
  };

  const setError = (message: string) => {
    status.textContent = text.statusFailed;
    lines.unshift(`[${text.errorPrefix}] ${message}`);
    if (lines.length > 8) lines.length = 8;
    log.textContent = lines.join('\n');
  };

  const setDone = () => {
    status.textContent = text.statusDone;
    fill.style.width = '100%';
  };

  return { root, setIdle, setEvent, setError, setDone };
}
