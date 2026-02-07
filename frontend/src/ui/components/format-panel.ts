import type { SourceFormat, TargetFormat } from '../../engine/ir/types';
import type { I18nText } from '../../i18n/types';

export interface FormatPanelHandle {
  root: HTMLElement;
  sourceSelect: HTMLSelectElement;
  targetValue: HTMLElement;
  setTarget: (target: TargetFormat | null) => void;
}

export function createFormatPanel(text: I18nText): FormatPanelHandle {
  const root = document.createElement('section');
  root.className = 'panel';

  const row = document.createElement('div');
  row.className = 'format-row';

  const sourceLabel = document.createElement('label');
  sourceLabel.className = 'field';
  sourceLabel.textContent = text.sourceFormat;

  const sourceSelect = document.createElement('select');
  sourceSelect.className = 'select';
  sourceSelect.name = 'source-format';
  addOption(sourceSelect, 'auto', text.sourceFormatAuto);
  addOption(sourceSelect, 'cherry', text.sourceFormatCherry);
  addOption(sourceSelect, 'rikka', text.sourceFormatRikka);

  sourceLabel.appendChild(sourceSelect);

  const targetLabel = document.createElement('div');
  targetLabel.className = 'field';
  targetLabel.textContent = text.targetFormat;

  const targetValue = document.createElement('div');
  targetValue.className = 'target-badge';
  targetValue.textContent = text.targetPending;

  targetLabel.appendChild(targetValue);
  row.append(sourceLabel, targetLabel);
  root.appendChild(row);

  const setTarget = (target: TargetFormat | null) => {
    if (!target) {
      targetValue.textContent = text.targetPending;
      return;
    }
    targetValue.textContent = target === 'cherry' ? text.targetCherry : text.targetRikka;
  };

  return { root, sourceSelect, targetValue, setTarget };
}

function addOption(select: HTMLSelectElement, value: SourceFormat, label: string): void {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = label;
  select.appendChild(option);
}
