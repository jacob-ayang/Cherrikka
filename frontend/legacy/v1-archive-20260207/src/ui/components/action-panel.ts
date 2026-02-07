export interface ActionPanelRefs {
  inspectButton: HTMLButtonElement;
  validateButton: HTMLButtonElement;
  convertButton: HTMLButtonElement;
  stage: HTMLElement;
  percent: HTMLElement;
  bar: HTMLElement;
  message: HTMLElement;
  log: HTMLElement;
}

export function createActionPanel(): { root: HTMLElement; refs: ActionPanelRefs } {
  const root = document.createElement('section');
  root.className = 'tui-panel';
  root.innerHTML = `
    <header class="panel-header">ACTIONS</header>
    <div class="panel-body panel-actions">
      <button id="btn-inspect" class="tui-button">[1] INSPECT</button>
      <button id="btn-validate" class="tui-button">[2] VALIDATE</button>
      <button id="btn-convert" class="tui-button tui-button-primary">[3] CONVERT + DOWNLOAD</button>

      <div class="tui-progress">
        <div class="progress-meta">
          <span id="progress-stage">IDLE</span>
          <span id="progress-percent">0%</span>
        </div>
        <div class="progress-track">
          <div id="progress-bar" class="progress-bar"></div>
        </div>
        <p id="progress-message" class="progress-message">READY</p>
      </div>

      <div class="tui-log-wrap">
        <div class="log-title">LOG</div>
        <pre id="progress-log" class="tui-log"></pre>
      </div>
    </div>
  `;

  return {
    root,
    refs: {
      inspectButton: must<HTMLButtonElement>(root, '#btn-inspect'),
      validateButton: must<HTMLButtonElement>(root, '#btn-validate'),
      convertButton: must<HTMLButtonElement>(root, '#btn-convert'),
      stage: must<HTMLElement>(root, '#progress-stage'),
      percent: must<HTMLElement>(root, '#progress-percent'),
      bar: must<HTMLElement>(root, '#progress-bar'),
      message: must<HTMLElement>(root, '#progress-message'),
      log: must<HTMLElement>(root, '#progress-log'),
    },
  };
}

function must<T extends Element>(root: ParentNode, selector: string): T {
  const node = root.querySelector<T>(selector);
  if (!node) {
    throw new Error(`missing action panel element: ${selector}`);
  }
  return node;
}
