import type { I18nText } from '../../i18n/types';

export interface ActionPanelHandle {
  root: HTMLElement;
  redactInput: HTMLInputElement;
  convertButton: HTMLButtonElement;
  setBusy: (busy: boolean) => void;
}

export function createActionPanel(text: I18nText): ActionPanelHandle {
  const root = document.createElement('section');
  root.className = 'panel';

  const row = document.createElement('div');
  row.className = 'action-row';

  const redactLabel = document.createElement('label');
  redactLabel.className = 'checkbox';

  const redactInput = document.createElement('input');
  redactInput.type = 'checkbox';
  redactInput.checked = false;

  const redactText = document.createElement('span');
  redactText.textContent = text.redactSecrets;

  redactLabel.append(redactInput, redactText);

  const convertButton = document.createElement('button');
  convertButton.type = 'button';
  convertButton.className = 'btn-primary';
  convertButton.textContent = text.convert;

  row.append(redactLabel, convertButton);
  root.appendChild(row);

  const setBusy = (busy: boolean) => {
    convertButton.disabled = busy;
    convertButton.textContent = busy ? text.converting : text.convert;
  };

  return { root, redactInput, convertButton, setBusy };
}
