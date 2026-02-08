import type { I18nText } from '../../i18n/types';

export interface UploadPanelHandle {
  root: HTMLElement;
  fileInput: HTMLInputElement;
  dropZone: HTMLElement;
  fileMeta: HTMLElement;
  fileList: HTMLElement;
}

export function createUploadPanel(text: I18nText): UploadPanelHandle {
  const root = document.createElement('section');
  root.className = 'panel';

  const title = document.createElement('h2');
  title.className = 'panel-title';
  title.textContent = text.sectionSource;

  const hint = document.createElement('p');
  hint.className = 'panel-hint';
  hint.textContent = `${text.sourceFileHint} · ${text.sourceDropHint}`;

  const dropZone = document.createElement('label');
  dropZone.className = 'drop-zone';

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.multiple = true;
  fileInput.accept = '.zip,application/zip';
  fileInput.className = 'file-input';
  fileInput.setAttribute('aria-label', text.sourceFileLabel);

  const fileMeta = document.createElement('div');
  fileMeta.className = 'file-name';
  fileMeta.textContent = text.sourceFileNone;

  const fileList = document.createElement('div');
  fileList.className = 'file-list';

  dropZone.append(fileInput, fileMeta);
  root.append(title, hint, dropZone, fileList);
  return { root, fileInput, dropZone, fileMeta, fileList };
}
