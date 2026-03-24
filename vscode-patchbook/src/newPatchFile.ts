import * as vscode from "vscode";
import * as path from "path";
import { getModules, ModuleInfo, parameterNames } from "./moduleDatabase";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

interface ModulePickerMessage {
  type: "create" | "cancel";
  patchName?: string;
  selectedModules?: string[];
}

export function openNewPatchbookFile(context: vscode.ExtensionContext): void {
  const panel = vscode.window.createWebviewPanel(
    "patchbookNewFile",
    "New Patchbook File",
    vscode.ViewColumn.One,
    { enableScripts: true }
  );

  panel.webview.html = getModulePickerHtml(panel.webview);

  panel.webview.onDidReceiveMessage(async (msg: ModulePickerMessage) => {
    if (msg.type === "cancel") {
      panel.dispose();
      return;
    }
    if (msg.type === "create") {
      panel.dispose();
      await createPatchbookFile(msg.patchName ?? "", msg.selectedModules ?? []);
    }
  });
}

async function createPatchbookFile(
  patchName: string,
  selectedModuleNames: string[]
): Promise<void> {
  const modules = getModules();
  const selectedMods: ModuleInfo[] = [];
  for (const name of selectedModuleNames) {
    const mod = modules.get(name);
    if (mod) {
      selectedMods.push(mod);
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const lines: string[] = [];
  lines.push(`// ${patchName || "Untitled Patch"}`);
  lines.push(`// Date: ${today}`);
  lines.push("");
  lines.push("VOICE 1:");
  lines.push("");

  lines.push("// --- Connections ---");
  if (selectedMods.length >= 2) {
    for (let i = 0; i < selectedMods.length - 1; i++) {
      const src = selectedMods[i];
      const dst = selectedMods[i + 1];
      const outPort = src.outputs[0] ?? "Out";
      const inPort = dst.inputs[0] ?? "In";
      lines.push(`- ${src.name} (${outPort}) -> ${dst.name} (${inPort})`);
    }
  } else {
    lines.push("// Add connections here");
  }
  lines.push("");

  lines.push("// --- Parameters ---");
  for (const mod of selectedMods) {
    if (mod.parameters.length > 0) {
      lines.push(`* ${mod.name}:`);
      for (const p of mod.parameters) {
        lines.push(`  | ${p.name} = `);
      }
    }
  }
  lines.push("");

  const content = lines.join("\n");

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (workspaceFolder) {
    const fileName = (patchName || "untitled")
      .replace(/[^a-zA-Z0-9_\- ]/g, "")
      .replace(/\s+/g, "-")
      .toLowerCase();
    const defaultUri = vscode.Uri.file(
      path.join(workspaceFolder.uri.fsPath, `${fileName}.patchbook`)
    );
    const uri = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { Patchbook: ["patchbook", "pb"] },
    });
    if (!uri) {
      return;
    }
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf-8"));
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
  } else {
    const doc = await vscode.workspace.openTextDocument({
      content,
      language: "patchbook",
    });
    await vscode.window.showTextDocument(doc);
  }
}

function getModulePickerHtml(webview: vscode.Webview): string {
  const modules = getModules();
  const byManufacturer = new Map<string, ModuleInfo[]>();
  for (const [, mod] of modules) {
    const list = byManufacturer.get(mod.manufacturer) ?? [];
    list.push(mod);
    byManufacturer.set(mod.manufacturer, list);
  }

  const sortedManufacturers = Array.from(byManufacturer.keys()).sort();
  const treeJson = JSON.stringify(
    sortedManufacturers.map((mfr) => ({
      manufacturer: mfr,
      modules: byManufacturer
        .get(mfr)!
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((m) => ({
          name: m.name,
          type: m.type,
          inputs: m.inputs.length,
          outputs: m.outputs.length,
          params: parameterNames(m).length,
        })),
    }))
  );

  return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-PICKER_NONCE';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>New Patchbook File</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 0;
    }
    .container {
      max-width: 720px;
      padding: 28px 32px;
    }
    h2 {
      font-size: 20px;
      font-weight: 600;
      margin-bottom: 24px;
    }
    .field {
      margin-bottom: 20px;
    }
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
    input[type="text"] {
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
    }
    input[type="text"]:focus {
      border-color: var(--vscode-focusBorder);
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

    /* Tree */
    .tree {
      border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2));
      border-radius: 6px;
      max-height: 420px;
      overflow-y: auto;
    }
    .mfr-group {
      border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.1));
    }
    .mfr-group:last-child { border-bottom: none; }
    .mfr-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      cursor: pointer;
      user-select: none;
      background: var(--vscode-sideBar-background, transparent);
      transition: background 0.1s;
    }
    .mfr-header:hover {
      background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.08));
    }
    .mfr-header .arrow {
      font-size: 10px;
      width: 16px;
      text-align: center;
      color: var(--vscode-descriptionForeground);
      transition: transform 0.15s;
    }
    .mfr-header .arrow.expanded { transform: rotate(90deg); }
    .mfr-header .mfr-name {
      font-weight: 600;
      font-size: 13px;
      flex: 1;
    }
    .mfr-header .mfr-count {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
    .mfr-modules {
      display: none;
    }
    .mfr-modules.open {
      display: block;
    }
    .mod-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 5px 12px 5px 40px;
      cursor: pointer;
      user-select: none;
      transition: background 0.1s;
    }
    .mod-row:hover {
      background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.08));
    }
    .mod-row .mod-name {
      flex: 1;
      font-size: 13px;
    }
    .mod-row .mod-type {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }

    /* Toggle switch */
    .toggle {
      position: relative;
      width: 34px;
      height: 18px;
      flex-shrink: 0;
    }
    .toggle input {
      opacity: 0;
      width: 0;
      height: 0;
    }
    .toggle .slider {
      position: absolute;
      inset: 0;
      background: var(--vscode-input-border, rgba(128,128,128,0.35));
      border-radius: 9px;
      cursor: pointer;
      transition: background 0.2s;
    }
    .toggle .slider::before {
      content: '';
      position: absolute;
      width: 14px;
      height: 14px;
      left: 2px;
      bottom: 2px;
      background: var(--vscode-editor-background);
      border-radius: 50%;
      transition: transform 0.2s;
    }
    .toggle input:checked + .slider {
      background: var(--vscode-button-background);
    }
    .toggle input:checked + .slider::before {
      transform: translateX(16px);
    }

    /* Selection summary */
    .summary {
      margin-top: 12px;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }
    .summary strong {
      color: var(--vscode-foreground);
    }

    /* Actions */
    .actions {
      margin-top: 24px;
      display: flex;
      gap: 10px;
      padding-top: 20px;
      border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.15));
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
    button.primary:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    button.secondary {
      background: transparent;
      color: var(--vscode-foreground);
      border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.3));
    }
    button.secondary:hover {
      background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.1));
    }
  </style>
</head>
<body>
<div class="container">
  <h2>New Patchbook File</h2>

  <div class="field">
    <label for="patchName">Patch Name <span class="req">*</span></label>
    <input type="text" id="patchName" placeholder="My Patch">
  </div>

  <div class="section-title">Select Modules</div>
  <div class="tree" id="tree"></div>
  <div class="summary" id="summary">No modules selected</div>

  <div class="actions">
    <button class="primary" id="createBtn">Create File</button>
    <button class="secondary" id="cancelBtn">Cancel</button>
  </div>
</div>

<script nonce="PICKER_NONCE">
  const vscode = acquireVsCodeApi();
  const treeData = ${treeJson};
  const treeEl = document.getElementById('tree');
  const summaryEl = document.getElementById('summary');
  const createBtn = document.getElementById('createBtn');
  const patchNameInput = document.getElementById('patchName');

  // Build tree
  treeData.forEach((group, gi) => {
    const groupEl = document.createElement('div');
    groupEl.className = 'mfr-group';

    // Header
    const header = document.createElement('div');
    header.className = 'mfr-header';
    header.innerHTML =
      '<span class="arrow">&#9654;</span>' +
      '<label class="toggle"><input type="checkbox" data-mfr="' + gi + '"><span class="slider"></span></label>' +
      '<span class="mfr-name">' + escapeHtml(group.manufacturer) + '</span>' +
      '<span class="mfr-count">' + group.modules.length + '</span>';

    const arrow = header.querySelector('.arrow');
    const mfrToggle = header.querySelector('input[type="checkbox"]');

    // Module list container
    const modulesEl = document.createElement('div');
    modulesEl.className = 'mfr-modules';

    group.modules.forEach((mod, mi) => {
      const row = document.createElement('div');
      row.className = 'mod-row';
      row.innerHTML =
        '<label class="toggle"><input type="checkbox" data-mod="' + escapeHtml(mod.name) + '" data-mfr-idx="' + gi + '"><span class="slider"></span></label>' +
        '<span class="mod-name">' + escapeHtml(mod.name) + '</span>' +
        '<span class="mod-type">' + escapeHtml(mod.type) + '</span>';

      row.querySelector('input').addEventListener('change', () => {
        syncMfrToggle(gi);
        updateSummary();
      });

      // Click on the row (not toggle) toggles the module
      row.addEventListener('click', (e) => {
        if (e.target.closest('.toggle')) return;
        const cb = row.querySelector('input');
        cb.checked = !cb.checked;
        syncMfrToggle(gi);
        updateSummary();
      });

      modulesEl.appendChild(row);
    });

    // Manufacturer toggle: select/deselect all modules
    mfrToggle.addEventListener('change', () => {
      const checked = mfrToggle.checked;
      modulesEl.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.checked = checked;
      });
      updateSummary();
    });

    // Stop toggle click from toggling collapse
    header.querySelector('.toggle').addEventListener('click', (e) => {
      e.stopPropagation();
    });

    // Arrow / header click: expand/collapse
    header.addEventListener('click', (e) => {
      if (e.target.closest('.toggle')) return;
      const isOpen = modulesEl.classList.toggle('open');
      arrow.classList.toggle('expanded', isOpen);
    });

    groupEl.appendChild(header);
    groupEl.appendChild(modulesEl);
    treeEl.appendChild(groupEl);
  });

  function syncMfrToggle(gi) {
    const mfrCb = treeEl.querySelector('input[data-mfr="' + gi + '"]');
    const modCbs = treeEl.querySelectorAll('input[data-mfr-idx="' + gi + '"]');
    const allChecked = Array.from(modCbs).every(cb => cb.checked);
    const someChecked = Array.from(modCbs).some(cb => cb.checked);
    mfrCb.checked = allChecked;
    mfrCb.indeterminate = someChecked && !allChecked;
  }

  function updateSummary() {
    const checked = treeEl.querySelectorAll('input[data-mod]:checked');
    const count = checked.length;
    if (count === 0) {
      summaryEl.innerHTML = 'No modules selected';
    } else {
      summaryEl.innerHTML = '<strong>' + count + '</strong> module' + (count > 1 ? 's' : '') + ' selected';
    }
  }

  function getSelectedModules() {
    const checked = treeEl.querySelectorAll('input[data-mod]:checked');
    return Array.from(checked).map(cb => cb.dataset.mod);
  }

  function escapeHtml(t) {
    const d = document.createElement('div');
    d.textContent = t;
    return d.innerHTML;
  }

  createBtn.addEventListener('click', () => {
    const name = patchNameInput.value.trim();
    if (!name) {
      patchNameInput.focus();
      patchNameInput.style.borderColor = 'var(--vscode-errorForeground)';
      return;
    }
    vscode.postMessage({
      type: 'create',
      patchName: name,
      selectedModules: getSelectedModules()
    });
  });

  patchNameInput.addEventListener('input', () => {
    patchNameInput.style.borderColor = '';
  });

  cancelBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'cancel' });
  });

  patchNameInput.focus();
</script>
</body>
</html>`;
}
