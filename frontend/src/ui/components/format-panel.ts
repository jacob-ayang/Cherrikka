import type { ConfigPrecedence, SourceFormat, TargetFormat } from '../../engine/ir/types';
import type { I18nText } from '../../i18n/types';

export interface FormatPanelHandle {
  root: HTMLElement;
  sourceSelect: HTMLSelectElement;
  targetSelect: HTMLSelectElement;
  precedenceSelect: HTMLSelectElement;
  sourceIndexSelect: HTMLSelectElement;
  setSourceIndexOptions: (count: number, selectedIndex: number) => void;
}

export function createFormatPanel(text: I18nText): FormatPanelHandle {
  const root = document.createElement('section');
  root.className = 'panel';

  const title = document.createElement('h2');
  title.className = 'panel-title';
  title.textContent = text.sectionDirection;

  const row = document.createElement('div');
  row.className = 'format-row';

  const sourceLabel = document.createElement('label');
  sourceLabel.className = 'field';
  sourceLabel.textContent = text.sourceFormat;

  const sourceSelect = document.createElement('select');
  sourceSelect.className = 'select';
  sourceSelect.name = 'source-format';
  addSourceOption(sourceSelect, 'auto', text.sourceFormatAuto);
  addSourceOption(sourceSelect, 'cherry', text.sourceFormatCherry);
  addSourceOption(sourceSelect, 'rikka', text.sourceFormatRikka);
  sourceLabel.appendChild(sourceSelect);

  const targetLabel = document.createElement('label');
  targetLabel.className = 'field';
  targetLabel.textContent = text.targetFormat;

  const targetSelect = document.createElement('select');
  targetSelect.className = 'select';
  targetSelect.name = 'target-format';
  addTargetOption(targetSelect, 'cherry', text.targetCherry);
  addTargetOption(targetSelect, 'rikka', text.targetRikka);
  targetLabel.appendChild(targetSelect);

  const precedenceLabel = document.createElement('label');
  precedenceLabel.className = 'field';
  precedenceLabel.textContent = text.configPrecedence;

  const precedenceSelect = document.createElement('select');
  precedenceSelect.className = 'select';
  precedenceSelect.name = 'config-precedence';
  addPrecedenceOption(precedenceSelect, 'latest', text.configPrecedenceLatest);
  addPrecedenceOption(precedenceSelect, 'first', text.configPrecedenceFirst);
  addPrecedenceOption(precedenceSelect, 'target', text.configPrecedenceTarget);
  addPrecedenceOption(precedenceSelect, 'source', text.configPrecedenceSource);
  precedenceLabel.appendChild(precedenceSelect);

  const sourceIndexLabel = document.createElement('label');
  sourceIndexLabel.className = 'field';
  sourceIndexLabel.textContent = text.configSourceIndex;

  const sourceIndexSelect = document.createElement('select');
  sourceIndexSelect.className = 'select';
  sourceIndexSelect.name = 'config-source-index';
  sourceIndexLabel.appendChild(sourceIndexSelect);

  row.append(sourceLabel, targetLabel, precedenceLabel, sourceIndexLabel);
  root.append(title, row);

  const setSourceIndexOptions = (count: number, selectedIndex: number): void => {
    sourceIndexSelect.innerHTML = '';
    const max = Math.max(1, count);
    for (let i = 1; i <= max; i += 1) {
      const option = document.createElement('option');
      option.value = String(i);
      option.textContent = String(i);
      sourceIndexSelect.appendChild(option);
    }
    const safeSelected = Math.min(Math.max(selectedIndex, 1), max);
    sourceIndexSelect.value = String(safeSelected);
  };

  return { root, sourceSelect, targetSelect, precedenceSelect, sourceIndexSelect, setSourceIndexOptions };
}

function addSourceOption(select: HTMLSelectElement, value: SourceFormat, label: string): void {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = label;
  select.appendChild(option);
}

function addTargetOption(select: HTMLSelectElement, value: TargetFormat, label: string): void {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = label;
  select.appendChild(option);
}

function addPrecedenceOption(select: HTMLSelectElement, value: ConfigPrecedence, label: string): void {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = label;
  select.appendChild(option);
}
