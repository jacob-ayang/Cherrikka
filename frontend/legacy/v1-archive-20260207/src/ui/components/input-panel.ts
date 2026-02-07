export interface InputPanelRefs {
  sourceFile: HTMLInputElement;
  templateFile: HTMLInputElement;
  fromSelect: HTMLSelectElement;
  toSelect: HTMLSelectElement;
  redactSecrets: HTMLInputElement;
}

export function createInputPanel(): { root: HTMLElement; refs: InputPanelRefs } {
  const root = document.createElement('section');
  root.className = 'tui-panel';
  root.innerHTML = `
    <header class="panel-header">INPUT</header>
    <div class="panel-body">
      <label class="field-label" for="source-file">SOURCE ZIP</label>
      <input id="source-file" class="tui-input" type="file" accept=".zip,application/zip" />

      <label class="field-label" for="template-file">TEMPLATE ZIP (OPTIONAL)</label>
      <input id="template-file" class="tui-input" type="file" accept=".zip,application/zip" />

      <div class="field-grid">
        <div>
          <label class="field-label" for="from-select">FROM</label>
          <select id="from-select" class="tui-input">
            <option value="auto">auto</option>
            <option value="cherry">cherry</option>
            <option value="rikka">rikka</option>
          </select>
        </div>
        <div>
          <label class="field-label" for="to-select">TO</label>
          <select id="to-select" class="tui-input">
            <option value="rikka">rikka</option>
            <option value="cherry">cherry</option>
          </select>
        </div>
      </div>

      <label class="inline-toggle" for="redact-secrets">
        <input id="redact-secrets" type="checkbox" />
        <span>REDACT SECRETS</span>
      </label>
    </div>
  `;

  return {
    root,
    refs: {
      sourceFile: must<HTMLInputElement>(root, '#source-file'),
      templateFile: must<HTMLInputElement>(root, '#template-file'),
      fromSelect: must<HTMLSelectElement>(root, '#from-select'),
      toSelect: must<HTMLSelectElement>(root, '#to-select'),
      redactSecrets: must<HTMLInputElement>(root, '#redact-secrets'),
    },
  };
}

function must<T extends Element>(root: ParentNode, selector: string): T {
  const node = root.querySelector<T>(selector);
  if (!node) {
    throw new Error(`missing input panel element: ${selector}`);
  }
  return node;
}
