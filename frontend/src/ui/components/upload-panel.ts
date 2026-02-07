import type { I18nText } from '../../i18n/types';

export interface UploadPanelHandle {
  root: HTMLElement;
  fileInput: HTMLInputElement;
}

export function createUploadPanel(text: I18nText): UploadPanelHandle {
  const root = document.createElement('section');
  root.className = 'panel';

  const title = document.createElement('h2');
  title.className = 'panel-title';
  title.textContent = text.sourceFileLabel;

  const hint = document.createElement('p');
  hint.className = 'panel-hint';
  hint.textContent = text.sourceFileHint;

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.zip,application/zip';
  fileInput.className = 'file-input';

  root.append(title, hint, fileInput);
  return { root, fileInput };
}
