export interface ResultPanelRefs {
  clearButton: HTMLButtonElement;
  copyButton: HTMLButtonElement;
  output: HTMLPreElement;
}

export function createResultPanel(): { root: HTMLElement; refs: ResultPanelRefs } {
  const root = document.createElement('section');
  root.className = 'tui-panel tui-result-panel';
  root.innerHTML = `
    <header class="panel-header panel-header-row">
      <span>RESULT</span>
      <span class="header-actions">
        <button id="btn-copy" class="tui-button tui-button-small">COPY JSON</button>
        <button id="btn-clear" class="tui-button tui-button-small">CLEAR</button>
      </span>
    </header>
    <div class="panel-body">
      <details class="result-details" open>
        <summary>OUTPUT JSON</summary>
        <pre id="result-json" class="result-pre">{}</pre>
      </details>
    </div>
  `;

  return {
    root,
    refs: {
      clearButton: must<HTMLButtonElement>(root, '#btn-clear'),
      copyButton: must<HTMLButtonElement>(root, '#btn-copy'),
      output: must<HTMLPreElement>(root, '#result-json'),
    },
  };
}

function must<T extends Element>(root: ParentNode, selector: string): T {
  const node = root.querySelector<T>(selector);
  if (!node) {
    throw new Error(`missing result panel element: ${selector}`);
  }
  return node;
}
