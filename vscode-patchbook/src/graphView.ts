import * as vscode from "vscode";
import { parse, PatchbookData } from "./parser";
import { getModuleByName, getModules, ModuleInfo } from "./moduleDatabase";

export class GraphViewProvider {
  private panel: vscode.WebviewPanel | undefined;
  private sourceUri: vscode.Uri | undefined;
  private changeListener: vscode.Disposable | undefined;

  constructor(private readonly extensionUri: vscode.Uri) {}

  /** Send a command from the VS Code toolbar to the webview */
  executeCommand(command: string): void {
    if (!this.panel) { return; }
    this.panel.webview.postMessage({ type: "command", command });
  }

  /** Get the source document URI */
  getSourceUri(): vscode.Uri | undefined {
    return this.sourceUri;
  }

  /** Ensure the graph panel is open and rendered for the given document URI.
   *  If the panel is already open, this resolves immediately. */
  ensurePanelReady(docUri: vscode.Uri): Promise<void> {
    return new Promise(async (resolve) => {
      if (this.panel) { resolve(); return; }
      // Need to open the panel – open the document first to make it the active editor
      const doc = await vscode.workspace.openTextDocument(docUri);
      await vscode.window.showTextDocument(doc, vscode.ViewColumn.One, false);
      // Now call show() which reads from activeTextEditor
      this.show();
      // After show(), panel may have been created
      const p = this.panel as vscode.WebviewPanel | undefined;
      if (!p) { resolve(); return; }
      // Wait for the webview to signal it's ready
      const timeout = setTimeout(() => { dispose.dispose(); resolve(); }, 8000);
      const dispose = p.webview.onDidReceiveMessage((msg: { type: string }) => {
        if (msg.type === "ready") {
          clearTimeout(timeout);
          dispose.dispose();
          resolve();
        }
      });
    });
  }

  /** Request a JPEG screenshot of the graph from the webview */
  requestGraphImage(): Promise<{ jpeg: Buffer; width: number; height: number } | null> {
    return new Promise((resolve) => {
      if (!this.panel) { resolve(null); return; }
      const timeout = setTimeout(() => { dispose.dispose(); resolve(null); }, 10000);
      const dispose = this.panel.webview.onDidReceiveMessage((msg) => {
        if (msg.type === "graphImage") {
          clearTimeout(timeout);
          dispose.dispose();
          if (!msg.dataUrl) { resolve(null); return; }
          const b64 = msg.dataUrl.replace(/^data:image\/jpeg;base64,/, "");
          resolve({ jpeg: Buffer.from(b64, "base64"), width: msg.width, height: msg.height });
        }
      });
      this.panel.webview.postMessage({ type: "command", command: "exportImage" });
    });
  }

  show(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== "patchbook") {
      vscode.window.showWarningMessage(
        "Patchbook: Open a .pb or .patchbook file first."
      );
      return;
    }

    this.sourceUri = editor.document.uri;
    const text = editor.document.getText();
    const data = parse(text);

    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
    } else {
      this.panel = vscode.window.createWebviewPanel(
        "patchbookGraph",
        "Patchbook — Signal Flow",
        vscode.ViewColumn.Beside,
        { enableScripts: true, retainContextWhenHidden: true }
      );
      this.panel.onDidDispose(() => {
        this.panel = undefined;
        this.changeListener?.dispose();
        this.changeListener = undefined;
        vscode.commands.executeCommand("setContext", "patchbook.graph.hasSelection", false);
      });
      this.setupMessageHandler();
      this.setupDocListener();
    }

    this.panel.webview.html = this.buildHtml(data);
  }

  /** Listen for text document changes and push updates to the webview */
  private setupDocListener(): void {
    this.changeListener?.dispose();
    this.changeListener = vscode.workspace.onDidChangeTextDocument((e) => {
      if (!this.sourceUri || !this.panel) { return; }
      if (e.document.uri.toString() !== this.sourceUri.toString()) { return; }
      const data = parse(e.document.getText());
      const graphData = this.toGraphData(data);
      this.panel.webview.postMessage({ type: "update", data: graphData });
    });
  }

  /** Handle messages from the webview */
  private setupMessageHandler(): void {
    if (!this.panel) { return; }
    this.panel.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case "inspectModule":
          this.handleInspectModule(msg.moduleName);
          break;
        case "addConnection":
          await this.handleAddConnection(msg);
          break;
        case "removeConnection":
          await this.handleRemoveConnection(msg);
          break;
        case "editParam":
          await this.handleEditParam(msg);
          break;
        case "addParam":
          await this.handleAddParam(msg);
          break;
        case "removeParam":
          await this.handleRemoveParam(msg);
          break;
        case "addModule":
          await this.handleAddModule();
          break;
        case "removeModule":
          await this.handleRemoveModule(msg.moduleName);
          break;
        case "selectionChanged":
          vscode.commands.executeCommand("setContext", "patchbook.graph.hasSelection", !!msg.hasSelection);
          break;
      }
    });
  }

  /** Look up a module in the catalog, trying instance-suffix stripping */
  private catalogLookup(name: string): ModuleInfo | undefined {
    let info = getModuleByName(name);
    if (!info) {
      const base = name.replace(/\s+#?\d+\s*$/, "").trim();
      if (base && base !== name) { info = getModuleByName(base); }
    }
    return info;
  }

  /** Show module info from the catalog in a tooltip sent back to webview */
  private handleInspectModule(moduleName: string): void {
    if (!this.panel) { return; }
    const info = this.catalogLookup(moduleName);
    this.panel.webview.postMessage({
      type: "moduleInfo",
      moduleName,
      catalog: info
        ? {
            manufacturer: info.manufacturer,
            type: info.type,
            description: info.description,
            inputs: info.inputs,
            outputs: info.outputs,
            parameters: info.parameters,
          }
        : null,
    });
  }

  /** Apply an edit to the source patchbook document */
  private async applyEdit(editFn: (doc: vscode.TextDocument, edit: vscode.WorkspaceEdit) => void): Promise<void> {
    if (!this.sourceUri) { return; }
    const doc = await vscode.workspace.openTextDocument(this.sourceUri);
    const edit = new vscode.WorkspaceEdit();
    editFn(doc, edit);
    await vscode.workspace.applyEdit(edit);
    await doc.save();
  }

  private findConnectionLine(doc: vscode.TextDocument, from: string, fromPort: string, to: string, toPort: string): number {
    const text = doc.getText();
    const lines = text.split(/\r?\n/);
    const fromLower = from.toLowerCase();
    const toLower = to.toLowerCase();
    const fpLower = fromPort.toLowerCase();
    const tpLower = toPort.toLowerCase();
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i].trim().toLowerCase();
      if (l.startsWith("-") && l.includes(fromLower) && l.includes(toLower) &&
          l.includes("(" + fpLower + ")") && l.includes("(" + tpLower + ")")) {
        return i;
      }
    }
    return -1;
  }

  private async handleAddConnection(msg: {from: string; fromPort: string; to: string; toPort: string; connType: string}): Promise<void> {
    const typeMap: Record<string, string> = {
      audio: "->", cv: ">>", pitch: "p>", gate: "g>", trigger: "t>", clock: "c>",
    };
    const arrow = typeMap[msg.connType] || "->";
    const line = `- ${msg.from} (${msg.fromPort}) ${arrow} ${msg.to} (${msg.toPort})`;
    await this.applyEdit((doc, edit) => {
      // Find the last connection line (starts with "- ") and insert after it
      let lastConnIdx = -1;
      for (let i = 0; i < doc.lineCount; i++) {
        if (doc.lineAt(i).text.trim().startsWith("- ")) {
          lastConnIdx = i;
        }
      }
      if (lastConnIdx >= 0) {
        const endOfLastConn = doc.lineAt(lastConnIdx).range.end;
        edit.insert(this.sourceUri!, endOfLastConn, "\n" + line);
      } else {
        // No existing connections — append at end of file
        const lastLine = doc.lineAt(doc.lineCount - 1);
        edit.insert(this.sourceUri!, lastLine.range.end, "\n" + line);
      }
    });
  }

  private async handleRemoveConnection(msg: {from: string; fromPort: string; to: string; toPort: string}): Promise<void> {
    await this.applyEdit((doc, edit) => {
      const lineIdx = this.findConnectionLine(doc, msg.from, msg.fromPort, msg.to, msg.toPort);
      if (lineIdx >= 0) {
        const range = doc.lineAt(lineIdx).rangeIncludingLineBreak;
        edit.delete(this.sourceUri!, range);
      }
    });
  }

  private async handleEditParam(msg: {module: string; param: string; value: string}): Promise<void> {
    await this.applyEdit((doc, edit) => {
      const lines = doc.getText().split(/\r?\n/);
      const modLower = msg.module.toLowerCase();
      const paramLower = msg.param.toLowerCase();
      // Search single-line params: * Module: ... param = val ...
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i].trim().toLowerCase();
        if (l.startsWith("*") && l.includes(modLower + ":") && l.includes(paramLower + " =")) {
          // Replace param value in the line
          const origLine = lines[i];
          const regex = new RegExp(`(${this.escapeRegex(msg.param)}\\s*=\\s*)(\\S+)`, "i");
          const newLine = origLine.replace(regex, `$1${msg.value}`);
          if (newLine !== origLine) {
            edit.replace(this.sourceUri!, doc.lineAt(i).range, newLine);
            return;
          }
        }
        // Multi-line param: | param = value
        if ((l.startsWith("|") || l.startsWith("| ")) && l.includes(paramLower + " =")) {
          // Check if we're within the right module
          let moduleMatch = false;
          for (let j = i - 1; j >= 0; j--) {
            const prevL = lines[j].trim().toLowerCase();
            if (prevL.startsWith("*") && prevL.includes(modLower + ":")) {
              moduleMatch = true;
              break;
            }
            if (prevL.startsWith("*") || prevL.startsWith("-")) { break; }
          }
          if (moduleMatch) {
            const origLine = lines[i];
            const regex = new RegExp(`(${this.escapeRegex(msg.param)}\\s*=\\s*)(.+)`, "i");
            const newLine = origLine.replace(regex, `$1${msg.value}`);
            if (newLine !== origLine) {
              edit.replace(this.sourceUri!, doc.lineAt(i).range, newLine);
              return;
            }
          }
        }
      }
    });
  }

  private async handleAddParam(msg: {module: string; param: string; value: string}): Promise<void> {
    await this.applyEdit((doc, edit) => {
      const lines = doc.getText().split(/\r?\n/);
      const modLower = msg.module.toLowerCase();
      // Find last param line for this module, or module header
      let insertIdx = -1;
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i].trim().toLowerCase();
        if (l.startsWith("*") && l.includes(modLower + ":")) {
          insertIdx = i;
          // Advance past multi-line params
          for (let j = i + 1; j < lines.length; j++) {
            if (lines[j].trim().startsWith("|")) {
              insertIdx = j;
            } else { break; }
          }
          break;
        }
      }
      if (insertIdx >= 0) {
        // Check if the header has inline params (single-line format)
        const headerLine = lines[insertIdx].trim();
        if (headerLine.startsWith("*") && headerLine.includes("=")) {
          // Append to single-line: add | separator
          const origLine = lines[insertIdx];
          const newLine = origLine + ` | ${msg.param} = ${msg.value}`;
          edit.replace(this.sourceUri!, doc.lineAt(insertIdx).range, newLine);
        } else {
          // Insert after the last param line
          const pos = doc.lineAt(insertIdx).range.end;
          edit.insert(this.sourceUri!, pos, `\n| ${msg.param} = ${msg.value}`);
        }
      } else {
        // Module header doesn't exist, create it
        const lastLine = doc.lineAt(doc.lineCount - 1);
        edit.insert(this.sourceUri!, lastLine.range.end, `\n\n* ${msg.module}:\n| ${msg.param} = ${msg.value}`);
      }
    });
  }

  private async handleRemoveParam(msg: {module: string; param: string}): Promise<void> {
    await this.applyEdit((doc, edit) => {
      const lines = doc.getText().split(/\r?\n/);
      const modLower = msg.module.toLowerCase();
      const paramLower = msg.param.toLowerCase();
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i].trim().toLowerCase();
        // Multi-line param
        if ((l.startsWith("|") || l.startsWith("| ")) && l.includes(paramLower + " =")) {
          let moduleMatch = false;
          for (let j = i - 1; j >= 0; j--) {
            const prevL = lines[j].trim().toLowerCase();
            if (prevL.startsWith("*") && prevL.includes(modLower + ":")) {
              moduleMatch = true;
              break;
            }
            if (prevL.startsWith("*") || prevL.startsWith("-")) { break; }
          }
          if (moduleMatch) {
            edit.delete(this.sourceUri!, doc.lineAt(i).rangeIncludingLineBreak);
            return;
          }
        }
        // Single-line param with multiple params — remove just this one
        if (l.startsWith("*") && l.includes(modLower + ":") && l.includes(paramLower + " =")) {
          const origLine = lines[i];
          const regex = new RegExp(`\\|?\\s*${this.escapeRegex(msg.param)}\\s*=\\s*[^|]+`, "i");
          let newLine = origLine.replace(regex, "").replace(/\|\s*$/, "").replace(/:\s*\|\s*/, ": ");
          // Clean up double pipes
          newLine = newLine.replace(/\|\s*\|/g, "|");
          edit.replace(this.sourceUri!, doc.lineAt(i).range, newLine);
          return;
        }
      }
    });
  }

  private async handleAddModule(): Promise<void> {
    const modules = getModules();
    const byType = new Map<string, ModuleInfo[]>();
    for (const [, mod] of modules) {
      const list = byType.get(mod.type) ?? [];
      list.push(mod);
      byType.set(mod.type, list);
    }
    const sortedTypes = Array.from(byType.keys()).sort();
    const items: vscode.QuickPickItem[] = [];
    for (const type of sortedTypes) {
      items.push({ label: type, kind: vscode.QuickPickItemKind.Separator });
      const mods = byType.get(type)!.sort((a, b) => a.name.localeCompare(b.name));
      for (const mod of mods) {
        items.push({ label: mod.name, description: mod.manufacturer, detail: mod.description });
      }
    }
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: "Select a module to add",
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!picked) { return; }
    const modName = picked.label;
    const catalog = getModuleByName(modName);
    await this.applyEdit((doc, edit) => {
      const lastLine = doc.lineAt(doc.lineCount - 1);
      let block = `\n\n* ${modName}:`;
      if (catalog && catalog.parameters.length > 0) {
        for (const p of catalog.parameters) {
          block += `\n| ${p} = `;
        }
      }
      edit.insert(this.sourceUri!, lastLine.range.end, block);
    });
  }

  private async handleRemoveModule(moduleName: string): Promise<void> {
    if (!moduleName) { return; }
    await this.applyEdit((doc, edit) => {
      const lines = doc.getText().split(/\r?\n/);
      const modLower = moduleName.toLowerCase();
      const toDelete: number[] = [];

      for (let i = 0; i < lines.length; i++) {
        const l = lines[i].trim().toLowerCase();
        // Module header: * Module: ...
        if (l.startsWith("*") && l.includes(modLower + ":")) {
          toDelete.push(i);
          // Also delete subsequent multi-line param lines (|)
          for (let j = i + 1; j < lines.length; j++) {
            if (lines[j].trim().startsWith("|")) { toDelete.push(j); } else { break; }
          }
        }
        // Connections involving this module
        if (l.startsWith("-") && (l.includes(modLower + " (") || l.includes(modLower + "("))) {
          toDelete.push(i);
        }
      }

      // Delete in reverse to keep line indices valid
      const unique = [...new Set(toDelete)].sort((a, b) => b - a);
      for (const lineIdx of unique) {
        edit.delete(this.sourceUri!, doc.lineAt(lineIdx).rangeIncludingLineBreak);
      }
    });
  }

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  private buildHtml(data: PatchbookData): string {
    const graphData = this.toGraphData(data);
    const config =
      vscode.workspace.getConfiguration("patchbook").get<string>("graphDirection") ?? "LR";

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Patchbook Graph</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #1e1e1e; color: #ccc;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    overflow: hidden; width: 100vw; height: 100vh;
    user-select: none; -webkit-user-select: none;
  }
  svg { width: 100%; height: 100%; display: block; }

  .module-box { stroke: #666; stroke-width: 1; cursor: grab; filter: drop-shadow(0 2px 6px rgba(0,0,0,0.5)); }
  .module-box:hover { stroke: #0af; stroke-width: 1.5; }
  .module-box.selected { stroke: #0af; stroke-width: 2; }
  .module-box.dragging { cursor: grabbing; stroke: #0f0; stroke-width: 2; }
  .module-highlight { pointer-events: none; }
  .module-name { fill: #fff; font-size: 13px; font-weight: 700; text-anchor: middle; pointer-events: none; letter-spacing: 1.5px; }
  .module-manufacturer { fill: rgba(255,255,255,0.45); font-size: 8px; font-weight: 400; text-anchor: middle; pointer-events: none; letter-spacing: 0.5px; }
  .module-screw { fill: #222; stroke: #555; stroke-width: 0.5; pointer-events: none; }
  .screw-slot { stroke: #444; stroke-width: 0.8; pointer-events: none; }
  .port-label { fill: #bbb; font-size: 8px; pointer-events: none; letter-spacing: 0.3px; }
  .port-section-label { fill: rgba(255,255,255,0.3); font-size: 8px; font-weight: 600; text-anchor: middle; pointer-events: none; letter-spacing: 2px; text-transform: uppercase; }
  .port-ring { fill: none; stroke-width: 1.5; pointer-events: none; }
  .port-ring.in  { stroke: #666; }
  .port-ring.out { stroke: #999; }
  .port-hole { cursor: crosshair; transition: r 0.15s; }
  .port-hole.in  { fill: #111; stroke: #555; stroke-width: 1; }
  .port-hole.out { fill: #1a1a1a; stroke: #777; stroke-width: 1; }
  .port-hole:hover { r: 7; }
  .port-hole.drag-target { fill: #0af; stroke: #fff; r: 7; }
  .param-label { fill: #aaa; font-size: 8px; text-anchor: middle; pointer-events: none; letter-spacing: 0.3px; }
  .param-value { fill: #ddd; font-size: 7px; text-anchor: middle; cursor: pointer; pointer-events: all; }
  .param-value:hover { fill: #fff; }
  .param-value.unset { fill: #555; }
  .knob-body { fill: #1a1a1a; stroke: #555; stroke-width: 1.5; cursor: pointer; }
  .knob-body:hover { stroke: #888; }
  .knob-cap { fill: #2a2a2a; stroke: #444; stroke-width: 0.5; pointer-events: none; }
  .knob-track { fill: none; stroke: #333; stroke-width: 2; stroke-linecap: round; pointer-events: none; }
  .knob-indicator { fill: none; stroke: #0af; stroke-width: 2.5; stroke-linecap: round; pointer-events: none; }
  .knob-pointer { stroke: #ddd; stroke-width: 1.5; stroke-linecap: round; pointer-events: none; }

  .edge { fill: none; stroke-width: 2; cursor: pointer; pointer-events: stroke; opacity: 0.35; transition: opacity 0.15s, stroke-width 0.15s; }
  .edge:hover { stroke-width: 4; filter: brightness(1.4); opacity: 1; }
  #edge-tooltip { position: fixed; pointer-events: none; z-index: 100; background: rgba(30,30,30,0.92); color: #ddd; font-size: 11px; padding: 4px 8px; border-radius: 4px; border: 1px solid #555; white-space: nowrap; display: none; font-family: var(--vscode-font-family, sans-serif); }
  .edge.audio    { stroke: #e8e8e8; stroke-width: 2.5; }
  .edge.cv       { stroke: #888; }
  .edge.gate     { stroke: #ff4444; stroke-dasharray: 6 3; }
  .edge.trigger  { stroke: #ff8800; stroke-dasharray: 6 3; }
  .edge.pitch    { stroke: #4488ff; }
  .edge.clock    { stroke: #aa44ff; stroke-dasharray: 6 3; }
  .edge.pending  { stroke: #0af; stroke-width: 2; stroke-dasharray: 4 4; opacity: 0.7; pointer-events: none; }

  #select-rect {
    fill: rgba(0, 170, 255, 0.08); stroke: #0af; stroke-width: 1;
    stroke-dasharray: 4 3; pointer-events: none;
  }

  #legend {
    position: fixed; top: 8px; left: 8px; z-index: 10;
    background: rgba(30, 30, 30, 0.55); border: 1px solid rgba(68, 68, 68, 0.5); border-radius: 6px;
    padding: 10px 14px; font-size: 11px; color: #aaa;
    box-shadow: 0 2px 8px rgba(0,0,0,0.3);
    max-height: calc(100vh - 16px); overflow-y: auto;
    backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
  }
  #legend h4 { font-size: 10px; text-transform: uppercase; color: #666;
    letter-spacing: 0.5px; margin: 0 0 6px 0; }
  #legend h4:not(:first-child) { margin-top: 10px; border-top: 1px solid #333; padding-top: 8px; }
  .legend-row { display: flex; align-items: center; gap: 6px; padding: 2px 0; }
  .legend-swatch { width: 14px; height: 14px; border-radius: 3px; flex-shrink: 0; border: 1px solid #555; }
  .legend-line-sample { width: 20px; height: 0; flex-shrink: 0; }
  .legend-label { color: #ccc; white-space: nowrap; }

  #inspector {
    position: fixed; right: 10px; top: 10px; z-index: 20;
    width: 280px; max-height: calc(100vh - 20px); overflow-y: auto;
    background: #252526; border: 1px solid #444; border-radius: 6px;
    display: none; font-size: 12px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.4);
  }
  #inspector.visible { display: block; }
  #inspector-header {
    padding: 10px 12px; background: #333; border-bottom: 1px solid #444;
    display: flex; justify-content: space-between; align-items: center;
    border-radius: 6px 6px 0 0;
  }
  #inspector-header h3 { font-size: 14px; color: #fff; font-weight: 600; }
  #inspector-close { background: none; border: none; color: #888; cursor: pointer; font-size: 18px; }
  #inspector-close:hover { color: #fff; }
  #inspector-body { padding: 10px 12px; }
  .insp-section { margin-bottom: 10px; }
  .insp-section h4 { font-size: 11px; text-transform: uppercase; color: #888;
    letter-spacing: 0.5px; margin-bottom: 4px; border-bottom: 1px solid #333; padding-bottom: 2px; }
  .insp-row { display: flex; justify-content: space-between; align-items: center; padding: 3px 0; gap: 6px; }
  .insp-label { color: #aaa; flex-shrink: 0; }
  .insp-value { color: #fff; text-align: right; word-break: break-all; }
  .insp-badge { display: inline-block; background: #444; color: #ccc; padding: 1px 6px;
    border-radius: 3px; font-size: 10px; margin: 1px 2px; }
  .insp-catalog-info { color: #888; font-style: italic; font-size: 11px; padding: 4px 0; }
  .param-row { display: flex; align-items: center; gap: 4px; padding: 2px 0; }
  .param-input { background: #1e1e1e; border: 1px solid #555; color: #fff;
    padding: 2px 6px; border-radius: 3px; font-size: 11px; width: 80px; }
  .param-input:focus { border-color: #0af; outline: none; }
  .param-btn { background: #333; border: 1px solid #555; color: #ccc;
    border-radius: 3px; padding: 1px 6px; cursor: pointer; font-size: 11px; }
  .param-btn:hover { background: #444; }
  .param-btn.danger { color: #f44; }
  .param-btn.danger:hover { background: #4a2020; }
  .add-param-row { display: flex; gap: 4px; margin-top: 4px; }
  .add-param-row input { width: 70px; }
  .conn-row { display: flex; align-items: center; gap: 4px; padding: 2px 0; font-size: 11px; flex-wrap: wrap; }
  .conn-arrow { color: #888; }
  .conn-remove { background: none; border: none; color: #f44; cursor: pointer; font-size: 13px; padding: 0 2px; }
  .conn-remove:hover { color: #ff6666; }
  .add-conn-form { margin-top: 6px; padding-top: 6px; border-top: 1px solid #333; }
  .add-conn-form h5 { font-size: 10px; text-transform: uppercase; color: #666;
    margin-bottom: 4px; font-weight: normal; letter-spacing: 0.5px; }
  .add-conn-row { display: flex; gap: 3px; margin-bottom: 3px; align-items: center; }
  .add-conn-row label { font-size: 10px; color: #888; width: 32px; flex-shrink: 0; }
  .add-conn-select { background: #1e1e1e; border: 1px solid #555; color: #fff;
    padding: 2px 4px; border-radius: 3px; font-size: 11px; flex: 1; min-width: 0; }
  .add-conn-select:focus { border-color: #0af; outline: none; }
  .add-conn-submit { background: #0a6; border: 1px solid #0c8; color: #fff;
    border-radius: 3px; padding: 3px 10px; cursor: pointer; font-size: 11px; margin-top: 2px; width: 100%; }
  .add-conn-submit:hover { background: #0b7; }
  .add-conn-submit:disabled { background: #333; border-color: #555; color: #666; cursor: default; }

  #conn-type-selector {
    position: fixed; z-index: 30; display: none;
    background: #333; border: 1px solid #555; border-radius: 4px;
    padding: 4px; box-shadow: 0 4px 12px rgba(0,0,0,0.5);
  }
  #conn-type-selector button {
    display: block; width: 100%; background: none; border: none;
    color: #ccc; padding: 6px 14px; text-align: left; cursor: pointer;
    font-size: 12px; border-radius: 2px;
  }
  #conn-type-selector button:hover { background: #444; }
</style>
</head>
<body>
<div id="legend"></div>
<div id="inspector">
  <div id="inspector-header">
    <h3 id="inspector-title">Module</h3>
    <button id="inspector-close" onclick="closeInspector()">\u00d7</button>
  </div>
  <div id="inspector-body"></div>
</div>
<div id="conn-type-selector"></div>
<div id="edge-tooltip"></div>
<svg id="canvas"><g id="root"></g></svg>
<script>
const vscodeApi = acquireVsCodeApi();
let DATA = ${JSON.stringify(graphData)};
const DIR = "${config}";

// Module type color palette
const MODULE_TYPE_COLORS = {
  'Oscillator':       '#2e5c8a',
  'Voice':            '#2e5c8a',
  'Filter':           '#8a4a2e',
  'Low Pass Gate':    '#8a5e2e',
  'VCA':              '#6b5b2e',
  'Mixer':            '#5c6b2e',
  'Envelope Generator':'#2e7a5a',
  'Function Generator':'#2e7a6b',
  'LFO':              '#2e6b7a',
  'Sequencer':        '#6b2e7a',
  'Clock':            '#7a2e6b',
  'Effect':           '#7a2e4a',
  'Resonator':        '#7a3a3a',
  'Quantizer':        '#4a2e7a',
  'Random Source':    '#2e4a6b',
  'Sampler':          '#5a3a6b',
  'Utility':          '#4a4a4a',
  'Controller':       '#3a5a3a',
  'Audio Interface':  '#3a4a5a',
  'Eurorack Case with Utilities': '#4a4a4a',
  'Unknown':          '#2d2d2d',
};
function moduleColor(type) {
  return MODULE_TYPE_COLORS[type] || MODULE_TYPE_COLORS['Unknown'];
}

// Color utilities for Eurorack panel gradients
function lightenColor(hex, percent) {
  const r = parseInt(hex.slice(1,3), 16);
  const g = parseInt(hex.slice(3,5), 16);
  const b = parseInt(hex.slice(5,7), 16);
  const amt = Math.round(2.55 * percent);
  return '#' + (
    (1 << 24) +
    (Math.min(255, r + amt) << 16) +
    (Math.min(255, g + amt) << 8) +
    Math.min(255, b + amt)
  ).toString(16).slice(1);
}
function darkenColor(hex, percent) {
  const r = parseInt(hex.slice(1,3), 16);
  const g = parseInt(hex.slice(3,5), 16);
  const b = parseInt(hex.slice(5,7), 16);
  const amt = Math.round(2.55 * percent);
  return '#' + (
    (1 << 24) +
    (Math.max(0, r - amt) << 16) +
    (Math.max(0, g - amt) << 8) +
    Math.max(0, b - amt)
  ).toString(16).slice(1);
}

// Build legend HTML
function buildLegend() {
  const el = document.getElementById('legend');
  let html = '<h4>Module Types</h4>';
  // Collect types actually used in the graph
  const usedTypes = new Set();
  DATA.nodes.forEach(n => { usedTypes.add(n.moduleType); });
  const sortedTypes = Object.keys(MODULE_TYPE_COLORS).filter(t => usedTypes.has(t)).sort();
  sortedTypes.forEach(t => {
    html += '<div class="legend-row"><div class="legend-swatch" style="background:' + moduleColor(t) + '"></div><span class="legend-label">' + esc(t) + '</span></div>';
  });
  html += '<h4>Connection Types</h4>';
  const connTypes = [
    { name: 'Audio',   style: 'border-top: 2.5px solid #e8e8e8' },
    { name: 'CV',      style: 'border-top: 2px solid #888' },
    { name: 'Pitch',   style: 'border-top: 2px solid #4488ff' },
    { name: 'Gate',    style: 'border-top: 2px dashed #ff4444' },
    { name: 'Trigger', style: 'border-top: 2px dashed #ff8800' },
    { name: 'Clock',   style: 'border-top: 2px dashed #aa44ff' },
  ];
  connTypes.forEach(ct => {
    html += '<div class="legend-row"><div class="legend-line-sample" style="' + ct.style + '"></div><span class="legend-label">' + ct.name + '</span></div>';
  });
  el.innerHTML = html;
}
buildLegend();

// ================================================================
//  CONSTANTS
// ================================================================
const PORT_H       = 20;
const PORT_PAD     = 14;
const MOD_MIN_W    = 160;
const MOD_NAME_H   = 38;
const KNOB_R       = 10;
const KNOB_CELL_H  = 46;
const KNOB_CELL_W  = 50;
const JACK_R       = 6;
const JACK_CELL_H  = 30;
const JACK_CELL_W  = 50;
const PORT_LABEL_H = 14;
const LAYER_GAP    = 280;
const NODE_GAP     = 40;

// ================================================================
//  ELK LAYERED LAYOUT
//  Based on Eclipse ELK's layered algorithm (Sugiyama framework):
//   1. Cycle breaking (DFS-based)
//   2. Layer assignment (longest path + node promotion)
//   3. Crossing minimisation (barycenter + sifting)
//   4. Node placement (linear segments / Brandes-Köpf)
// ================================================================

function elkLayout(data) {
  const nodes = data.nodes;
  const edges = data.edges;
  const nodeMap = {};
  nodes.forEach(n => { nodeMap[n.id] = n; });

  // --- Compute node sizes ---
  nodes.forEach(n => {
    const setKeys = Object.keys(n.params);
    const setLower = new Set(setKeys.map(k => k.toLowerCase()));
    const unsetCat = (n.catalogParams || []).filter(cp => !setLower.has(cp.toLowerCase()));
    const totalParams = setKeys.length + unsetCat.length;
    n._allParamKeys = setKeys;
    n._unsetCatParams = unsetCat;
    const maxLen = Math.max(
      ...n.inputs.map(p => p.length),
      ...n.outputs.map(p => p.length), 4
    );
    n._w = Math.max(MOD_MIN_W, maxLen * 7 + 80, n.name.length * 9 + 40);
    // Knob grid layout
    const knobCols = totalParams > 0 ? Math.max(1, Math.min(3, totalParams)) : 0;
    const knobRows = totalParams > 0 ? Math.ceil(totalParams / knobCols) : 0;
    const paramH = knobRows > 0 ? knobRows * KNOB_CELL_H + 8 : 0;
    if (knobCols > 0) {
      n._w = Math.max(n._w, knobCols * KNOB_CELL_W + 16);
    }
    n._knobCols = knobCols;
    n._knobRows = knobRows;
    n._paramH = paramH;
    // Jack grid layout for ports
    const inCount = n.inputs.length;
    const outCount = n.outputs.length;
    const inCols = inCount > 0 ? Math.max(1, Math.min(4, inCount)) : 0;
    const inRows = inCount > 0 ? Math.ceil(inCount / inCols) : 0;
    const outCols = outCount > 0 ? Math.max(1, Math.min(4, outCount)) : 0;
    const outRows = outCount > 0 ? Math.ceil(outCount / outCols) : 0;
    n._inCols = inCols; n._inRows = inRows;
    n._outCols = outCols; n._outRows = outRows;
    // Ensure width fits the jack grids
    if (inCols > 0) n._w = Math.max(n._w, inCols * JACK_CELL_W + 16);
    if (outCols > 0) n._w = Math.max(n._w, outCols * JACK_CELL_W + 16);
    // Port section height
    let portH = 4;
    if (inRows > 0) portH += PORT_LABEL_H + inRows * JACK_CELL_H;
    if (outRows > 0) portH += PORT_LABEL_H + outRows * JACK_CELL_H;
    if (inRows === 0 && outRows === 0) portH = 20;
    n._portH = portH;
    n._h = MOD_NAME_H + paramH + portH;
  });

  if (nodes.length === 0) {
    return { nodes, edges, nodeMap, maxW: 100, maxH: 100 };
  }

  // --- Build adjacency (deduplicated) ---
  const succ = {}, pred = {};
  nodes.forEach(n => { succ[n.id] = new Set(); pred[n.id] = new Set(); });
  edges.forEach(e => {
    if (succ[e.from]) succ[e.from].add(e.to);
    if (pred[e.to])   pred[e.to].add(e.from);
  });
  // Convert to arrays
  const succArr = {}, predArr = {};
  nodes.forEach(n => {
    succArr[n.id] = [...(succ[n.id] || [])];
    predArr[n.id] = [...(pred[n.id] || [])];
  });

  // ---- PHASE 1: LAYER ASSIGNMENT ----
  // Topological sort (Kahn's algorithm)
  const inDegree = {};
  nodes.forEach(n => { inDegree[n.id] = predArr[n.id].length; });
  const sources = nodes.filter(n => inDegree[n.id] === 0).map(n => n.id);
  if (sources.length === 0) sources.push(nodes[0].id);
  const topoOrder = [];
  const topoVis = new Set(sources);
  let qi = 0;
  const topoQ = [...sources];
  while (qi < topoQ.length) {
    const cur = topoQ[qi++];
    topoOrder.push(cur);
    for (const nxt of succArr[cur]) {
      if (!topoVis.has(nxt)) { topoVis.add(nxt); topoQ.push(nxt); }
    }
  }
  // Any nodes not visited (cycles) get appended
  nodes.forEach(n => { if (!topoVis.has(n.id)) topoOrder.push(n.id); });

  // Longest path layer assignment
  const layerOf = {};
  topoOrder.forEach(id => {
    const preds = predArr[id] || [];
    layerOf[id] = preds.length === 0 ? 0 : Math.max(...preds.map(p => (layerOf[p] || 0) + 1));
  });

  // Node promotion: push nodes as close to their successors as possible
  // (minimises long edges — ELK's "network simplex" lite)
  const revTopo = [...topoOrder].reverse();
  for (let pass = 0; pass < 3; pass++) {
    revTopo.forEach(id => {
      const succs = succArr[id] || [];
      if (succs.length > 0) {
        const maxAllowed = Math.min(...succs.map(s => layerOf[s])) - 1;
        if (maxAllowed > layerOf[id]) layerOf[id] = maxAllowed;
      }
    });
  }

  // Build layer groups
  const layers = {};
  nodes.forEach(n => {
    const l = layerOf[n.id];
    if (!layers[l]) layers[l] = [];
    layers[l].push(n);
  });
  const layerKeys = Object.keys(layers).map(Number).sort((a, b) => a - b);

  // ---- PHASE 2: CROSSING MINIMISATION ----
  // Initial ordering by connectivity
  layerKeys.forEach(lk => {
    layers[lk].forEach((n, i) => { n._order = i; });
  });

  function getBarycenter(nodeId, neighbourIds) {
    const nbrs = neighbourIds.filter(id => nodeMap[id] && nodeMap[id]._order !== undefined);
    if (nbrs.length === 0) return -1;
    let sum = 0;
    for (const id of nbrs) sum += nodeMap[id]._order;
    return sum / nbrs.length;
  }

  // Barycenter ordering
  function barySort(layer, getNeighbours) {
    const scored = layer.map(n => ({
      n,
      bc: getBarycenter(n.id, getNeighbours(n.id))
    }));
    // Stable sort: nodes without connections keep their position
    scored.sort((a, b) => {
      if (a.bc < 0 && b.bc < 0) return 0;
      if (a.bc < 0) return 0;
      if (b.bc < 0) return 0;
      return a.bc - b.bc;
    });
    const result = scored.map(s => s.n);
    result.forEach((n, i) => { n._order = i; });
    return result;
  }

  // Count edge crossings between adjacent layers
  function countCrossings(upper, lower) {
    const lowerPos = {};
    lower.forEach((n, i) => { lowerPos[n.id] = i; });
    const segments = [];
    upper.forEach((n, ui) => {
      for (const s of succArr[n.id]) {
        if (lowerPos[s] !== undefined) segments.push([ui, lowerPos[s]]);
      }
    });
    let c = 0;
    for (let i = 0; i < segments.length; i++) {
      for (let j = i + 1; j < segments.length; j++) {
        if ((segments[i][0] - segments[j][0]) * (segments[i][1] - segments[j][1]) < 0) c++;
      }
    }
    return c;
  }

  // Sifting: try moving each node to every position in its layer
  function sift(layer, layerIdx) {
    for (let ni = 0; ni < layer.length; ni++) {
      const node = layer[ni];
      let bestPos = ni;
      // Remove node
      const without = layer.filter((_, i) => i !== ni);
      let bestCost = Infinity;
      for (let pos = 0; pos <= without.length; pos++) {
        const trial = [...without];
        trial.splice(pos, 0, node);
        trial.forEach((n, i) => { n._order = i; });
        let cost = 0;
        if (layerIdx > 0) cost += countCrossings(layers[layerKeys[layerIdx - 1]], trial);
        if (layerIdx < layerKeys.length - 1) cost += countCrossings(trial, layers[layerKeys[layerIdx + 1]]);
        if (cost < bestCost) { bestCost = cost; bestPos = pos; }
      }
      // Place at best position
      const final_ = without;
      final_.splice(bestPos, 0, node);
      final_.forEach((n, i) => { n._order = i; });
      layers[layerKeys[layerIdx]] = final_;
    }
    return layers[layerKeys[layerIdx]];
  }

  // Run 8 sweeps of barycenter + 2 final sifting passes
  for (let iter = 0; iter < 8; iter++) {
    for (let li = 1; li < layerKeys.length; li++) {
      layers[layerKeys[li]] = barySort(layers[layerKeys[li]], id => predArr[id] || []);
    }
    for (let li = layerKeys.length - 2; li >= 0; li--) {
      layers[layerKeys[li]] = barySort(layers[layerKeys[li]], id => succArr[id] || []);
    }
  }
  // Sifting passes for fine-tuning
  for (let si = 0; si < 2; si++) {
    for (let li = 1; li < layerKeys.length; li++) {
      layers[layerKeys[li]] = sift(layers[layerKeys[li]], li);
    }
  }

  // ---- PHASE 3: NODE PLACEMENT ----
  // ELK-style: place nodes in each layer, then align to median of connected
  // nodes using iterative displacement with full overlap resolution.
  const isLR = DIR === 'LR';

  function nodeSize(n) { return isLR ? n._h : n._w; }
  function getPos(n) { return isLR ? n._y : n._x; }
  function setPos(n, v) { if (isLR) n._y = v; else n._x = v; }
  function setFixed(n, li) {
    if (isLR) n._x = 40 + li * LAYER_GAP;
    else n._y = 40 + li * LAYER_GAP;
  }

  // Initial compact placement
  layerKeys.forEach((lk, li) => {
    const group = layers[lk];
    let offset = 0;
    group.forEach(n => {
      setFixed(n, li);
      setPos(n, offset);
      offset += nodeSize(n) + NODE_GAP;
    });
  });

  // Compute median position of connected nodes in adjacent layers
  function medianOf(nodeId, neighbourIds) {
    const positions = [];
    for (const id of neighbourIds) {
      const nb = nodeMap[id];
      if (nb) positions.push(getPos(nb) + nodeSize(nb) / 2);
    }
    if (positions.length === 0) return null;
    positions.sort((a, b) => a - b);
    const mid = Math.floor(positions.length / 2);
    if (positions.length % 2 === 1) return positions[mid];
    return (positions[mid - 1] + positions[mid]) / 2;
  }

  // Resolve overlaps in a layer by pushing nodes apart
  function resolveOverlaps(group) {
    group.sort((a, b) => getPos(a) - getPos(b));
    for (let i = 1; i < group.length; i++) {
      const prev = group[i - 1];
      const cur = group[i];
      const minStart = getPos(prev) + nodeSize(prev) + NODE_GAP;
      if (getPos(cur) < minStart) setPos(cur, minStart);
    }
  }

  // Iterative median alignment (the core of ELK's Brandes-Köpf)
  // Do many passes alternating direction, with decreasing shift factor
  for (let iter = 0; iter < 20; iter++) {
    const downward = iter % 2 === 0;
    const keys = downward ? layerKeys.slice() : layerKeys.slice().reverse();

    keys.forEach(lk => {
      const group = layers[lk];
      group.forEach(n => {
        const nbrs = downward ? (predArr[n.id] || []) : (succArr[n.id] || []);
        const med = medianOf(n.id, nbrs);
        if (med === null) return;
        const current = getPos(n) + nodeSize(n) / 2;
        const diff = med - current;
        // Move the full distance — overlaps resolved after
        setPos(n, getPos(n) + diff);
      });
      resolveOverlaps(group);
    });
  }

  // Final centering: center the entire graph around the widest layer
  let globalMin = Infinity, globalMax = -Infinity;
  layerKeys.forEach(lk => {
    const group = layers[lk];
    if (group.length === 0) return;
    const first = getPos(group[0]);
    const last = getPos(group[group.length - 1]) + nodeSize(group[group.length - 1]);
    globalMin = Math.min(globalMin, first);
    globalMax = Math.max(globalMax, last);
  });
  const globalMid = (globalMin + globalMax) / 2;

  layerKeys.forEach(lk => {
    const group = layers[lk];
    if (group.length === 0) return;
    const first = getPos(group[0]);
    const last = getPos(group[group.length - 1]) + nodeSize(group[group.length - 1]);
    const layerMid = (first + last) / 2;
    const shift = globalMid - layerMid;
    group.forEach(n => setPos(n, getPos(n) + shift));
  });

  // Ensure no negative coordinates
  let minX = Infinity, minY = Infinity;
  nodes.forEach(n => { minX = Math.min(minX, n._x); minY = Math.min(minY, n._y); });
  const dx = minX < 30 ? 30 - minX : 0;
  const dy = minY < 30 ? 30 - minY : 0;
  if (dx > 0 || dy > 0) nodes.forEach(n => { n._x += dx; n._y += dy; });

  // Compute bounds
  let maxW = 0, maxH = 0;
  nodes.forEach(n => {
    maxW = Math.max(maxW, n._x + n._w + 40);
    maxH = Math.max(maxH, n._y + n._h + 40);
  });

  computePortPositions(nodes);
  return { nodes, edges, nodeMap, maxW, maxH };
}

function computePortPositions(nodes) {
  nodes.forEach(n => {
    n._inPorts = {};  // edge connection points (at module boundary)
    n._outPorts = {};
    n._inJacks = {};  // visual jack positions (inside module)
    n._outJacks = {};
    const portStart = n._y + MOD_NAME_H + (n._paramH || 0);
    let curY = portStart;
    // Input jacks grid
    if (n.inputs.length > 0) {
      curY += PORT_LABEL_H;
      const cols = n._inCols || 1;
      const gridW = cols * JACK_CELL_W;
      const gx = n._x + (n._w - gridW) / 2;
      n.inputs.forEach((p, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const jx = gx + col * JACK_CELL_W + JACK_CELL_W / 2;
        const jy = curY + row * JACK_CELL_H + JACK_R + 2;
        n._inJacks[p] = { x: jx, y: jy };
        n._inPorts[p] = { x: n._x, y: jy };
      });
      curY += (n._inRows || 1) * JACK_CELL_H;
    }
    // Output jacks grid
    if (n.outputs.length > 0) {
      curY += PORT_LABEL_H;
      const cols = n._outCols || 1;
      const gridW = cols * JACK_CELL_W;
      const gx = n._x + (n._w - gridW) / 2;
      n.outputs.forEach((p, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const jx = gx + col * JACK_CELL_W + JACK_CELL_W / 2;
        const jy = curY + row * JACK_CELL_H + JACK_R + 2;
        n._outJacks[p] = { x: jx, y: jy };
        n._outPorts[p] = { x: n._x + n._w, y: jy };
      });
    }
  });
}

// ================================================================
//  STATE
// ================================================================
let layoutResult = elkLayout(DATA);
const svgEl = document.getElementById('canvas');
const rootEl = document.getElementById('root');
let scale = 1, tx = 0, ty = 0;
let selectedModuleId = null;
let selectedModules = new Set();  // multi-select

// Interaction modes
let dragModule = null;      // { node, startMX, startMY, origPositions: Map }
let dragConn   = null;      // { nodeId, port, isOutput, x, y }
let rubberBand = null;      // { startX, startY, rect: SVGRect }
let rubberBandJustFinished = false;
let pendingLine = null;

// ================================================================
//  RENDER
// ================================================================
function renderAll() {
  const { nodes, edges, nodeMap, maxW, maxH } = layoutResult;
  rootEl.innerHTML = '';

  // --- Nodes (drawn first, below edges) ---
  nodes.forEach(n => {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('data-module', n.id);
    const baseColor = moduleColor(n.moduleType);

    // SVG defs for this module (gradient)
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    const gradId = 'grad-' + n.id.replace(/[^a-zA-Z0-9]/g, '_');
    const grad = document.createElementNS('http://www.w3.org/2000/svg', 'linearGradient');
    grad.setAttribute('id', gradId);
    grad.setAttribute('x1', '0%'); grad.setAttribute('y1', '0%');
    grad.setAttribute('x2', '100%'); grad.setAttribute('y2', '100%');
    const stop1 = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
    stop1.setAttribute('offset', '0%'); stop1.setAttribute('stop-color', lightenColor(baseColor, 20));
    const stop2 = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
    stop2.setAttribute('offset', '100%'); stop2.setAttribute('stop-color', darkenColor(baseColor, 15));
    grad.appendChild(stop1); grad.appendChild(stop2);
    defs.appendChild(grad);
    g.appendChild(defs);

    // Panel body (rounded rect)
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', n._x);
    rect.setAttribute('y', n._y);
    rect.setAttribute('width', n._w);
    rect.setAttribute('height', n._h);
    rect.setAttribute('rx', '4'); rect.setAttribute('ry', '4');
    rect.setAttribute('class', 'module-box' + (selectedModules.has(n.id) || selectedModuleId === n.id ? ' selected' : ''));
    rect.setAttribute('fill', 'url(#' + gradId + ')');
    rect.addEventListener('pointerdown', ev => onModulePointerDown(ev, n));
    g.appendChild(rect);

    // Top edge highlight (subtle 3D bevel)
    const hl = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    hl.setAttribute('x', n._x + 1); hl.setAttribute('y', n._y + 1);
    hl.setAttribute('width', n._w - 2); hl.setAttribute('height', 2);
    hl.setAttribute('rx', '3'); hl.setAttribute('fill', 'rgba(255,255,255,0.08)');
    hl.setAttribute('class', 'module-highlight');
    g.appendChild(hl);

    // Screw holes (4 corners)
    const screwR = 3.5;
    const screwInset = 8;
    const screwPositions = [
      [n._x + screwInset, n._y + screwInset],
      [n._x + n._w - screwInset, n._y + screwInset],
      [n._x + screwInset, n._y + n._h - screwInset],
      [n._x + n._w - screwInset, n._y + n._h - screwInset]
    ];
    screwPositions.forEach(([sx, sy]) => {
      const sc = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      sc.setAttribute('cx', sx); sc.setAttribute('cy', sy);
      sc.setAttribute('r', screwR); sc.setAttribute('class', 'module-screw');
      g.appendChild(sc);
      // Cross slot on screw
      const sl = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      sl.setAttribute('x1', sx - 2); sl.setAttribute('y1', sy);
      sl.setAttribute('x2', sx + 2); sl.setAttribute('y2', sy);
      sl.setAttribute('class', 'screw-slot');
      g.appendChild(sl);
    });

    // Module name
    const nameEl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    nameEl.setAttribute('x', n._x + n._w / 2);
    nameEl.setAttribute('y', n._y + 22);
    nameEl.setAttribute('class', 'module-name');
    nameEl.textContent = n.name.toUpperCase();
    g.appendChild(nameEl);

    // Manufacturer
    if (n.manufacturer) {
      const mfr = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      mfr.setAttribute('x', n._x + n._w / 2);
      mfr.setAttribute('y', n._y + 33);
      mfr.setAttribute('class', 'module-manufacturer');
      mfr.textContent = n.manufacturer;
      g.appendChild(mfr);
    }

    // Header separator (engraved line)
    const sep = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    sep.setAttribute('x1', n._x + 12); sep.setAttribute('y1', n._y + MOD_NAME_H);
    sep.setAttribute('x2', n._x + n._w - 12); sep.setAttribute('y2', n._y + MOD_NAME_H);
    sep.setAttribute('stroke', 'rgba(0,0,0,0.3)'); sep.setAttribute('stroke-width', '1');
    g.appendChild(sep);
    const sep2 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    sep2.setAttribute('x1', n._x + 12); sep2.setAttribute('y1', n._y + MOD_NAME_H + 1);
    sep2.setAttribute('x2', n._x + n._w - 12); sep2.setAttribute('y2', n._y + MOD_NAME_H + 1);
    sep2.setAttribute('stroke', 'rgba(255,255,255,0.06)'); sep2.setAttribute('stroke-width', '1');
    g.appendChild(sep2);

    // Parameters (knob grid — above ports)
    const allP = [
      ...n._allParamKeys.map(pk => ({ key: pk, val: n.params[pk], isSet: true })),
      ...n._unsetCatParams.map(cp => ({ key: cp, val: null, isSet: false }))
    ];
    if (allP.length > 0) {
      const cols = n._knobCols || 2;
      const gridW = cols * KNOB_CELL_W;
      const gridOffsetX = n._x + (n._w - gridW) / 2;
      const gridStartY = n._y + MOD_NAME_H + 6;

      allP.forEach((p, pi) => {
        const col = pi % cols;
        const row = Math.floor(pi / cols);
        const cx = gridOffsetX + col * KNOB_CELL_W + KNOB_CELL_W / 2;
        const cy = gridStartY + row * KNOB_CELL_H + KNOB_R + 2;

        // Track arc (background arc from 135° to 405° = 225° sweep)
        const trackArc = describeArc(cx, cy, KNOB_R + 2, 135, 405);
        const track = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        track.setAttribute('d', trackArc);
        track.setAttribute('class', 'knob-track');
        g.appendChild(track);

        // Value arc (indicator — shows value position)
        if (p.isSet) {
          const knobPos = parseKnobValue(p.val);
          const valAngle = 135 + 270 * knobPos;
          const valArc = describeArc(cx, cy, KNOB_R + 2, 135, valAngle);
          const vArc = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          vArc.setAttribute('d', valArc);
          vArc.setAttribute('class', 'knob-indicator');
          g.appendChild(vArc);
        }

        // Knob body
        const body = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        body.setAttribute('cx', cx); body.setAttribute('cy', cy);
        body.setAttribute('r', KNOB_R);
        body.setAttribute('class', 'knob-body');
        body.addEventListener('click', ev => { ev.stopPropagation(); selectModule(n.id); });
        g.appendChild(body);

        // Knob cap (inner circle)
        const cap = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        cap.setAttribute('cx', cx); cap.setAttribute('cy', cy);
        cap.setAttribute('r', KNOB_R - 3);
        cap.setAttribute('class', 'knob-cap');
        g.appendChild(cap);

        // Pointer line
        if (p.isSet) {
          const knobPos2 = parseKnobValue(p.val);
          const ptrAngle = (135 + 270 * knobPos2) * Math.PI / 180;
          const px1 = cx + (KNOB_R - 6) * Math.cos(ptrAngle);
          const py1 = cy + (KNOB_R - 6) * Math.sin(ptrAngle);
          const px2 = cx + (KNOB_R - 1) * Math.cos(ptrAngle);
          const py2 = cy + (KNOB_R - 1) * Math.sin(ptrAngle);
          const ptr = document.createElementNS('http://www.w3.org/2000/svg', 'line');
          ptr.setAttribute('x1', px1); ptr.setAttribute('y1', py1);
          ptr.setAttribute('x2', px2); ptr.setAttribute('y2', py2);
          ptr.setAttribute('class', 'knob-pointer');
          g.appendChild(ptr);
        }

        // Label below knob
        const lbl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        lbl.setAttribute('x', cx);
        lbl.setAttribute('y', cy + KNOB_R + 11);
        lbl.setAttribute('class', 'param-label');
        lbl.textContent = p.key;
        g.appendChild(lbl);

        // Value below label (only if set)
        if (p.isSet && p.val) {
          const val = document.createElementNS('http://www.w3.org/2000/svg', 'text');
          val.setAttribute('x', cx);
          val.setAttribute('y', cy + KNOB_R + 19);
          val.setAttribute('class', 'param-value');
          val.textContent = p.val;
          val.addEventListener('click', ev => { ev.stopPropagation(); selectModule(n.id); });
          g.appendChild(val);
        }
      });

      // Separator between params and ports
      const sepY = n._y + MOD_NAME_H + n._paramH;
      const s3 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      s3.setAttribute('x1', n._x + 12); s3.setAttribute('y1', sepY - 2);
      s3.setAttribute('x2', n._x + n._w - 12); s3.setAttribute('y2', sepY - 2);
      s3.setAttribute('stroke', 'rgba(0,0,0,0.25)'); s3.setAttribute('stroke-width', '1');
      g.appendChild(s3);
    }

    // Input ports (jack grid)
    if (n.inputs.length > 0) {
      const portStart = n._y + MOD_NAME_H + (n._paramH || 0);
      // Section label
      const inLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      inLabel.setAttribute('x', n._x + n._w / 2);
      inLabel.setAttribute('y', portStart + 10);
      inLabel.setAttribute('class', 'port-section-label');
      inLabel.textContent = 'IN';
      g.appendChild(inLabel);

      n.inputs.forEach(p => {
        const jack = n._inJacks[p];
        if (!jack) return;
        // Outer ring
        const ring = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        ring.setAttribute('cx', jack.x); ring.setAttribute('cy', jack.y);
        ring.setAttribute('r', JACK_R + 2); ring.setAttribute('class', 'port-ring in');
        g.appendChild(ring);
        // Inner hole (interactive)
        const dot = makePortDot(jack.x, jack.y, 'in', n.id, p);
        g.appendChild(dot);
        // Label below jack
        const lbl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        lbl.setAttribute('x', jack.x);
        lbl.setAttribute('y', jack.y + JACK_R + 10);
        lbl.setAttribute('class', 'port-label'); lbl.setAttribute('text-anchor', 'middle');
        lbl.textContent = p;
        g.appendChild(lbl);
      });
    }

    // Output ports (jack grid)
    if (n.outputs.length > 0) {
      const portStart = n._y + MOD_NAME_H + (n._paramH || 0);
      let outLabelY = portStart;
      if (n.inputs.length > 0) {
        outLabelY += PORT_LABEL_H + (n._inRows || 1) * JACK_CELL_H;
      }
      // Section label
      const outLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      outLabel.setAttribute('x', n._x + n._w / 2);
      outLabel.setAttribute('y', outLabelY + 10);
      outLabel.setAttribute('class', 'port-section-label');
      outLabel.textContent = 'OUT';
      g.appendChild(outLabel);

      n.outputs.forEach(p => {
        const jack = n._outJacks[p];
        if (!jack) return;
        // Outer ring
        const ring = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        ring.setAttribute('cx', jack.x); ring.setAttribute('cy', jack.y);
        ring.setAttribute('r', JACK_R + 2); ring.setAttribute('class', 'port-ring out');
        g.appendChild(ring);
        // Inner hole (interactive)
        const dot = makePortDot(jack.x, jack.y, 'out', n.id, p);
        g.appendChild(dot);
        // Label below jack
        const lbl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        lbl.setAttribute('x', jack.x);
        lbl.setAttribute('y', jack.y + JACK_R + 10);
        lbl.setAttribute('class', 'port-label'); lbl.setAttribute('text-anchor', 'middle');
        lbl.textContent = p;
        g.appendChild(lbl);
      });
    }

    rootEl.appendChild(g);
  });

  // --- Edges (drawn on top of modules) ---
  var edgeTooltip = document.getElementById('edge-tooltip');
  edges.forEach((e, ei) => {
    const fn = nodeMap[e.from], tn = nodeMap[e.to];
    if (!fn || !tn) return;
    const src = fn._outJacks && fn._outJacks[e.fromPort];
    const dst = tn._inJacks  && tn._inJacks[e.toPort];
    if (!src || !dst) return;

    // Invisible wider hit-area path for easier hover
    const hitPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const d = bezier(src.x, src.y, dst.x, dst.y);
    hitPath.setAttribute('d', d);
    hitPath.setAttribute('fill', 'none');
    hitPath.setAttribute('stroke', 'transparent');
    hitPath.setAttribute('stroke-width', '16');
    hitPath.setAttribute('cursor', 'pointer');
    hitPath.setAttribute('pointer-events', 'stroke');

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    path.setAttribute('class', 'edge ' + e.type);
    path.style.pointerEvents = 'none';

    hitPath.addEventListener('click', ev => {
      ev.stopPropagation();
      selectModule(e.from);
    });
    hitPath.addEventListener('mouseenter', ev => {
      path.style.opacity = '1';
      path.style.strokeWidth = '4';
      path.style.filter = 'brightness(1.4)';
      edgeTooltip.textContent = fn.name + ' (' + e.fromPort + ') \u2192 ' + tn.name + ' (' + e.toPort + ')';
      edgeTooltip.style.display = 'block';
      edgeTooltip.style.left = ev.clientX + 12 + 'px';
      edgeTooltip.style.top = ev.clientY + 12 + 'px';
    });
    hitPath.addEventListener('mousemove', ev => {
      edgeTooltip.style.left = ev.clientX + 12 + 'px';
      edgeTooltip.style.top = ev.clientY + 12 + 'px';
    });
    hitPath.addEventListener('mouseleave', () => {
      path.style.opacity = '';
      path.style.strokeWidth = '';
      path.style.filter = '';
      edgeTooltip.style.display = 'none';
    });
    rootEl.appendChild(path);
    rootEl.appendChild(hitPath);
  });

  applyTransform();
}

function bezier(sx, sy, dx, dy) {
  const cx = Math.abs(dx - sx) * 0.55;
  return 'M'+sx+','+sy+' C'+(sx+cx)+','+sy+' '+(dx-cx)+','+dy+' '+dx+','+dy;
}

// SVG arc path for knob tracks/indicators
function polarToCart(cx, cy, r, deg) {
  const rad = deg * Math.PI / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}
function describeArc(cx, cy, r, startDeg, endDeg) {
  const start = polarToCart(cx, cy, r, startDeg);
  const end = polarToCart(cx, cy, r, endDeg);
  const sweep = endDeg - startDeg;
  const largeArc = Math.abs(sweep) > 180 ? 1 : 0;
  return 'M ' + start.x + ' ' + start.y + ' A ' + r + ' ' + r + ' 0 ' + largeArc + ' 1 ' + end.x + ' ' + end.y;
}

// Parse a parameter value string into a 0–1 knob position
function parseKnobValue(val) {
  if (val === null || val === undefined) return 0.5;
  var s = String(val).trim();
  // Percentage: "75%" → 0.75
  var pctMatch = s.match(/^([\d.]+)\s*%$/);
  if (pctMatch) {
    var pct = parseFloat(pctMatch[1]);
    if (!isNaN(pct)) return Math.max(0, Math.min(1, pct / 100));
  }
  // Number
  var num = parseFloat(s);
  if (!isNaN(num)) {
    // 0–100 range (likely percentage without %) 
    if (num >= 0 && num <= 100 && /^\d+$/.test(s) && num > 10) return Math.max(0, Math.min(1, num / 100));
    // 0–10 range (common knob scale)
    if (num >= 0 && num <= 10) return Math.max(0, Math.min(1, num / 10));
    // Negative or large: clamp
    if (num < 0) return 0;
    if (num > 100) return 1;
    return Math.max(0, Math.min(1, num / 100));
  }
  // Non-numeric (e.g. "LPF", "On") — center position
  return 0.5;
}

function makePortDot(cx, cy, dir, modId, port) {
  const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  dot.setAttribute('cx', cx); dot.setAttribute('cy', cy);
  dot.setAttribute('r', '5');
  dot.setAttribute('class', 'port-hole ' + dir);
  dot.setAttribute('data-module', modId);
  dot.setAttribute('data-port', port);
  dot.setAttribute('data-dir', dir);
  dot.addEventListener('pointerdown', onPortDown);
  dot.addEventListener('pointerup', onPortUp);
  dot.addEventListener('pointerenter', ev => { if (dragConn) ev.target.classList.add('drag-target'); });
  dot.addEventListener('pointerleave', ev => { ev.target.classList.remove('drag-target'); });
  return dot;
}

// ================================================================
//  TRANSFORM  (pan + zoom-to-cursor)
// ================================================================
function applyTransform() {
  rootEl.setAttribute('transform', 'translate('+tx+','+ty+') scale('+scale+')');
}

function zoomAt(clientX, clientY, factor) {
  const newScale = Math.max(0.05, Math.min(10, scale * factor));
  const realFactor = newScale / scale;
  const rect = svgEl.getBoundingClientRect();
  const mx = clientX - rect.left;
  const my = clientY - rect.top;
  tx = mx - realFactor * (mx - tx);
  ty = my - realFactor * (my - ty);
  scale = newScale;
  applyTransform();
}

function zoomIn()  { zoomAt(svgEl.clientWidth / 2, svgEl.clientHeight / 2, 1.25); }
function zoomOut() { zoomAt(svgEl.clientWidth / 2, svgEl.clientHeight / 2, 0.8); }
function resetView() {
  layoutResult = elkLayout(DATA);
  scale = 1; tx = 0; ty = 0;
  renderAll();
  setTimeout(fitAll, 20);
}

function fitAll() {
  const nodes = layoutResult.nodes;
  if (nodes.length === 0) return;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  nodes.forEach(n => {
    x0 = Math.min(x0, n._x); y0 = Math.min(y0, n._y);
    x1 = Math.max(x1, n._x + n._w); y1 = Math.max(y1, n._y + n._h);
  });
  const gw = x1 - x0, gh = y1 - y0;
  if (gw <= 0 || gh <= 0) return;
  const pad = 60;
  const vw = svgEl.clientWidth, vh = svgEl.clientHeight;
  scale = Math.min((vw - pad) / gw, (vh - pad) / gh, 1.5);
  tx = (vw - gw * scale) / 2 - x0 * scale;
  ty = (vh - gh * scale) / 2 - y0 * scale;
  applyTransform();
}

// Wheel: Cmd/Ctrl+scroll = zoom, plain scroll = pan
svgEl.addEventListener('wheel', ev => {
  ev.preventDefault();
  if (ev.metaKey || ev.ctrlKey) {
    // Zoom toward cursor
    const raw = ev.deltaMode === 1 ? ev.deltaY * 40 : ev.deltaY;
    const clamped = Math.max(-300, Math.min(300, raw));
    const f = Math.pow(2, -clamped / 300);
    zoomAt(ev.clientX, ev.clientY, f);
  } else {
    // Pan
    const dx = ev.deltaMode === 1 ? ev.deltaX * 40 : ev.deltaX;
    const dy = ev.deltaMode === 1 ? ev.deltaY * 40 : ev.deltaY;
    tx -= dx;
    ty -= dy;
    applyTransform();
  }
}, { passive: false });

// ================================================================
//  MODULE DRAGGING & RUBBER-BAND SELECTION
// ================================================================
function onModulePointerDown(ev, node) {
  if (ev.button !== 0) return;
  ev.stopPropagation();
  const pt = clientToWorld(ev.clientX, ev.clientY);
  // If clicking a module not in selection, select only it (unless Shift)
  if (!ev.shiftKey && !selectedModules.has(node.id)) {
    selectedModules.clear();
    selectedModules.add(node.id);
  } else if (ev.shiftKey) {
    // Toggle selection
    if (selectedModules.has(node.id)) selectedModules.delete(node.id);
    else selectedModules.add(node.id);
  }
  // If not in selection yet, add it
  if (!selectedModules.has(node.id)) selectedModules.add(node.id);
  // Save original positions of all selected modules
  const origPositions = new Map();
  selectedModules.forEach(id => {
    const n = layoutResult.nodeMap[id];
    if (n) origPositions.set(id, { x: n._x, y: n._y });
  });
  dragModule = { node, startMX: pt.x, startMY: pt.y, origPositions, moved: false };
  renderAll();
}

let rafPending = false;
svgEl.addEventListener('pointermove', ev => {
  // --- Module drag (moves all selected) ---
  if (dragModule) {
    const pt = clientToWorld(ev.clientX, ev.clientY);
    const dx = pt.x - dragModule.startMX;
    const dy = pt.y - dragModule.startMY;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) dragModule.moved = true;
    dragModule.origPositions.forEach((orig, id) => {
      const n = layoutResult.nodeMap[id];
      if (n) { n._x = orig.x + dx; n._y = orig.y + dy; }
    });
    computePortPositions(layoutResult.nodes.filter(n => selectedModules.has(n.id)));
    if (!rafPending) { rafPending = true; requestAnimationFrame(() => { rafPending = false; renderAll(); }); }
    return;
  }

  // --- Connection drag line ---
  if (dragConn && pendingLine) {
    const pt = clientToWorld(ev.clientX, ev.clientY);
    const sx = dragConn.x, sy = dragConn.y;
    pendingLine.setAttribute('d', bezier(sx, sy, pt.x, pt.y));
    return;
  }

  // --- Rubber-band selection ---
  if (rubberBand) {
    const pt = clientToWorld(ev.clientX, ev.clientY);
    const x = Math.min(rubberBand.startX, pt.x);
    const y = Math.min(rubberBand.startY, pt.y);
    const w = Math.abs(pt.x - rubberBand.startX);
    const h = Math.abs(pt.y - rubberBand.startY);
    rubberBand.rect.setAttribute('x', x);
    rubberBand.rect.setAttribute('y', y);
    rubberBand.rect.setAttribute('width', w);
    rubberBand.rect.setAttribute('height', h);
    // Highlight modules inside the rubber-band in real-time
    const rx1 = x, ry1 = y, rx2 = x + w, ry2 = y + h;
    layoutResult.nodes.forEach(n => {
      const inside = n._x + n._w >= rx1 && n._x <= rx2 && n._y + n._h >= ry1 && n._y <= ry2;
      const shouldSelect = inside || selectedModules.has(n.id);
      const g = rootEl.querySelector('g[data-module="' + n.id.replace(/"/g, '\\\\"') + '"]');
      if (g && g.firstElementChild) {
        const cls = 'module-box' + (shouldSelect ? ' selected' : '');
        if (g.firstElementChild.getAttribute('class') !== cls) {
          g.firstElementChild.setAttribute('class', cls);
        }
      }
    });
    return;
  }
});

svgEl.addEventListener('pointerup', ev => {
  if (dragModule) {
    if (!dragModule.moved) {
      // Click without move: select single module
      if (!ev.shiftKey) {
        selectedModules.clear();
        selectedModules.add(dragModule.node.id);
      }
      selectModule(dragModule.node.id);
    }
    dragModule = null;
    return;
  }
  if (dragConn) {
    tryFinishConnection(ev.clientX, ev.clientY);
    cleanupConnDrag();
    return;
  }
  if (rubberBand) {
    // Find all modules inside the rubber-band rectangle
    const pt = clientToWorld(ev.clientX, ev.clientY);
    const rx1 = Math.min(rubberBand.startX, pt.x);
    const ry1 = Math.min(rubberBand.startY, pt.y);
    const rx2 = Math.max(rubberBand.startX, pt.x);
    const ry2 = Math.max(rubberBand.startY, pt.y);
    if (!ev.shiftKey) selectedModules.clear();
    layoutResult.nodes.forEach(n => {
      // Module is inside if it overlaps the selection rect
      if (n._x + n._w >= rx1 && n._x <= rx2 && n._y + n._h >= ry1 && n._y <= ry2) {
        selectedModules.add(n.id);
      }
    });
    // Remove the rubber-band rect
    if (rubberBand.rect.parentNode) rubberBand.rect.parentNode.removeChild(rubberBand.rect);
    rubberBand = null;
    rubberBandJustFinished = true;
    selectedModuleId = null;
    vscodeApi.postMessage({ type: 'selectionChanged', hasSelection: selectedModules.size > 0 });
    renderAll();
    return;
  }
});

svgEl.addEventListener('pointerdown', ev => {
  if (ev.target === svgEl || ev.target === rootEl) {
    if (ev.button !== 0) return;
    // Start rubber-band selection on background
    const pt = clientToWorld(ev.clientX, ev.clientY);
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('id', 'select-rect');
    rect.setAttribute('x', pt.x);
    rect.setAttribute('y', pt.y);
    rect.setAttribute('width', 0);
    rect.setAttribute('height', 0);
    rootEl.appendChild(rect);
    rubberBand = { startX: pt.x, startY: pt.y, rect };
  }
});

svgEl.addEventListener('pointerleave', () => {
  if (rubberBand) {
    if (rubberBand.rect.parentNode) rubberBand.rect.parentNode.removeChild(rubberBand.rect);
    rubberBand = null;
  }
});

function clientToWorld(cx, cy) {
  const r = svgEl.getBoundingClientRect();
  return { x: (cx - r.left - tx) / scale, y: (cy - r.top - ty) / scale };
}

// ================================================================
//  PORT-DRAG CONNECTION CREATION
// ================================================================
function onPortDown(ev) {
  ev.stopPropagation();
  ev.preventDefault();
  const dot = ev.currentTarget;
  const modId = dot.getAttribute('data-module');
  const port  = dot.getAttribute('data-port');
  const dir   = dot.getAttribute('data-dir');
  const cx = parseFloat(dot.getAttribute('cx'));
  const cy = parseFloat(dot.getAttribute('cy'));
  dragConn = { nodeId: modId, port: port, isOutput: dir === 'out', x: cx, y: cy };

  pendingLine = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  pendingLine.setAttribute('class', 'edge pending');
  rootEl.appendChild(pendingLine);
}

function onPortUp(ev) {
  // Handled by tryFinishConnection in the SVG pointerup handler
}

// Find the nearest compatible port within a generous radius and propose a connection
function tryFinishConnection(clientX, clientY) {
  if (!dragConn) return;
  const dropPt = clientToWorld(clientX, clientY);
  const HIT_RADIUS = 20; // world-coord pixels
  let bestDist = HIT_RADIUS;
  let bestMod = null, bestPort = null, bestDir = null;

  layoutResult.nodes.forEach(n => {
    const jacks = dragConn.isOutput ? n._inJacks : n._outJacks;
    const dir   = dragConn.isOutput ? 'in' : 'out';
    if (!jacks) return;
    for (const pName in jacks) {
      // For self-connections, require a different port
      if (n.id === dragConn.nodeId && pName === dragConn.port) continue;
      const pp = jacks[pName];
      const d = Math.hypot(pp.x - dropPt.x, pp.y - dropPt.y);
      if (d < bestDist) {
        bestDist = d; bestMod = n.id; bestPort = pName; bestDir = dir;
      }
    }
  });

  if (bestMod && bestPort) {
    const from     = dragConn.isOutput ? dragConn.nodeId : bestMod;
    const fromPort = dragConn.isOutput ? dragConn.port   : bestPort;
    const to       = dragConn.isOutput ? bestMod : dragConn.nodeId;
    const toPort   = dragConn.isOutput ? bestPort : dragConn.port;
    showConnTypeSelector(clientX, clientY, from, fromPort, to, toPort);
  }
}

function cleanupConnDrag() {
  dragConn = null;
  if (pendingLine && pendingLine.parentNode) pendingLine.parentNode.removeChild(pendingLine);
  pendingLine = null;
  document.querySelectorAll('.drag-target').forEach(el => el.classList.remove('drag-target'));
}

// ================================================================
//  MODULE ADD / REMOVE (graph toolbar)
// ================================================================
function requestAddModule() {
  vscodeApi.postMessage({ type: 'addModule' });
}
function requestRemoveModule() {
  if (selectedModuleId) {
    vscodeApi.postMessage({ type: 'removeModule', moduleName: selectedModuleId });
    closeInspector();
  }
}

// Canvas color utilities for export
function lightenColorCanvas(hex, percent) {
  var r = parseInt(hex.slice(1,3), 16);
  var g = parseInt(hex.slice(3,5), 16);
  var b = parseInt(hex.slice(5,7), 16);
  var amt = Math.round(2.55 * percent);
  return '#' + (
    (1 << 24) +
    (Math.min(255, r + amt) << 16) +
    (Math.min(255, g + amt) << 8) +
    Math.min(255, b + amt)
  ).toString(16).slice(1);
}
function darkenColorCanvas(hex, percent) {
  var r = parseInt(hex.slice(1,3), 16);
  var g = parseInt(hex.slice(3,5), 16);
  var b = parseInt(hex.slice(5,7), 16);
  var amt = Math.round(2.55 * percent);
  return '#' + (
    (1 << 24) +
    (Math.max(0, r - amt) << 16) +
    (Math.max(0, g - amt) << 8) +
    Math.max(0, b - amt)
  ).toString(16).slice(1);
}

function exportGraphImage() {
  var nodes = layoutResult.nodes;
  var edges = layoutResult.edges;
  var nodeMap = layoutResult.nodeMap;
  if (nodes.length === 0) {
    vscodeApi.postMessage({ type: 'graphImage', dataUrl: null, width: 0, height: 0 });
    return;
  }

  // Compute graph bounds
  var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  nodes.forEach(function(n) {
    x0 = Math.min(x0, n._x); y0 = Math.min(y0, n._y);
    x1 = Math.max(x1, n._x + n._w); y1 = Math.max(y1, n._y + n._h);
  });
  var pad = 40;
  var ox = -x0 + pad;
  var oy = -y0 + pad;
  var gw = Math.ceil(x1 - x0 + pad * 2);
  var gh = Math.ceil(y1 - y0 + pad * 2);

  // Legend sizing
  var legendW = 190;
  var usedTypes = {};
  nodes.forEach(function(n) { usedTypes[n.moduleType] = true; });
  var sortedTypes = Object.keys(usedTypes).sort();
  var legendItemH = 20;
  var legendH = 40 + sortedTypes.length * legendItemH + 30 + 6 * legendItemH + 20;

  var totalW = gw + legendW + 20;
  var totalH = Math.max(gh, legendH + 40);

  var dpr = 2;
  var canvas = document.createElement('canvas');
  canvas.width = totalW * dpr;
  canvas.height = totalH * dpr;
  var ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  // White background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, totalW, totalH);

  // Light gray graph area
  ctx.fillStyle = '#f0f0f0';
  ctx.fillRect(0, 0, gw, totalH);

  // Edge colors for light background
  var edgeColors = {
    audio: '#333333', cv: '#666666', gate: '#cc2222',
    trigger: '#cc6600', pitch: '#2266cc', clock: '#7733bb'
  };
  var edgeDashed = { gate: true, trigger: true, clock: true };

  // Draw nodes (Eurorack panel style)
  nodes.forEach(function(n) {
    var nx = n._x + ox, ny = n._y + oy;
    var nw = n._w, nh = n._h;
    var r = 4;
    var bc = moduleColor(n.moduleType);

    // Panel gradient
    var panelGrad = ctx.createLinearGradient(nx, ny, nx + nw, ny + nh);
    panelGrad.addColorStop(0, lightenColorCanvas(bc, 20));
    panelGrad.addColorStop(1, darkenColorCanvas(bc, 15));

    // Rounded rect fill
    ctx.save();
    ctx.fillStyle = panelGrad;
    ctx.beginPath();
    ctx.moveTo(nx + r, ny);
    ctx.lineTo(nx + nw - r, ny);
    ctx.arcTo(nx + nw, ny, nx + nw, ny + r, r);
    ctx.lineTo(nx + nw, ny + nh - r);
    ctx.arcTo(nx + nw, ny + nh, nx + nw - r, ny + nh, r);
    ctx.lineTo(nx + r, ny + nh);
    ctx.arcTo(nx, ny + nh, nx, ny + nh - r, r);
    ctx.lineTo(nx, ny + r);
    ctx.arcTo(nx, ny, nx + r, ny, r);
    ctx.closePath();
    ctx.fill();

    // Stroke
    ctx.strokeStyle = '#999';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();

    // Screw holes
    var screwR = 3.5, screwInset = 8;
    var screws = [
      [nx + screwInset, ny + screwInset],
      [nx + nw - screwInset, ny + screwInset],
      [nx + screwInset, ny + nh - screwInset],
      [nx + nw - screwInset, ny + nh - screwInset]
    ];
    screws.forEach(function(s) {
      ctx.fillStyle = '#222';
      ctx.strokeStyle = '#555';
      ctx.lineWidth = 0.5;
      ctx.beginPath(); ctx.arc(s[0], s[1], screwR, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      // Slot
      ctx.strokeStyle = '#444';
      ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.moveTo(s[0] - 2, s[1]); ctx.lineTo(s[0] + 2, s[1]); ctx.stroke();
    });

    // Module name
    ctx.save();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(n.name.toUpperCase(), nx + nw / 2, ny + 16);
    ctx.restore();

    // Manufacturer
    if (n.manufacturer) {
      ctx.save();
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      ctx.font = '8px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(n.manufacturer, nx + nw / 2, ny + 28);
      ctx.restore();
    }

    // Header separator
    ctx.save();
    ctx.strokeStyle = 'rgba(0,0,0,0.3)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(nx + 12, ny + 38);
    ctx.lineTo(nx + nw - 12, ny + 38);
    ctx.stroke();
    ctx.restore();

    // Knob grid (parameters — above ports)
    var allParams = [];
    var setKeys = Object.keys(n.params);
    var setLower2 = {};
    setKeys.forEach(function(k) { setLower2[k.toLowerCase()] = true; });
    setKeys.forEach(function(pk) { allParams.push({ key: pk, val: n.params[pk], isSet: true }); });
    (n.catalogParams || []).forEach(function(cp) {
      if (!setLower2[cp.toLowerCase()]) allParams.push({ key: cp, val: null, isSet: false });
    });
    if (allParams.length > 0) {
      var kCols = n._knobCols || 2;
      var kGridW = kCols * 50;
      var kOffX = nx + (nw - kGridW) / 2;
      var kStartY = ny + 38 + 6;

      allParams.forEach(function(p, pi) {
        var col = pi % kCols;
        var row = Math.floor(pi / kCols);
        var kcx = kOffX + col * 50 + 25;
        var kcy = kStartY + row * 46 + 12;

        // Track arc
        ctx.save();
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(kcx, kcy, 12, 135 * Math.PI / 180, (135 + 270) * Math.PI / 180);
        ctx.stroke();
        ctx.restore();

        // Value arc
        if (p.isSet) {
          var kPos = parseKnobValue(p.val);
          ctx.save();
          ctx.strokeStyle = '#0af';
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.arc(kcx, kcy, 12, 135 * Math.PI / 180, (135 + 270 * kPos) * Math.PI / 180);
          ctx.stroke();
          ctx.restore();
        }

        // Knob body
        ctx.fillStyle = '#1a1a1a';
        ctx.strokeStyle = '#555';
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(kcx, kcy, 10, 0, Math.PI * 2); ctx.fill(); ctx.stroke();

        // Knob cap
        ctx.fillStyle = '#2a2a2a';
        ctx.strokeStyle = '#444';
        ctx.lineWidth = 0.5;
        ctx.beginPath(); ctx.arc(kcx, kcy, 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();

        // Pointer
        if (p.isSet) {
          var kPos2 = parseKnobValue(p.val);
          var ptrA = (135 + 270 * kPos2) * Math.PI / 180;
          ctx.strokeStyle = '#ddd';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(kcx + 4 * Math.cos(ptrA), kcy + 4 * Math.sin(ptrA));
          ctx.lineTo(kcx + 9 * Math.cos(ptrA), kcy + 9 * Math.sin(ptrA));
          ctx.stroke();
        }

        // Label
        ctx.fillStyle = '#aaa';
        ctx.font = '8px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(p.key, kcx, kcy + 22);

        // Value
        if (p.isSet && p.val) {
          ctx.fillStyle = '#ddd';
          ctx.font = '7px sans-serif';
          ctx.fillText(p.val, kcx, kcy + 30);
        }
      });
    }

    // Port jacks (grid layout)
    ctx.save();
    // Input section
    if (n.inputs && n.inputs.length > 0) {
      var inJacks = n._inJacks || {};
      // Section label
      var portStart2 = ny + 38 + (n._paramH || 0);
      ctx.fillStyle = 'rgba(255,255,255,0.3)';
      ctx.font = 'bold 8px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText('IN', nx + nw / 2, portStart2 + 10);

      ctx.font = '8px sans-serif';
      n.inputs.forEach(function(p) {
        var jack = inJacks[p];
        if (!jack) return;
        var jx = jack.x + ox, jy = jack.y + oy;
        // Outer ring
        ctx.strokeStyle = '#666'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(jx, jy, 8, 0, Math.PI * 2); ctx.stroke();
        // Inner hole
        ctx.fillStyle = '#111';
        ctx.beginPath(); ctx.arc(jx, jy, 6, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#555'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(jx, jy, 6, 0, Math.PI * 2); ctx.stroke();
        // Label
        ctx.fillStyle = '#bbb';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(p, jx, jy + 16);
      });
    }
    // Output section
    if (n.outputs && n.outputs.length > 0) {
      var outJacks = n._outJacks || {};
      var outLabelY2 = ny + 38 + (n._paramH || 0);
      if (n.inputs && n.inputs.length > 0) {
        outLabelY2 += 14 + (n._inRows || 1) * 30;
      }
      ctx.fillStyle = 'rgba(255,255,255,0.3)';
      ctx.font = 'bold 8px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText('OUT', nx + nw / 2, outLabelY2 + 10);

      ctx.font = '8px sans-serif';
      n.outputs.forEach(function(p) {
        var jack = outJacks[p];
        if (!jack) return;
        var jx = jack.x + ox, jy = jack.y + oy;
        // Outer ring
        ctx.strokeStyle = '#999'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(jx, jy, 8, 0, Math.PI * 2); ctx.stroke();
        // Inner hole
        ctx.fillStyle = '#1a1a1a';
        ctx.beginPath(); ctx.arc(jx, jy, 6, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#777'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(jx, jy, 6, 0, Math.PI * 2); ctx.stroke();
        // Label
        ctx.fillStyle = '#bbb';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(p, jx, jy + 16);
      });
    }
    ctx.restore();
  });

  // Draw edges on top of nodes
  edges.forEach(function(e) {
    var fn = nodeMap[e.from], tn = nodeMap[e.to];
    if (!fn || !tn) return;
    var src = fn._outJacks && fn._outJacks[e.fromPort];
    var dst = tn._inJacks && tn._inJacks[e.toPort];
    if (!src || !dst) return;

    var sx = src.x + ox, sy = src.y + oy;
    var dx = dst.x + ox, dy = dst.y + oy;
    var ecx = Math.abs(dx - sx) * 0.55;

    ctx.save();
    ctx.strokeStyle = edgeColors[e.type] || '#888888';
    ctx.lineWidth = e.type === 'audio' ? 2.5 : 2;
    if (edgeDashed[e.type]) ctx.setLineDash([6, 3]);
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.bezierCurveTo(sx + ecx, sy, dx - ecx, dy, dx, dy);
    ctx.stroke();
    ctx.restore();
  });

  // Legend (right side, white background)
  var lx = gw + 14;
  var ly = 24;
  ctx.fillStyle = '#333';
  ctx.font = 'bold 11px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('MODULE TYPES', lx, ly);
  ly += 8;

  ctx.font = '11px sans-serif';
  sortedTypes.forEach(function(t) {
    ly += legendItemH;
    ctx.fillStyle = moduleColor(t);
    ctx.fillRect(lx, ly - 12, 14, 14);
    ctx.strokeStyle = '#bbb';
    ctx.lineWidth = 0.5;
    ctx.strokeRect(lx, ly - 12, 14, 14);
    ctx.fillStyle = '#333';
    ctx.fillText(t, lx + 20, ly);
  });

  ly += 24;
  ctx.font = 'bold 11px sans-serif';
  ctx.fillStyle = '#333';
  ctx.fillText('CONNECTION TYPES', lx, ly);
  ly += 8;

  var connDefs = [
    { name: 'Audio',   color: '#666',    dash: false, w: 2.5 },
    { name: 'CV',      color: '#888',    dash: false, w: 2 },
    { name: 'Pitch',   color: '#4488ff', dash: false, w: 2 },
    { name: 'Gate',    color: '#ff4444', dash: true,  w: 2 },
    { name: 'Trigger', color: '#ff8800', dash: true,  w: 2 },
    { name: 'Clock',   color: '#aa44ff', dash: true,  w: 2 },
  ];
  ctx.font = '11px sans-serif';
  connDefs.forEach(function(ct) {
    ly += legendItemH;
    ctx.strokeStyle = ct.color;
    ctx.lineWidth = ct.w;
    ctx.beginPath();
    if (ct.dash) ctx.setLineDash([5, 3]);
    else ctx.setLineDash([]);
    ctx.moveTo(lx, ly - 5);
    ctx.lineTo(lx + 22, ly - 5);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#333';
    ctx.fillText(ct.name, lx + 28, ly);
  });

  var jpegUrl = canvas.toDataURL('image/jpeg', 0.95);
  vscodeApi.postMessage({ type: 'graphImage', dataUrl: jpegUrl, width: totalW * dpr, height: totalH * dpr });
}
function showConnTypeSelector(x, y, from, fromPort, to, toPort) {
  const sel = document.getElementById('conn-type-selector');
  sel.style.left = x + 'px';
  sel.style.top = y + 'px';
  sel.style.display = 'block';
  sel.innerHTML = [
    ['\\u2192 Audio',    'audio'],
    ['\\u00bb CV',       'cv'],
    ['p\\u203a Pitch',   'pitch'],
    ['g\\u203a Gate',    'gate'],
    ['t\\u203a Trigger', 'trigger'],
    ['c\\u203a Clock',   'clock'],
  ].map(([label, val]) =>
    '<button data-val="'+val+'" data-from="'+esc(from)+'" data-fp="'+esc(fromPort)+'" data-to="'+esc(to)+'" data-tp="'+esc(toPort)+'">'+label+'</button>'
  ).join('');
  sel.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', function(ev2) {
      ev2.stopPropagation();
      sel.style.display = 'none';
      vscodeApi.postMessage({
        type: 'addConnection',
        from: this.dataset.from, fromPort: this.dataset.fp,
        to: this.dataset.to, toPort: this.dataset.tp,
        connType: this.dataset.val
      });
    });
  });
}

// ================================================================
//  MODULE INSPECTOR
// ================================================================
function selectModule(id) {
  selectedModuleId = id;
  if (!selectedModules.has(id)) {
    selectedModules.clear();
    selectedModules.add(id);
  }
  vscodeApi.postMessage({ type: 'selectionChanged', hasSelection: true });
  renderAll();
  vscodeApi.postMessage({ type: 'inspectModule', moduleName: id });
}

function closeInspector() {
  selectedModuleId = null;
  selectedModules.clear();
  vscodeApi.postMessage({ type: 'selectionChanged', hasSelection: false });
  document.getElementById('inspector').classList.remove('visible');
  renderAll();
}

function showInspector(moduleId, catalogInfo) {
  const { nodes, edges } = layoutResult;
  const node = nodes.find(n => n.id === moduleId);
  if (!node) return;

  document.getElementById('inspector-title').textContent = node.name.toUpperCase();
  const body = document.getElementById('inspector-body');
  let html = '';

  if (catalogInfo) {
    html += '<div class="insp-section"><h4>Module Info</h4>';
    html += '<div class="insp-row"><span class="insp-label">Manufacturer</span><span class="insp-value">' + esc(catalogInfo.manufacturer) + '</span></div>';
    html += '<div class="insp-row"><span class="insp-label">Type</span><span class="insp-value">' + esc(catalogInfo.type) + '</span></div>';
    html += '<div class="insp-catalog-info">' + esc(catalogInfo.description) + '</div></div>';
  }

  // Connections
  const outs = edges.filter(e => e.from === moduleId);
  const ins  = edges.filter(e => e.to   === moduleId);
  if (outs.length + ins.length > 0) {
    html += '<div class="insp-section"><h4>Connections</h4>';
    outs.forEach(e => {
      html += '<div class="conn-row"><span class="insp-badge">'+ esc(e.fromPort)+'</span>';
      html += '<span class="conn-arrow">' + connArrowSym(e.type) + '</span>';
      html += '<span>'+ esc(e.to)+'</span> <span class="insp-badge">'+ esc(e.toPort)+'</span>';
      html += '<button class="conn-remove" data-from="'+esc(e.from)+'" data-fp="'+esc(e.fromPort)+'" data-to="'+esc(e.to)+'" data-tp="'+esc(e.toPort)+'">';
      html += '\\u00d7</button></div>';
    });
    ins.forEach(e => {
      html += '<div class="conn-row"><span>'+ esc(e.from)+'</span> <span class="insp-badge">'+ esc(e.fromPort)+'</span>';
      html += '<span class="conn-arrow">' + connArrowSym(e.type) + '</span>';
      html += '<span class="insp-badge">'+ esc(e.toPort)+'</span>';
      html += '<button class="conn-remove" data-from="'+esc(e.from)+'" data-fp="'+esc(e.fromPort)+'" data-to="'+esc(e.to)+'" data-tp="'+esc(e.toPort)+'">';
      html += '\\u00d7</button></div>';
    });
    html += '</div>';
  }

  // Parameters — show set params + unset catalog params
  html += '<div class="insp-section"><h4>Parameters</h4>';
  const setParams = new Set(Object.keys(node.params).map(k => k.toLowerCase()));
  Object.keys(node.params).forEach(pk => {
    html += '<div class="param-row"><span class="insp-label">'+ esc(pk)+'</span>';
    html += '<input class="param-input" value="'+escAttr(node.params[pk])+'" data-module="'+escAttr(moduleId)+'" data-param="'+escAttr(pk)+'" />';
    html += '<button class="param-btn danger" data-action="rmParam" data-module="'+escAttr(moduleId)+'" data-param="'+escAttr(pk)+'">\\u00d7</button></div>';
  });
  // Catalog params not yet set — show as placeholder rows
  if (node.catalogParams && node.catalogParams.length > 0) {
    const unset = node.catalogParams.filter(cp => !setParams.has(cp.toLowerCase()));
    if (unset.length > 0) {
      unset.forEach(cp => {
        html += '<div class="param-row"><span class="insp-label" style="color:#666">'+ esc(cp)+'</span>';
        html += '<input class="param-input" placeholder="not set" data-module="'+escAttr(moduleId)+'" data-cparam="'+escAttr(cp)+'" />';
        html += '</div>';
      });
    }
  }
  html += '<div class="add-param-row"><input class="param-input" id="new-param-name" placeholder="name" />';
  html += '<input class="param-input" id="new-param-value" placeholder="value" />';
  html += '<button class="param-btn" id="add-param-btn">+</button></div></div>';

  // --- Add Connection form ---
  if (nodes.length > 0) {
    html += '<div class="insp-section"><h4>New Connection</h4><div class="add-conn-form">';
    // Direction
    html += '<div class="add-conn-row"><label>Dir</label>';
    html += '<select class="add-conn-select" id="ac-dir"><option value="out">Out \u2192</option><option value="in">\u2192 In</option></select></div>';
    // This module port — use allOutputs (catalog + parsed)
    html += '<div class="add-conn-row"><label>Port</label>';
    html += '<select class="add-conn-select" id="ac-self-port">';
    node.allOutputs.forEach(p => { html += '<option value="'+escAttr(p)+'">'+esc(p)+'</option>'; });
    html += '</select></div>';
    // Target module (includes self)
    html += '<div class="add-conn-row"><label>To</label>';
    html += '<select class="add-conn-select" id="ac-target">';
    nodes.forEach(n2 => { html += '<option value="'+escAttr(n2.id)+'"'+(n2.id === moduleId ? ' selected' : '')+'>'+esc(n2.name)+(n2.id === moduleId ? ' (self)' : '')+'</option>'; });
    html += '</select></div>';
    // Target port
    html += '<div class="add-conn-row"><label>Port</label>';
    html += '<select class="add-conn-select" id="ac-target-port"></select></div>';
    // Type
    html += '<div class="add-conn-row"><label>Type</label>';
    html += '<select class="add-conn-select" id="ac-type">';
    html += '<option value="audio">\u2192 Audio</option><option value="cv">\u00bb CV</option>';
    html += '<option value="pitch">p\u203a Pitch</option><option value="gate">g\u203a Gate</option>';
    html += '<option value="trigger">t\u203a Trigger</option><option value="clock">c\u203a Clock</option>';
    html += '</select></div>';
    html += '<button class="add-conn-submit" id="ac-submit">Add Connection</button>';
    html += '</div></div>';
  }

  // Ports (show all known ports: catalog + parsed)
  html += '<div class="insp-section"><h4>Inputs</h4>';
  node.allInputs.forEach(p => { html += '<span class="insp-badge">'+ esc(p)+'</span>'; });
  if (!node.allInputs.length) html += '<span class="insp-catalog-info">None</span>';
  html += '</div><div class="insp-section"><h4>Outputs</h4>';
  node.allOutputs.forEach(p => { html += '<span class="insp-badge">'+ esc(p)+'</span>'; });
  if (!node.allOutputs.length) html += '<span class="insp-catalog-info">None</span>';
  html += '</div>';

  body.innerHTML = html;
  document.getElementById('inspector').classList.add('visible');

  // Wire up event listeners (no inline onclick)
  body.querySelectorAll('.param-input[data-param]').forEach(inp => {
    inp.addEventListener('change', function() {
      vscodeApi.postMessage({ type: 'editParam', module: this.dataset.module, param: this.dataset.param, value: this.value });
    });
  });
  // Catalog param placeholders — add on change
  body.querySelectorAll('.param-input[data-cparam]').forEach(inp => {
    inp.addEventListener('change', function() {
      if (!this.value.trim()) return;
      vscodeApi.postMessage({ type: 'addParam', module: this.dataset.module, param: this.dataset.cparam, value: this.value.trim() });
    });
  });
  body.querySelectorAll('[data-action="rmParam"]').forEach(btn => {
    btn.addEventListener('click', function() {
      vscodeApi.postMessage({ type: 'removeParam', module: this.dataset.module, param: this.dataset.param });
    });
  });
  body.querySelectorAll('.conn-remove').forEach(btn => {
    btn.addEventListener('click', function() {
      vscodeApi.postMessage({ type: 'removeConnection', from: this.dataset.from, fromPort: this.dataset.fp, to: this.dataset.to, toPort: this.dataset.tp });
    });
  });
  const addBtn = document.getElementById('add-param-btn');
  if (addBtn) {
    addBtn.addEventListener('click', () => {
      const n_ = document.getElementById('new-param-name');
      const v_ = document.getElementById('new-param-value');
      if (!n_.value.trim()) return;
      vscodeApi.postMessage({ type: 'addParam', module: moduleId, param: n_.value.trim(), value: v_.value.trim() || '0' });
      n_.value = ''; v_.value = '';
    });
  }

  // --- Wire up Add Connection form ---
  const acDir = document.getElementById('ac-dir');
  const acSelfPort = document.getElementById('ac-self-port');
  const acTarget = document.getElementById('ac-target');
  const acTargetPort = document.getElementById('ac-target-port');
  const acSubmit = document.getElementById('ac-submit');
  if (acDir && acSelfPort && acTarget && acTargetPort && acSubmit) {
    function refreshSelfPorts() {
      const isOut = acDir.value === 'out';
      const ports = isOut ? node.allOutputs : node.allInputs;
      acSelfPort.innerHTML = ports.map(p => '<option value="'+escAttr(p)+'">'+esc(p)+'</option>').join('');
    }
    function refreshTargetPorts() {
      const isOut = acDir.value === 'out';
      const tgtNode = nodes.find(n2 => n2.id === acTarget.value);
      const tPorts = tgtNode ? (isOut ? tgtNode.allInputs : tgtNode.allOutputs) : [];
      acTargetPort.innerHTML = tPorts.map(p => '<option value="'+escAttr(p)+'">'+esc(p)+'</option>').join('');
    }
    acDir.addEventListener('change', () => { refreshSelfPorts(); refreshTargetPorts(); });
    acTarget.addEventListener('change', refreshTargetPorts);
    refreshTargetPorts(); // initial population

    acSubmit.addEventListener('click', () => {
      const sp = acSelfPort.value;
      const tp = acTargetPort.value;
      const tgt = acTarget.value;
      if (!sp || !tp || !tgt) return;
      const isOut = acDir.value === 'out';
      vscodeApi.postMessage({
        type: 'addConnection',
        from: isOut ? moduleId : tgt,
        fromPort: isOut ? sp : tp,
        to: isOut ? tgt : moduleId,
        toPort: isOut ? tp : sp,
        connType: document.getElementById('ac-type').value
      });
    });
  }
}

function connArrowSym(t) {
  return { audio:'\\u2192', cv:'\\u00bb', pitch:'p\\u203a', gate:'g\\u203a', trigger:'t\\u203a', clock:'c\\u203a' }[t] || '\\u2192';
}
function esc(s)     { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function escAttr(s) { return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;'); }

// Close selector / inspector on background click
svgEl.addEventListener('click', ev => {
  if (rubberBandJustFinished) { rubberBandJustFinished = false; return; }
  if (ev.target === svgEl || ev.target === rootEl) {
    if (!rubberBand) closeInspector();
  }
  document.getElementById('conn-type-selector').style.display = 'none';
});

// ================================================================
//  MESSAGE HANDLING  (bidirectional sync)
// ================================================================
window.addEventListener('message', event => {
  const msg = event.data;
  if (msg.type === 'moduleInfo' && msg.moduleName === selectedModuleId) {
    showInspector(msg.moduleName, msg.catalog);
  } else if (msg.type === 'command') {
    switch (msg.command) {
      case 'zoomIn':  zoomIn(); break;
      case 'zoomOut': zoomOut(); break;
      case 'fit':     fitAll(); break;
      case 'reset':   resetView(); break;
      case 'addModule':    requestAddModule(); break;
      case 'removeModule': requestRemoveModule(); break;
      case 'exportImage': exportGraphImage(); break;
    }
  } else if (msg.type === 'update') {
    // Preserve manual positions if possible
    const oldPositions = {};
    layoutResult.nodes.forEach(n => { oldPositions[n.id] = { x: n._x, y: n._y }; });
    DATA = msg.data;
    buildLegend();
    layoutResult = elkLayout(DATA);
    // Restore positions for nodes that still exist and were manually moved
    layoutResult.nodes.forEach(n => {
      if (oldPositions[n.id]) {
        n._x = oldPositions[n.id].x;
        n._y = oldPositions[n.id].y;
      }
    });
    computePortPositions(layoutResult.nodes);
    renderAll();
    if (selectedModuleId) {
      if (layoutResult.nodes.find(n => n.id === selectedModuleId)) {
        vscodeApi.postMessage({ type: 'inspectModule', moduleName: selectedModuleId });
      } else { closeInspector(); }
    }
  }
});

// Initial render + auto-fit
renderAll();
setTimeout(function() { fitAll(); vscodeApi.postMessage({ type: 'ready' }); }, 100);
</script>
</body>
</html>`;
  }

  /** Convert PatchbookData to a flat graph structure for the webview */
  private toGraphData(data: PatchbookData): {
    nodes: {
      id: string;
      name: string;
      moduleType: string;
      manufacturer: string;
      inputs: string[];
      outputs: string[];
      allInputs: string[];
      allOutputs: string[];
      params: Record<string, string>;
      catalogParams: string[];
    }[];
    edges: {
      from: string;
      to: string;
      fromPort: string;
      toPort: string;
      type: string;
    }[];
  } {
    const nodes = Object.keys(data.modules).map((key) => {
      const mod = data.modules[key];
      const parsedInputs = Object.keys(mod.connections.in).sort();
      const parsedOutputs = Object.keys(mod.connections.out).sort();
      // Merge with catalog ports
      const catalog = this.catalogLookup(key);
      const catIn = catalog ? catalog.inputs.map(p => p.toLowerCase()) : [];
      const catOut = catalog ? catalog.outputs.map(p => p.toLowerCase()) : [];
      const catParams = catalog ? catalog.parameters.map(p => p.toLowerCase()) : [];
      const allInputs = [...new Set([...parsedInputs, ...catIn])].sort();
      const allOutputs = [...new Set([...parsedOutputs, ...catOut])].sort();
      return {
        id: key,
        name: key,
        moduleType: catalog ? catalog.type : 'Unknown',
        manufacturer: catalog ? catalog.manufacturer : '',
        inputs: parsedInputs,
        outputs: parsedOutputs,
        allInputs,
        allOutputs,
        params: { ...mod.parameters },
        catalogParams: catParams,
      };
    });

    const edges: {
      from: string;
      to: string;
      fromPort: string;
      toPort: string;
      type: string;
    }[] = [];
    const seen = new Set<number>();
    for (const key of Object.keys(data.modules)) {
      const mod = data.modules[key];
      for (const port of Object.keys(mod.connections.out)) {
        for (const conn of mod.connections.out[port]) {
          if (!seen.has(conn.id)) {
            seen.add(conn.id);
            edges.push({
              from: key,
              to: conn.input_module,
              fromPort: port,
              toPort: conn.input_port,
              type: conn.connection_type,
            });
          }
        }
      }
    }

    return { nodes, edges };
  }
}
