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
      const lastLine = doc.lineAt(doc.lineCount - 1);
      edit.insert(this.sourceUri!, lastLine.range.end, "\n" + line);
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

  .module-box { fill: #2d2d2d; stroke: #555; stroke-width: 1.5; rx: 6; ry: 6; cursor: grab; }
  .module-box:hover { stroke: #0af; stroke-width: 2; }
  .module-box.selected { stroke: #0af; stroke-width: 2.5; fill: #333; }
  .module-box.dragging { cursor: grabbing; stroke: #0f0; stroke-width: 2; }
  .module-name { fill: #fff; font-size: 13px; font-weight: 600; text-anchor: middle; pointer-events: none; }
  .port-label { fill: #aaa; font-size: 10px; pointer-events: none; }
  .port-dot { r: 5; stroke-width: 1.5; cursor: crosshair; transition: r 0.15s, fill 0.15s; }
  .port-dot:hover { r: 8; }
  .port-dot.in  { fill: #3a3a3a; stroke: #888; }
  .port-dot.out { fill: #4a4a4a; stroke: #aaa; }
  .port-dot.drag-target { fill: #0af; stroke: #fff; r: 8; }
  .param-text { fill: #888; font-size: 9px; text-anchor: middle; cursor: pointer; pointer-events: all; }
  .param-text:hover { fill: #ccc; }

  .edge { fill: none; stroke-width: 2; cursor: pointer; pointer-events: stroke; }
  .edge:hover { stroke-width: 4; filter: brightness(1.4); }
  .edge.audio    { stroke: #e8e8e8; stroke-width: 2.5; }
  .edge.cv       { stroke: #888; }
  .edge.gate     { stroke: #ff4444; stroke-dasharray: 6 3; }
  .edge.trigger  { stroke: #ff8800; stroke-dasharray: 6 3; }
  .edge.pitch    { stroke: #4488ff; }
  .edge.clock    { stroke: #aa44ff; stroke-dasharray: 6 3; }
  .edge.pending  { stroke: #0af; stroke-width: 2; stroke-dasharray: 4 4; opacity: 0.7; pointer-events: none; }

  .legend { fill: #252526; stroke: #444; rx: 4; }
  .legend-text { fill: #aaa; font-size: 10px; }
  .legend-line { stroke-width: 2; }

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
<div id="inspector">
  <div id="inspector-header">
    <h3 id="inspector-title">Module</h3>
    <button id="inspector-close" onclick="closeInspector()">\u00d7</button>
  </div>
  <div id="inspector-body"></div>
</div>
<div id="conn-type-selector"></div>
<svg id="canvas"><g id="root"></g></svg>
<script>
const vscodeApi = acquireVsCodeApi();
let DATA = ${JSON.stringify(graphData)};
const DIR = "${config}";

// ================================================================
//  CONSTANTS
// ================================================================
const PORT_H       = 20;
const PORT_PAD     = 14;
const MOD_MIN_W    = 150;
const MOD_NAME_H   = 28;
const PARAM_LINE_H = 14;
const LAYER_GAP    = 280;   // gap between layers
const NODE_GAP     = 36;    // gap between sibling nodes

// ================================================================
//  SUGIYAMA LAYERED LAYOUT  (Eclipse GEF / Zest style)
//  Phase 1: Layer assignment (longest-path)
//  Phase 2: Crossing minimisation (barycenter heuristic, multi-pass)
//  Phase 3: Coordinate assignment (median positioning with compaction)
// ================================================================

function sugiyamaLayout(data) {
  const nodes = data.nodes;
  const edges = data.edges;
  const nodeMap = {};
  nodes.forEach(n => { nodeMap[n.id] = n; });

  // --- Compute node sizes ---
  nodes.forEach(n => {
    const maxPorts  = Math.max(n.inputs.length, n.outputs.length, 1);
    // All params: set + unset catalog
    const setKeys = Object.keys(n.params);
    const setLower = new Set(setKeys.map(k => k.toLowerCase()));
    const unsetCat = (n.catalogParams || []).filter(cp => !setLower.has(cp.toLowerCase()));
    const totalParams = setKeys.length + unsetCat.length;
    const bodyH     = maxPorts * PORT_H + PORT_PAD * 2;
    const paramH    = totalParams * PARAM_LINE_H;
    n._h = MOD_NAME_H + bodyH + (paramH > 0 ? paramH + 8 : 0);
    n._allParamKeys = setKeys;
    n._unsetCatParams = unsetCat;
    const maxLen = Math.max(
      ...n.inputs.map(p => p.length),
      ...n.outputs.map(p => p.length), 4
    );
    n._w = Math.max(MOD_MIN_W, maxLen * 7 + 80, n.name.length * 9 + 40);
  });

  // --- Build adjacency ---
  const succ = {}, pred = {};
  nodes.forEach(n => { succ[n.id] = []; pred[n.id] = []; });
  edges.forEach(e => {
    if (succ[e.from]) succ[e.from].push(e.to);
    if (pred[e.to])   pred[e.to].push(e.from);
  });

  // --- Phase 1: Layer assignment (longest-path from sources) ---
  const layerOf = {};
  const inDeg = {};
  nodes.forEach(n => { inDeg[n.id] = (pred[n.id] || []).length; });
  const queue = nodes.filter(n => inDeg[n.id] === 0).map(n => n.id);
  if (queue.length === 0 && nodes.length > 0) queue.push(nodes[0].id); // handle cycles
  queue.forEach(id => { layerOf[id] = 0; });
  const vis = new Set(queue);
  let qi = 0;
  while (qi < queue.length) {
    const cur = queue[qi++];
    for (const nxt of (succ[cur] || [])) {
      layerOf[nxt] = Math.max(layerOf[nxt] || 0, layerOf[cur] + 1);
      if (!vis.has(nxt)) { vis.add(nxt); queue.push(nxt); }
    }
  }
  nodes.forEach(n => { if (layerOf[n.id] === undefined) layerOf[n.id] = 0; });

  // Group by layer
  const layers = {};
  nodes.forEach(n => {
    const l = layerOf[n.id];
    if (!layers[l]) layers[l] = [];
    layers[l].push(n);
  });
  const layerKeys = Object.keys(layers).map(Number).sort((a_,b_) => a_ - b_);

  // --- Phase 2: Crossing minimisation (barycenter, 4 sweeps) ---
  function barycenter(layerArr, neighbourFn) {
    const bc = layerArr.map(n => {
      const nbrs = neighbourFn(n.id);
      if (nbrs.length === 0) return { n, val: Infinity };
      // Get positions of neighbours in their layer
      let sum = 0;
      for (const nbrId of nbrs) {
        const nbrNode = nodeMap[nbrId];
        if (nbrNode && nbrNode._order !== undefined) sum += nbrNode._order;
      }
      return { n, val: sum / nbrs.length };
    });
    bc.sort((a, b) => a.val - b.val);
    bc.forEach((item, idx) => { item.n._order = idx; });
    return bc.map(item => item.n);
  }

  // Initial ordering: as-is
  layerKeys.forEach(lk => {
    layers[lk].forEach((n, i) => { n._order = i; });
  });

  // Sweep down then up, 4 full iterations
  for (let iter = 0; iter < 4; iter++) {
    // Down sweep
    for (let li = 1; li < layerKeys.length; li++) {
      const lk = layerKeys[li];
      layers[lk] = barycenter(layers[lk], id => pred[id] || []);
    }
    // Up sweep
    for (let li = layerKeys.length - 2; li >= 0; li--) {
      const lk = layerKeys[li];
      layers[lk] = barycenter(layers[lk], id => succ[id] || []);
    }
  }

  // --- Phase 3: Coordinate assignment ---
  const isLR = DIR === 'LR';
  let maxW = 0, maxH = 0;

  layerKeys.forEach((lk, li) => {
    const group = layers[lk];
    // Median-based initial positions: center each layer
    let offset = 40;
    group.forEach(n => {
      if (isLR) {
        n._x = 40 + li * LAYER_GAP;
        n._y = offset;
      } else {
        n._x = offset;
        n._y = 40 + li * LAYER_GAP;
      }
      offset += (isLR ? n._h : n._w) + NODE_GAP;
      maxW = Math.max(maxW, n._x + n._w + 40);
      maxH = Math.max(maxH, n._y + n._h + 40);
    });
  });

  // Median improvement: shift nodes toward their connected neighbours (3 passes)
  for (let pass = 0; pass < 3; pass++) {
    layerKeys.forEach(lk => {
      const group = layers[lk];
      group.forEach(n => {
        const allNbrs = [...(pred[n.id] || []), ...(succ[n.id] || [])];
        if (allNbrs.length === 0) return;
        const coords = allNbrs.map(id => {
          const nb = nodeMap[id];
          return nb ? (isLR ? nb._y + nb._h / 2 : nb._x + nb._w / 2) : 0;
        }).sort((a, b) => a - b);
        const median = coords[Math.floor(coords.length / 2)];
        const current = isLR ? n._y + n._h / 2 : n._x + n._w / 2;
        const shift = (median - current) * 0.3;
        if (isLR) n._y += shift; else n._x += shift;
      });
      // Resolve overlaps
      group.sort((a, b) => (isLR ? a._y - b._y : a._x - b._x));
      for (let i = 1; i < group.length; i++) {
        const prev = group[i - 1];
        const cur = group[i];
        const prevEnd = isLR ? prev._y + prev._h + NODE_GAP : prev._x + prev._w + NODE_GAP;
        const curStart = isLR ? cur._y : cur._x;
        if (curStart < prevEnd) {
          if (isLR) cur._y = prevEnd; else cur._x = prevEnd;
        }
      }
    });
  }

  // Recompute bounds
  maxW = 0; maxH = 0;
  nodes.forEach(n => {
    maxW = Math.max(maxW, n._x + n._w + 40);
    maxH = Math.max(maxH, n._y + n._h + 40);
  });

  // Port positions
  computePortPositions(nodes);

  return { nodes, edges, nodeMap, maxW, maxH };
}

function computePortPositions(nodes) {
  nodes.forEach(n => {
    n._inPorts = {};
    n._outPorts = {};
    const bodyStart = n._y + MOD_NAME_H;
    n.inputs.forEach((p, i) => {
      n._inPorts[p] = { x: n._x, y: bodyStart + PORT_PAD + i * PORT_H + PORT_H / 2 };
    });
    n.outputs.forEach((p, i) => {
      n._outPorts[p] = { x: n._x + n._w, y: bodyStart + PORT_PAD + i * PORT_H + PORT_H / 2 };
    });
  });
}

// ================================================================
//  STATE
// ================================================================
let layoutResult = sugiyamaLayout(DATA);
const svgEl = document.getElementById('canvas');
const rootEl = document.getElementById('root');
let scale = 1, tx = 0, ty = 0;
let selectedModuleId = null;

// Interaction modes
let dragModule = null;      // { node, startMX, startMY, origX, origY }
let dragConn   = null;      // { nodeId, port, isOutput, x, y }
let panning    = null;      // { lastX, lastY }
let pendingLine = null;

// ================================================================
//  RENDER
// ================================================================
function renderAll() {
  const { nodes, edges, nodeMap, maxW, maxH } = layoutResult;
  rootEl.innerHTML = '';

  // --- Edges ---
  edges.forEach((e, ei) => {
    const fn = nodeMap[e.from], tn = nodeMap[e.to];
    if (!fn || !tn) return;
    const src = fn._outPorts && fn._outPorts[e.fromPort];
    const dst = tn._inPorts  && tn._inPorts[e.toPort];
    if (!src || !dst) return;

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', bezier(src.x, src.y, dst.x, dst.y));
    path.setAttribute('class', 'edge ' + e.type);
    path.addEventListener('click', ev => {
      ev.stopPropagation();
      selectModule(e.from);
    });
    rootEl.appendChild(path);
  });

  // --- Nodes ---
  nodes.forEach(n => {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('data-module', n.id);

    // Box
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', n._x);
    rect.setAttribute('y', n._y);
    rect.setAttribute('width', n._w);
    rect.setAttribute('height', n._h);
    rect.setAttribute('class', 'module-box' + (selectedModuleId === n.id ? ' selected' : ''));
    rect.addEventListener('pointerdown', ev => onModulePointerDown(ev, n));
    g.appendChild(rect);

    // Name
    const nameEl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    nameEl.setAttribute('x', n._x + n._w / 2);
    nameEl.setAttribute('y', n._y + 18);
    nameEl.setAttribute('class', 'module-name');
    nameEl.textContent = n.name.toUpperCase();
    g.appendChild(nameEl);

    // Header separator
    const sep = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    sep.setAttribute('x1', n._x); sep.setAttribute('y1', n._y + MOD_NAME_H);
    sep.setAttribute('x2', n._x + n._w); sep.setAttribute('y2', n._y + MOD_NAME_H);
    sep.setAttribute('stroke', '#555'); sep.setAttribute('stroke-width', '1');
    g.appendChild(sep);

    // Input ports
    n.inputs.forEach(p => {
      const pos = n._inPorts[p];
      const dot = makePortDot(pos.x, pos.y, 'in', n.id, p);
      g.appendChild(dot);
      const lbl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      lbl.setAttribute('x', pos.x + 10); lbl.setAttribute('y', pos.y + 3);
      lbl.setAttribute('class', 'port-label'); lbl.setAttribute('text-anchor', 'start');
      lbl.textContent = p;
      g.appendChild(lbl);
    });

    // Output ports
    n.outputs.forEach(p => {
      const pos = n._outPorts[p];
      const dot = makePortDot(pos.x, pos.y, 'out', n.id, p);
      g.appendChild(dot);
      const lbl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      lbl.setAttribute('x', pos.x - 10); lbl.setAttribute('y', pos.y + 3);
      lbl.setAttribute('class', 'port-label'); lbl.setAttribute('text-anchor', 'end');
      lbl.textContent = p;
      g.appendChild(lbl);
    });

    // Parameters (set + unset catalog)
    const allP = [
      ...n._allParamKeys.map(pk => ({ key: pk, val: n.params[pk], isSet: true })),
      ...n._unsetCatParams.map(cp => ({ key: cp, val: null, isSet: false }))
    ];
    if (allP.length > 0) {
      const maxP = Math.max(n.inputs.length, n.outputs.length, 1);
      const pStartY = n._y + MOD_NAME_H + maxP * PORT_H + PORT_PAD * 2 + 4;
      const s2 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      s2.setAttribute('x1', n._x); s2.setAttribute('y1', pStartY - 4);
      s2.setAttribute('x2', n._x + n._w); s2.setAttribute('y2', pStartY - 4);
      s2.setAttribute('stroke', '#444'); s2.setAttribute('stroke-width', '1');
      g.appendChild(s2);
      allP.forEach((p, pi) => {
        const pt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        pt.setAttribute('x', n._x + n._w / 2);
        pt.setAttribute('y', pStartY + pi * PARAM_LINE_H + 10);
        pt.setAttribute('class', 'param-text');
        if (p.isSet) {
          pt.textContent = p.key + ' = ' + p.val;
        } else {
          pt.textContent = p.key + ' = —';
          pt.setAttribute('fill', '#555');
        }
        pt.addEventListener('click', ev => { ev.stopPropagation(); selectModule(n.id); });
        g.appendChild(pt);
      });
    }

    rootEl.appendChild(g);
  });

  // --- Legend ---
  const ltypes = [
    { name: 'Audio', cls: 'audio' }, { name: 'CV', cls: 'cv' },
    { name: 'Pitch', cls: 'pitch' }, { name: 'Gate', cls: 'gate' },
    { name: 'Trigger', cls: 'trigger' }, { name: 'Clock', cls: 'clock' },
  ];
  const lx = 20, ly = maxH + 20;
  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bg.setAttribute('x', lx); bg.setAttribute('y', ly);
  bg.setAttribute('width', 360); bg.setAttribute('height', 30);
  bg.setAttribute('class', 'legend');
  rootEl.appendChild(bg);
  ltypes.forEach((lt, i) => {
    const ex = lx + 10 + i * 58;
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', ex); line.setAttribute('y1', ly + 15);
    line.setAttribute('x2', ex + 16); line.setAttribute('y2', ly + 15);
    line.setAttribute('class', 'edge legend-line ' + lt.cls);
    rootEl.appendChild(line);
    const txt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    txt.setAttribute('x', ex + 20); txt.setAttribute('y', ly + 19);
    txt.setAttribute('class', 'legend-text');
    txt.textContent = lt.name;
    rootEl.appendChild(txt);
  });

  applyTransform();
}

function bezier(sx, sy, dx, dy) {
  const cx = Math.abs(dx - sx) * 0.55;
  return 'M'+sx+','+sy+' C'+(sx+cx)+','+sy+' '+(dx-cx)+','+dy+' '+dx+','+dy;
}

function makePortDot(cx, cy, dir, modId, port) {
  const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  dot.setAttribute('cx', cx); dot.setAttribute('cy', cy);
  dot.setAttribute('class', 'port-dot ' + dir);
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
function resetView() { scale = 1; tx = 0; ty = 0; applyTransform(); }

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

// Wheel zoom toward cursor — continuous factor based on deltaY magnitude
svgEl.addEventListener('wheel', ev => {
  ev.preventDefault();
  // Normalise: trackpad gives small deltas (~1-10), mouse wheel gives large (~100)
  const raw = ev.deltaMode === 1 ? ev.deltaY * 40 : ev.deltaY; // line mode
  const clamped = Math.max(-300, Math.min(300, raw));
  const f = Math.pow(2, -clamped / 300);
  zoomAt(ev.clientX, ev.clientY, f);
}, { passive: false });

// ================================================================
//  MODULE DRAGGING
// ================================================================
function onModulePointerDown(ev, node) {
  if (ev.button !== 0) return;
  ev.stopPropagation();
  const pt = clientToWorld(ev.clientX, ev.clientY);
  dragModule = { node, startMX: pt.x, startMY: pt.y, origX: node._x, origY: node._y, moved: false };
}

let rafPending = false;
svgEl.addEventListener('pointermove', ev => {
  // --- Module drag ---
  if (dragModule) {
    const pt = clientToWorld(ev.clientX, ev.clientY);
    const dx = pt.x - dragModule.startMX;
    const dy = pt.y - dragModule.startMY;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) dragModule.moved = true;
    dragModule.node._x = dragModule.origX + dx;
    dragModule.node._y = dragModule.origY + dy;
    computePortPositions([dragModule.node]);
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

  // --- Pan ---
  if (panning) {
    tx += ev.clientX - panning.lastX;
    ty += ev.clientY - panning.lastY;
    panning.lastX = ev.clientX;
    panning.lastY = ev.clientY;
    applyTransform();
  }
});

svgEl.addEventListener('pointerup', ev => {
  if (dragModule) {
    if (!dragModule.moved) { selectModule(dragModule.node.id); }
    dragModule = null; return;
  }
  if (dragConn) {
    // Hit-test: find the nearest compatible port within threshold
    tryFinishConnection(ev.clientX, ev.clientY);
    cleanupConnDrag();
    return;
  }
  if (panning)    { panning = null; }
});

svgEl.addEventListener('pointerdown', ev => {
  if (ev.target === svgEl || ev.target === rootEl) {
    // Background click → start pan
    panning = { lastX: ev.clientX, lastY: ev.clientY };
  }
});

svgEl.addEventListener('pointerleave', () => { panning = null; });

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
    const ports = dragConn.isOutput ? n._inPorts : n._outPorts;
    const dir   = dragConn.isOutput ? 'in' : 'out';
    if (!ports) return;
    for (const pName in ports) {
      // For self-connections, require a different port
      if (n.id === dragConn.nodeId && pName === dragConn.port) continue;
      const pp = ports[pName];
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
  vscodeApi.postMessage({ type: 'selectionChanged', hasSelection: true });
  renderAll();
  vscodeApi.postMessage({ type: 'inspectModule', moduleName: id });
}

function closeInspector() {
  selectedModuleId = null;
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
  if (ev.target === svgEl || ev.target === rootEl) { closeInspector(); }
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
    }
  } else if (msg.type === 'update') {
    // Preserve manual positions if possible
    const oldPositions = {};
    layoutResult.nodes.forEach(n => { oldPositions[n.id] = { x: n._x, y: n._y }; });
    DATA = msg.data;
    layoutResult = sugiyamaLayout(DATA);
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
setTimeout(fitAll, 50);
</script>
</body>
</html>`;
  }

  /** Convert PatchbookData to a flat graph structure for the webview */
  private toGraphData(data: PatchbookData): {
    nodes: {
      id: string;
      name: string;
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
