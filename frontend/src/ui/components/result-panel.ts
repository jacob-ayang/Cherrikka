import type { Manifest } from '../../engine/ir/types';
import type { I18nText } from '../../i18n/types';

export interface ResultPanelHandle {
  root: HTMLElement;
  clear: () => void;
  setResult: (blob: Blob, fileName: string, manifest: Manifest) => void;
}

export function createResultPanel(text: I18nText): ResultPanelHandle {
  const root = document.createElement('section');
  root.className = 'panel';

  const header = document.createElement('div');
  header.className = 'result-header';

  const download = document.createElement('a');
  download.className = 'btn-secondary disabled';
  download.textContent = text.download;
  download.href = '#';
  download.download = '';

  const pre = document.createElement('pre');
  pre.className = 'json';
  pre.textContent = '{}';

  header.appendChild(download);
  root.append(header, pre);

  let objectUrl = '';

  const clear = () => {
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = '';
    }
    download.classList.add('disabled');
    download.href = '#';
    download.download = '';
    pre.textContent = '{}';
  };

  const setResult = (blob: Blob, fileName: string, manifest: Manifest) => {
    clear();
    objectUrl = URL.createObjectURL(blob);
    download.href = objectUrl;
    download.download = fileName;
    download.classList.remove('disabled');
    pre.textContent = JSON.stringify(manifest, null, 2);
  };

  return { root, clear, setResult };
}
