import * as vscode from "vscode";
import {
  ModuleInfo,
  ParameterInfo,
  getModules,
  onModulesChanged,
  addModuleToDB,
  updateModuleInDB,
  deleteModuleFromDB,
  resetModulesToDefaults,
  exportModuleDB,
  importModuleDB,
  parameterNames,
} from "./moduleDatabase";

type TreeItem = ManufacturerItem | ModuleItem;

class ManufacturerItem extends vscode.TreeItem {
  constructor(public readonly manufacturer: string) {
    super(manufacturer, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = "manufacturer";
    this.iconPath = new vscode.ThemeIcon("library");
  }
}

class ModuleItem extends vscode.TreeItem {
  constructor(public readonly mod: ModuleInfo) {
    super(mod.name, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "module";
    this.description = mod.type;
    this.tooltip = `${mod.name} (${mod.manufacturer})\n${mod.type} — ${mod.description}\nInputs: ${mod.inputs.join(", ")}\nOutputs: ${mod.outputs.join(", ")}\nParameters: ${parameterNames(mod).join(", ")}`;
    this.iconPath = new vscode.ThemeIcon("circuit-board");
    this.command = {
      command: "patchbook.db.viewModule",
      title: "View Module",
      arguments: [this],
    };
  }
}

export class ModuleSidebarProvider implements vscode.TreeDataProvider<TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    onModulesChanged(() => this._onDidChangeTreeData.fire());
  }

  getTreeItem(element: TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TreeItem): TreeItem[] {
    if (!element) {
      const modules = getModules();
      const byManufacturer = new Map<string, ModuleInfo[]>();
      for (const [, mod] of modules) {
        const list = byManufacturer.get(mod.manufacturer) ?? [];
        list.push(mod);
        byManufacturer.set(mod.manufacturer, list);
      }
      return Array.from(byManufacturer.keys())
        .sort()
        .map((m) => new ManufacturerItem(m));
    }
    if (element instanceof ManufacturerItem) {
      const modules = getModules();
      const children: ModuleItem[] = [];
      for (const [, mod] of modules) {
        if (mod.manufacturer === element.manufacturer) {
          children.push(new ModuleItem(mod));
        }
      }
      return children.sort((a, b) => a.mod.name.localeCompare(b.mod.name));
    }
    return [];
  }

  viewModule(item: ModuleItem): void {
    openModuleEditor(this.context, item.mod, true);
  }

  addModule(): void {
    openModuleEditor(this.context, undefined, false);
  }

  editModule(item: ModuleItem): void {
    openModuleEditor(this.context, item.mod, false);
  }

  async deleteModule(item: ModuleItem): Promise<void> {
    const confirm = await vscode.window.showWarningMessage(
      `Delete module "${item.mod.name}"?`,
      { modal: true },
      "Delete"
    );
    if (confirm !== "Delete") { return; }
    deleteModuleFromDB(item.mod.name);
    vscode.window.showInformationMessage(`Patchbook: Deleted module "${item.mod.name}".`);
  }

  async resetDefaults(): Promise<void> {
    const confirm = await vscode.window.showWarningMessage(
      "Reset module database to defaults? All custom modules will be lost.",
      { modal: true },
      "Reset"
    );
    if (confirm !== "Reset") { return; }
    resetModulesToDefaults(this.context);
    vscode.window.showInformationMessage("Patchbook: Module database reset to defaults.");
  }

  async exportDB(): Promise<void> {
    await exportModuleDB();
  }

  async importDB(): Promise<void> {
    await importModuleDB(this.context);
  }
}

function openModuleEditor(context: vscode.ExtensionContext, existing: ModuleInfo | undefined, readOnly: boolean): void {
  const isEdit = existing !== undefined;
  const title = readOnly ? existing!.name : isEdit ? `Edit: ${existing.name}` : "New Module";

  const panel = vscode.window.createWebviewPanel(
    "patchbookModuleEditor",
    title,
    vscode.ViewColumn.One,
    { enableScripts: true }
  );

  panel.webview.html = getModuleFormHtml(panel.webview, existing, readOnly);

  let currentModule = existing;

  panel.webview.onDidReceiveMessage((msg: { type: string; data?: ModuleInfo }) => {
    if (msg.type === "save" && msg.data) {
      const mod = msg.data;
      if (currentModule) {
        updateModuleInDB(currentModule.name, mod);
        vscode.window.showInformationMessage(`Patchbook: Updated module "${mod.name}".`);
      } else {
        addModuleToDB(mod);
        vscode.window.showInformationMessage(`Patchbook: Added module "${mod.name}".`);
      }
      currentModule = mod;
      panel.title = mod.name;
      panel.webview.html = getModuleFormHtml(panel.webview, mod, true);
    } else if (msg.type === "cancel") {
      if (currentModule) {
        panel.title = currentModule.name;
        panel.webview.html = getModuleFormHtml(panel.webview, currentModule, true);
      } else {
        panel.dispose();
      }
    } else if (msg.type === "enableEdit") {
      panel.title = `Edit: ${currentModule!.name}`;
      panel.webview.html = getModuleFormHtml(panel.webview, currentModule, false);
    }
  });
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function formatParamValues(p: ParameterInfo): string {
  if (!p.type || !p.values) { return ""; }
  return escapeHtml(p.values);
}

function paramTypeLabel(type?: string): string {
  if (!type) { return "—"; }
  const map: Record<string, string> = { integer: "Integer", percentage: "Percentage", multichoice: "Multi-choice", string: "String" };
  return map[type] ?? type;
}

const SHARED_CSS = /*css*/ `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 0;
  }
  .container {
    display: grid;
    grid-template-columns: 1fr;
    max-width: 960px;
    padding: 28px 32px;
  }
  .type-badge {
    display: inline-block;
    padding: 2px 10px;
    border-radius: 12px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.3px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
  }
  .section-title {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 10px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .section-title::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--vscode-widget-border, rgba(128,128,128,0.15));
  }
  .tags {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .tag {
    display: inline-flex;
    align-items: center;
    padding: 5px 12px;
    border-radius: 4px;
    font-size: 12px;
    font-family: var(--vscode-editor-font-family, monospace);
    background: var(--vscode-textBlockQuote-background, rgba(128,128,128,0.08));
    border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.12));
    color: var(--vscode-foreground);
  }
  .empty {
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
    font-style: italic;
    opacity: 0.5;
  }
  button {
    padding: 8px 20px;
    font-family: var(--vscode-font-family);
    font-size: 13px;
    font-weight: 500;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    transition: background 0.15s;
  }
  button.primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary {
    background: transparent;
    color: var(--vscode-foreground);
    border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.3));
  }
  button.secondary:hover {
    background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.1));
  }
`;

function getModuleFormHtml(webview: vscode.Webview, existing: ModuleInfo | undefined, readOnly: boolean): string {
  const name = escapeHtml(existing?.name ?? "");
  const manufacturer = escapeHtml(existing?.manufacturer ?? "");
  const type = escapeHtml(existing?.type ?? "");
  const description = escapeHtml(existing?.description ?? "");
  const inputs = escapeHtml(existing?.inputs.join(", ") ?? "");
  const outputs = escapeHtml(existing?.outputs.join(", ") ?? "");
  const buttonLabel = existing ? "Save Changes" : "Add Module";

  const tagsHtml = (items: string[]) =>
    items.length > 0
      ? items.map((i) => `<span class="tag">${escapeHtml(i)}</span>`).join("")
      : '<span class="empty">None</span>';

  // Serialize parameters for JS
  const paramsJson = JSON.stringify(existing?.parameters ?? []);

  if (readOnly) {
    // Build parameter table rows
    const paramRows = (existing?.parameters ?? []).map((p) => {
      const vals = formatParamValues(p);
      return `<tr>
        <td class="param-name">${escapeHtml(p.name)}</td>
        <td class="param-type">${p.type ? `<span class="type-badge">${paramTypeLabel(p.type)}</span>` : '<span class="empty">—</span>'}</td>
        <td class="param-values">${vals ? `<code>${vals}</code>` : '<span class="empty">—</span>'}</td>
      </tr>`;
    }).join("");

    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-FORM_NONCE';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${name}</title>
  <style>
    ${SHARED_CSS}
    .header {
      margin-bottom: 24px;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.15));
    }
    .header h1 {
      font-size: 22px;
      font-weight: 600;
      margin-bottom: 4px;
    }
    .meta {
      display: flex;
      align-items: center;
      gap: 10px;
      color: var(--vscode-descriptionForeground);
      font-size: 13px;
    }
    .meta .sep { opacity: 0.3; }
    .description {
      margin-bottom: 24px;
      line-height: 1.6;
      opacity: 0.85;
    }
    .grid-2 {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 24px;
      margin-bottom: 24px;
    }
    .section { margin-bottom: 24px; }
    .param-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    .param-table th {
      text-align: left;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--vscode-descriptionForeground);
      padding: 6px 12px 6px 0;
      border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.15));
    }
    .param-table td {
      padding: 8px 12px 8px 0;
      border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.07));
      vertical-align: middle;
    }
    .param-table .param-name {
      font-family: var(--vscode-editor-font-family, monospace);
      font-weight: 500;
    }
    .param-table code {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
      padding: 2px 8px;
      border-radius: 3px;
      background: var(--vscode-textBlockQuote-background, rgba(128,128,128,0.08));
    }
    .actions {
      margin-top: 28px;
      padding-top: 20px;
      border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.15));
    }
  </style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>${name}</h1>
    <div class="meta">
      <span>${manufacturer}</span>
      <span class="sep">•</span>
      <span class="type-badge">${type}</span>
    </div>
  </div>
  ${description ? `<p class="description">${description}</p>` : ""}
  <div class="grid-2">
    <div class="section">
      <div class="section-title">Inputs</div>
      <div class="tags">${tagsHtml(existing?.inputs ?? [])}</div>
    </div>
    <div class="section">
      <div class="section-title">Outputs</div>
      <div class="tags">${tagsHtml(existing?.outputs ?? [])}</div>
    </div>
  </div>
  <div class="section">
    <div class="section-title">Parameters</div>
    ${(existing?.parameters ?? []).length > 0 ? `
    <table class="param-table">
      <thead><tr><th>Name</th><th>Type</th><th>Values</th></tr></thead>
      <tbody>${paramRows}</tbody>
    </table>` : '<span class="empty">No parameters defined</span>'}
  </div>
  <div class="actions">
    <button class="primary" id="editBtn">Edit Module</button>
  </div>
</div>
  <script nonce="FORM_NONCE">
    const vscode = acquireVsCodeApi();
    document.getElementById('editBtn').addEventListener('click', () => {
      vscode.postMessage({ type: 'enableEdit' });
    });
  </script>
</body>
</html>`;
  }

  // ---- Edit / New mode ----
  return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-FORM_NONCE';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Module Editor</title>
  <style>
    ${SHARED_CSS}
    h2 {
      font-size: 20px;
      font-weight: 600;
      margin-bottom: 24px;
    }
    .row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
    }
    .field { margin-bottom: 18px; }
    label {
      display: block;
      margin-bottom: 5px;
      font-weight: 600;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      color: var(--vscode-descriptionForeground);
    }
    label .req { color: var(--vscode-errorForeground); margin-left: 2px; }
    input, textarea, select {
      display: block;
      width: 100%;
      padding: 7px 10px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.3));
      border-radius: 4px;
      outline: none;
      transition: border-color 0.15s;
    }
    input:focus, textarea:focus, select:focus {
      border-color: var(--vscode-focusBorder);
    }
    select {
      cursor: pointer;
      -webkit-appearance: auto;
    }
    textarea {
      resize: vertical;
      min-height: 48px;
      line-height: 1.5;
    }
    .hint {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-top: 3px;
      opacity: 0.7;
    }
    .error-msg {
      color: var(--vscode-errorForeground);
      font-size: 11px;
      margin-top: 3px;
      display: none;
    }
    /* Parameters list */
    .param-list { margin-top: 4px; }
    .param-row {
      display: grid;
      grid-template-columns: 1fr 140px 1fr 32px;
      gap: 8px;
      align-items: start;
      margin-bottom: 8px;
    }
    .param-row input, .param-row select {
      padding: 6px 8px;
      font-size: 12px;
    }
    .param-row .remove-param {
      width: 28px;
      height: 28px;
      padding: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 16px;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      border: 1px solid transparent;
      border-radius: 4px;
      cursor: pointer;
      margin-top: 1px;
    }
    .param-row .remove-param:hover {
      color: var(--vscode-errorForeground);
      border-color: var(--vscode-errorForeground);
    }
    .param-header {
      display: grid;
      grid-template-columns: 1fr 140px 1fr 32px;
      gap: 8px;
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--vscode-descriptionForeground);
      padding: 0 0 4px;
      margin-bottom: 4px;
      border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.1));
    }
    .add-param-btn {
      padding: 5px 14px;
      font-size: 12px;
      margin-top: 4px;
    }
    .actions {
      margin-top: 28px;
      display: flex;
      gap: 10px;
      padding-top: 20px;
      border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.15));
    }
  </style>
</head>
<body>
<div class="container">
  <h2>${existing ? "Edit Module" : "New Module"}</h2>
  <form id="moduleForm">
    <div class="row">
      <div class="field">
        <label for="name">Name <span class="req">*</span></label>
        <input type="text" id="name" value="${name}" required>
        <div class="error-msg" id="nameError">Name is required</div>
      </div>
      <div class="field">
        <label for="manufacturer">Manufacturer <span class="req">*</span></label>
        <input type="text" id="manufacturer" value="${manufacturer}" required>
        <div class="error-msg" id="manufacturerError">Manufacturer is required</div>
      </div>
    </div>
    <div class="row">
      <div class="field">
        <label for="type">Type <span class="req">*</span></label>
        <input type="text" id="type" value="${type}" placeholder="Oscillator, Filter, VCA...">
        <div class="error-msg" id="typeError">Type is required</div>
      </div>
      <div class="field">
        <label for="description">Description</label>
        <input type="text" id="description" value="${description}">
      </div>
    </div>

    <div class="section-title">Connections</div>
    <div class="row">
      <div class="field">
        <label for="inputs">Inputs</label>
        <textarea id="inputs" rows="2" placeholder="V/Oct, FM, CV">${inputs}</textarea>
        <div class="hint">Comma-separated</div>
      </div>
      <div class="field">
        <label for="outputs">Outputs</label>
        <textarea id="outputs" rows="2" placeholder="Out, Aux">${outputs}</textarea>
        <div class="hint">Comma-separated</div>
      </div>
    </div>

    <div class="section-title">Parameters</div>
    <div class="param-header">
      <span>Name</span><span>Type</span><span>Values</span><span></span>
    </div>
    <div class="param-list" id="paramList"></div>
    <button type="button" class="secondary add-param-btn" id="addParamBtn">+ Add Parameter</button>

    <div class="actions">
      <button type="submit" class="primary">${buttonLabel}</button>
      <button type="button" class="secondary" id="cancelBtn">Cancel</button>
    </div>
  </form>
</div>
  <script nonce="FORM_NONCE">
    const vscode = acquireVsCodeApi();
    const initialParams = ${paramsJson};

    function splitTrim(s) {
      return s.split(',').map(x => x.trim()).filter(x => x.length > 0);
    }

    // -- Dynamic parameters --
    const paramList = document.getElementById('paramList');
    let paramCounter = 0;

    function addParamRow(p) {
      const idx = paramCounter++;
      const row = document.createElement('div');
      row.className = 'param-row';
      row.dataset.idx = idx;

      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.placeholder = 'Parameter name';
      nameInput.value = p ? p.name : '';
      nameInput.className = 'p-name';

      const typeSelect = document.createElement('select');
      typeSelect.className = 'p-type';
      typeSelect.innerHTML = '<option value="">— None —</option><option value="integer">Integer</option><option value="percentage">Percentage</option><option value="multichoice">Multi-choice</option><option value="string">String</option>';
      typeSelect.value = p && p.type ? p.type : '';

      const valInput = document.createElement('input');
      valInput.type = 'text';
      valInput.className = 'p-values';
      valInput.value = p && p.values ? p.values : '';
      updateValPlaceholder(typeSelect.value, valInput);

      typeSelect.addEventListener('change', () => {
        updateValPlaceholder(typeSelect.value, valInput);
      });

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'remove-param';
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', () => row.remove());

      row.appendChild(nameInput);
      row.appendChild(typeSelect);
      row.appendChild(valInput);
      row.appendChild(removeBtn);
      paramList.appendChild(row);
    }

    function updateValPlaceholder(type, input) {
      const map = {
        '': '',
        'integer': 'e.g. 0 — 127',
        'percentage': 'e.g. 0 — 100',
        'multichoice': 'e.g. Saw, Square, Tri',
        'string': 'e.g. default text'
      };
      input.placeholder = map[type] || '';
    }

    function collectParams() {
      const rows = paramList.querySelectorAll('.param-row');
      const params = [];
      rows.forEach(row => {
        const name = row.querySelector('.p-name').value.trim();
        if (!name) return;
        const type = row.querySelector('.p-type').value || undefined;
        const values = row.querySelector('.p-values').value.trim() || undefined;
        const obj = { name };
        if (type) obj.type = type;
        if (values) obj.values = values;
        params.push(obj);
      });
      return params;
    }

    // Init params
    if (initialParams.length > 0) {
      initialParams.forEach(p => addParamRow(p));
    }

    document.getElementById('addParamBtn').addEventListener('click', () => {
      addParamRow(null);
      const rows = paramList.querySelectorAll('.param-row');
      const last = rows[rows.length - 1];
      if (last) last.querySelector('.p-name').focus();
    });

    // -- Validation --
    function validate() {
      let valid = true;
      ['name', 'manufacturer', 'type'].forEach(id => {
        const el = document.getElementById(id);
        const err = document.getElementById(id + 'Error');
        if (!el.value.trim()) {
          err.style.display = 'block';
          valid = false;
        } else {
          err.style.display = 'none';
        }
      });
      return valid;
    }

    document.getElementById('moduleForm').addEventListener('submit', e => {
      e.preventDefault();
      if (!validate()) return;
      vscode.postMessage({
        type: 'save',
        data: {
          name: document.getElementById('name').value.trim(),
          manufacturer: document.getElementById('manufacturer').value.trim(),
          type: document.getElementById('type').value.trim(),
          description: document.getElementById('description').value.trim(),
          inputs: splitTrim(document.getElementById('inputs').value),
          outputs: splitTrim(document.getElementById('outputs').value),
          parameters: collectParams(),
        }
      });
    });
    document.getElementById('cancelBtn').addEventListener('click', () => {
      vscode.postMessage({ type: 'cancel' });
    });
    document.getElementById('name').focus();
  </script>
</body>
</html>`;
}
