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
  title.textContent = text.progress;

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

  bar.appendChild(fill);
  root.append(title, status, bar, log);

  const setIdle = () => {
    status.textContent = text.statusIdle;
    fill.style.width = '0%';
    log.textContent = '';
  };

  const setEvent = (event: ProgressEvent) => {
    status.textContent = `${event.stage} · ${Math.max(0, Math.min(100, event.progress))}%`;
    fill.style.width = `${Math.max(0, Math.min(100, event.progress))}%`;
    log.textContent = event.message;
  };

  const setError = (message: string) => {
    status.textContent = text.statusFailed;
    log.textContent = `${text.errorPrefix}: ${message}`;
  };

  const setDone = () => {
    status.textContent = text.statusDone;
    fill.style.width = '100%';
  };

  return { root, setIdle, setEvent, setError, setDone };
}
