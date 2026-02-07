import type { Manifest } from '../../engine/ir/types';
import type { I18nText } from '../../i18n/types';

export interface ResultPanelHandle {
  root: HTMLElement;
  clear: () => void;
  setResult: (blob: Blob, fileName: string, manifest: Manifest, warnings: string[], errors: string[]) => void;
}

export function createResultPanel(text: I18nText): ResultPanelHandle {
  const root = document.createElement('section');
  root.className = 'panel';

  const title = document.createElement('h2');
  title.className = 'panel-title';
  title.textContent = text.sectionResult;

  const header = document.createElement('div');
  header.className = 'result-header';

  const download = document.createElement('a');
  download.className = 'btn-secondary disabled';
  download.textContent = text.download;
  download.href = '#';
  download.download = '';

  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'btn-secondary';
  copy.textContent = text.copyJson;

  const pre = document.createElement('pre');
  pre.className = 'json';
  pre.textContent = '{}';

  const warningsBlock = document.createElement('div');
  warningsBlock.className = 'result-list';
  const errorsBlock = document.createElement('div');
  errorsBlock.className = 'result-list';

  header.append(download, copy);
  root.append(title, header, errorsBlock, warningsBlock, pre);

  let objectUrl = '';
  let currentManifest = '{}';

  const clear = () => {
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = '';
    }
    download.classList.add('disabled');
    download.href = '#';
    download.download = '';
    warningsBlock.textContent = '';
    errorsBlock.textContent = '';
    copy.textContent = text.copyJson;
    pre.textContent = '{}';
    currentManifest = '{}';
  };

  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(currentManifest);
      copy.textContent = text.copyDone;
      setTimeout(() => {
        copy.textContent = text.copyJson;
      }, 1000);
    } catch {
      copy.textContent = text.errorPrefix;
      setTimeout(() => {
        copy.textContent = text.copyJson;
      }, 1000);
    }
  });

  const setResult = (blob: Blob, fileName: string, manifest: Manifest, warnings: string[], errors: string[]) => {
    clear();
    objectUrl = URL.createObjectURL(blob);
    download.href = objectUrl;
    download.download = fileName;
    download.classList.remove('disabled');
    currentManifest = JSON.stringify(manifest, null, 2);
    pre.textContent = currentManifest;

    errorsBlock.textContent = errors.length
      ? `${text.convertErrors}: ${errors.join(' | ')}`
      : '';
    warningsBlock.textContent = warnings.length
      ? `${text.convertWarnings}: ${warnings.join(' | ')}`
      : '';
  };

  return { root, clear, setResult };
}
