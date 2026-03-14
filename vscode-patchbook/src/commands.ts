import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { parse, PatchbookData } from "./parser";
import { getModules, getModuleByName, ModuleInfo } from "./moduleDatabase";
import { GraphViewProvider } from "./graphView";

interface ModuleQuickPickItem extends vscode.QuickPickItem {
  mod: ModuleInfo;
}

export async function newPatch(): Promise<void> {
  // Ask for patch name
  const patchName = await vscode.window.showInputBox({
    prompt: "Patch name",
    placeHolder: "My Patch",
  });
  if (patchName === undefined) {
    return;
  }

  // Build grouped quick pick items
  const modules = getModules();
  const byType = new Map<string, ModuleInfo[]>();
  for (const [, mod] of modules) {
    const list = byType.get(mod.type) ?? [];
    list.push(mod);
    byType.set(mod.type, list);
  }

  const sortedTypes = Array.from(byType.keys()).sort();
  const items: (ModuleQuickPickItem | vscode.QuickPickItem)[] = [];
  for (const type of sortedTypes) {
    // Separator
    items.push({ label: type, kind: vscode.QuickPickItemKind.Separator } as vscode.QuickPickItem);
    const mods = byType.get(type)!;
    mods.sort((a, b) => a.name.localeCompare(b.name));
    for (const mod of mods) {
      items.push({
        label: mod.name,
        description: mod.manufacturer,
        detail: mod.description,
        mod,
      });
    }
  }

  const selected = await vscode.window.showQuickPick(items as ModuleQuickPickItem[], {
    canPickMany: true,
    placeHolder: "Select modules for your patch",
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!selected || selected.length === 0) {
    return;
  }

  // Generate template
  const today = new Date().toISOString().slice(0, 10);
  const lines: string[] = [];
  lines.push(`// ${patchName || "Untitled Patch"}`);
  lines.push(`// Date: ${today}`);
  lines.push("");
  lines.push("VOICE 1:");
  lines.push("");

  // Add placeholders for selected modules
  lines.push("// --- Connections ---");
  const selectedMods = selected.map((s) => s.mod);
  if (selectedMods.length >= 2) {
    for (let i = 0; i < selectedMods.length - 1; i++) {
      const src = selectedMods[i];
      const dst = selectedMods[i + 1];
      const outPort = src.outputs[0] ?? "Out";
      const inPort = dst.inputs[0] ?? "In";
      lines.push(`- ${src.name} (${outPort}) -> ${dst.name} (${inPort})`);
    }
  } else {
    lines.push(`// Add connections here`);
  }
  lines.push("");

  // Add parameter blocks for each module
  lines.push("// --- Parameters ---");
  for (const mod of selectedMods) {
    if (mod.parameters.length > 0) {
      lines.push(`* ${mod.name}:`);
      for (const param of mod.parameters) {
        lines.push(`  | ${param} = `);
      }
    }
  }
  lines.push("");

  const content = lines.join("\n");

  // Save to file if workspace is open, otherwise open untitled
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

export async function exportJSON(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== "patchbook") {
    vscode.window.showWarningMessage(
      "Patchbook: Open a .pb or .patchbook file first."
    );
    return;
  }

  const text = editor.document.getText();
  const data = parse(text);
  const json = JSON.stringify(data, null, 2);

  const doc = await vscode.workspace.openTextDocument({
    content: json,
    language: "json",
  });
  await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
}

export async function addModule(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== "patchbook") {
    vscode.window.showWarningMessage("Patchbook: Open a .pb or .patchbook file first.");
    return;
  }

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
  let block = `\n\n* ${modName}:`;
  if (catalog && catalog.parameters.length > 0) {
    for (const p of catalog.parameters) {
      block += `\n| ${p} = `;
    }
  }

  const doc = editor.document;
  const lastLine = doc.lineAt(doc.lineCount - 1);
  const edit = new vscode.WorkspaceEdit();
  edit.insert(doc.uri, lastLine.range.end, block);
  await vscode.workspace.applyEdit(edit);
  await doc.save();
}

export async function removeModule(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== "patchbook") {
    vscode.window.showWarningMessage("Patchbook: Open a .pb or .patchbook file first.");
    return;
  }

  const doc = editor.document;
  const data = parse(doc.getText());
  const moduleNames = Object.keys(data.modules);
  if (moduleNames.length === 0) {
    vscode.window.showInformationMessage("Patchbook: No modules found in this patch.");
    return;
  }

  const picked = await vscode.window.showQuickPick(
    moduleNames.map(m => ({ label: m })),
    { placeHolder: "Select a module to remove" }
  );
  if (!picked) { return; }

  const modLower = picked.label.toLowerCase();
  const lines = doc.getText().split(/\r?\n/);
  const toDelete: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim().toLowerCase();
    // Module header
    if (l.startsWith("*") && l.includes(modLower + ":")) {
      toDelete.push(i);
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim().startsWith("|")) { toDelete.push(j); } else { break; }
      }
    }
    // Connections involving this module
    if (l.startsWith("-") && (l.includes(modLower + " (") || l.includes(modLower + "("))) {
      toDelete.push(i);
    }
  }

  if (toDelete.length === 0) {
    vscode.window.showInformationMessage("Patchbook: No lines found for this module.");
    return;
  }

  const wsEdit = new vscode.WorkspaceEdit();
  const unique = [...new Set(toDelete)].sort((a, b) => b - a);
  for (const lineIdx of unique) {
    wsEdit.delete(doc.uri, doc.lineAt(lineIdx).rangeIncludingLineBreak);
  }
  await vscode.workspace.applyEdit(wsEdit);
  await doc.save();
}

// ================================================================
//  PDF EXPORT
// ================================================================

const PW = 595.28; // A4
const PH = 841.89;
const PM = 40;

function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}
function n2(v: number): string { return v.toFixed(2); }
function hexRgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16) / 255,
    parseInt(hex.slice(3, 5), 16) / 255,
    parseInt(hex.slice(5, 7), 16) / 255,
  ];
}

const TYPE_COLORS: Record<string, string> = {
  "Oscillator": "#2e5c8a", "Voice": "#2e5c8a", "Filter": "#8a4a2e",
  "Low Pass Gate": "#8a5e2e", "VCA": "#6b5b2e", "Mixer": "#5c6b2e",
  "Envelope Generator": "#2e7a5a", "Function Generator": "#2e7a6b",
  "LFO": "#2e6b7a", "Sequencer": "#6b2e7a", "Clock": "#7a2e6b",
  "Effect": "#7a2e4a", "Resonator": "#7a3a3a", "Quantizer": "#4a2e7a",
  "Random Source": "#2e4a6b", "Sampler": "#5a3a6b", "Utility": "#4a4a4a",
  "Controller": "#3a5a3a", "Audio Interface": "#3a4a5a",
  "Eurorack Case with Utilities": "#4a4a4a",
};

// ── PDF builder with binary image support ────────────────────────

interface PdfObject { text: string; binary?: Buffer; }

class PdfDoc {
  private objs: PdfObject[] = [];
  private pageList: { stream: string; hasImage: boolean }[] = [];
  private imgData: Buffer | null = null;
  private imgW = 0;
  private imgH = 0;
  private imgObjId = 0;

  setImage(jpeg: Buffer, w: number, h: number): void {
    this.imgData = jpeg;
    this.imgW = w;
    this.imgH = h;
  }

  addPage(stream: string, hasImage = false): void {
    this.pageList.push({ stream, hasImage });
  }

  build(extensionPath: string): Buffer {
    this.objs = [];
    // 1: Catalog
    this.addObj("<< /Type /Catalog /Pages 2 0 R >>");
    // 2: Pages (placeholder)
    this.addObj("PLACEHOLDER");

    // Embed Source Code Pro TTF fonts
    const regularTtf = this.loadFont(extensionPath, "SourceCodePro-Regular.ttf");
    const boldTtf = this.loadFont(extensionPath, "SourceCodePro-Bold.ttf");

    // 3: F1 - Regular font file stream
    const f1FileId = this.objs.length + 1;
    this.objs.push({
      text: `<< /Length ${regularTtf.length} /Length1 ${regularTtf.length} >>`,
      binary: regularTtf,
    });
    // 4: F1 - Font descriptor
    const f1DescId = this.objs.length + 1;
    this.addObj(
      `<< /Type /FontDescriptor /FontName /SourceCodePro-Regular /Flags 33 ` +
      `/FontBBox [-200 -300 1200 1000] /ItalicAngle 0 /Ascent 984 /Descent -273 ` +
      `/CapHeight 700 /StemV 80 /FontFile2 ${f1FileId} 0 R >>`
    );
    // 5: F1 - Font dict (monospace: all widths = 600)
    const w600 = new Array(95).fill("600").join(" ");
    const f1Id = this.objs.length + 1;
    this.addObj(
      `<< /Type /Font /Subtype /TrueType /BaseFont /SourceCodePro-Regular ` +
      `/FirstChar 32 /LastChar 126 /Widths [${w600}] ` +
      `/FontDescriptor ${f1DescId} 0 R /Encoding /WinAnsiEncoding >>`
    );

    // 6: F2 - Bold font file stream
    const f2FileId = this.objs.length + 1;
    this.objs.push({
      text: `<< /Length ${boldTtf.length} /Length1 ${boldTtf.length} >>`,
      binary: boldTtf,
    });
    // 7: F2 - Font descriptor
    const f2DescId = this.objs.length + 1;
    this.addObj(
      `<< /Type /FontDescriptor /FontName /SourceCodePro-Bold /Flags 33 ` +
      `/FontBBox [-200 -300 1200 1000] /ItalicAngle 0 /Ascent 984 /Descent -273 ` +
      `/CapHeight 700 /StemV 120 /FontFile2 ${f2FileId} 0 R >>`
    );
    // 8: F2 - Font dict
    const f2Id = this.objs.length + 1;
    this.addObj(
      `<< /Type /Font /Subtype /TrueType /BaseFont /SourceCodePro-Bold ` +
      `/FirstChar 32 /LastChar 126 /Widths [${w600}] ` +
      `/FontDescriptor ${f2DescId} 0 R /Encoding /WinAnsiEncoding >>`
    );;

    // 5: Image XObject (if present)
    if (this.imgData) {
      this.imgObjId = this.objs.length + 1;
      this.objs.push({
        text: `<< /Type /XObject /Subtype /Image /Width ${this.imgW} /Height ${this.imgH} ` +
              `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${this.imgData.length} >>`,
        binary: this.imgData,
      });
    }

    // Pages
    const pids: number[] = [];
    for (const pg of this.pageList) {
      const streamBuf = Buffer.from(pg.stream, "binary");
      const cid = this.objs.length + 1;
      this.objs.push({ text: `<< /Length ${streamBuf.length} >>`, binary: streamBuf });

      let res = `/Resources << /Font << /F1 ${f1Id} 0 R /F2 ${f2Id} 0 R >>`;
      if (pg.hasImage && this.imgObjId) {
        res += ` /XObject << /Img1 ${this.imgObjId} 0 R >>`;
      }
      res += " >>";

      const pid = this.objs.length + 1;
      this.addObj(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PW} ${PH}] /Contents ${cid} 0 R ${res} >>`
      );
      pids.push(pid);
    }

    // Update Pages object
    this.objs[1] = { text: `<< /Type /Pages /Kids [${pids.map(i => i + " 0 R").join(" ")}] /Count ${pids.length} >>` };

    // Build binary PDF
    const parts: Buffer[] = [];
    const offsets: number[] = [];
    let pos = 0;
    const pushStr = (s: string) => { const b = Buffer.from(s); parts.push(b); pos += b.length; };
    const pushBuf = (b: Buffer) => { parts.push(b); pos += b.length; };

    pushStr("%PDF-1.4\n");

    for (let i = 0; i < this.objs.length; i++) {
      offsets.push(pos);
      const obj = this.objs[i];
      if (obj.binary) {
        pushStr(`${i + 1} 0 obj\n${obj.text}\nstream\n`);
        pushBuf(obj.binary);
        pushStr("\nendstream\nendobj\n");
      } else {
        pushStr(`${i + 1} 0 obj\n${obj.text}\nendobj\n`);
      }
    }

    const xref = pos;
    pushStr(`xref\n0 ${this.objs.length + 1}\n`);
    pushStr("0000000000 65535 f \n");
    for (const o of offsets) { pushStr(String(o).padStart(10, "0") + " 00000 n \n"); }
    pushStr(`trailer\n<< /Size ${this.objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);

    return Buffer.concat(parts);
  }

  private addObj(text: string): number {
    this.objs.push({ text });
    return this.objs.length;
  }

  private loadFont(extensionPath: string, filename: string): Buffer {
    const fontPath = path.join(extensionPath, "data", "fonts", filename);
    return fs.readFileSync(fontPath);
  }
}

// ── Detail page helper ───────────────────────────────────────────

class Pg {
  ops: string[] = [];
  y = PH - PM;

  txt(s: string, x: number, sz: number, font = "F1"): void {
    this.ops.push(`BT /${font} ${n2(sz)} Tf ${n2(x)} ${n2(this.y)} Td (${esc(s)}) Tj ET`);
  }
  txtC(s: string, x: number, sz: number, r: number, g: number, b: number, font = "F1"): void {
    this.ops.push(`BT ${n2(r)} ${n2(g)} ${n2(b)} rg /${font} ${n2(sz)} Tf ${n2(x)} ${n2(this.y)} Td (${esc(s)}) Tj ET`);
  }
  dn(dy: number): void { this.y -= dy; }
  bar(x: number, w: number, h: number, hex: string): void {
    const [r, g, b] = hexRgb(hex);
    this.ops.push(`q ${n2(r)} ${n2(g)} ${n2(b)} rg ${n2(x)} ${n2(this.y - 7)} ${n2(w)} ${n2(h)} re f Q`);
  }
  hr(lw = 0.5): void {
    this.ops.push(`q 0.80 0.80 0.80 RG ${n2(lw)} w ${n2(PM)} ${n2(this.y)} m ${n2(PW - PM)} ${n2(this.y)} l S Q`);
  }
  room(): number { return this.y - PM - 10; }
  ok(pts: number): boolean { return this.room() >= pts; }
  out(): string { return this.ops.join("\n"); }
}

// ── Estimate how tall a module block will be ─────────────────────

function blockH(
  mod: { parameters: Record<string, string>; connections: { out: Record<string, any[]>; in: Record<string, any> } },
  cat: ModuleInfo | undefined
): number {
  const L = 14;
  let h = 30; // header bar + gap
  if (cat) { h += 14; if (cat.description) { h += 14; } }
  const pk = Object.keys(mod.parameters);
  const pc = pk.length || (cat ? cat.parameters.length : 0);
  if (pc > 0) { h += 16 + pc * L; }
  let cc = 0;
  for (const p of Object.keys(mod.connections.out)) { cc += mod.connections.out[p].length; }
  cc += Object.keys(mod.connections.in).length;
  if (cc > 0) { h += 16 + cc * L; }
  return h + 18;
}

// ── Render one module detail block ───────────────────────────────

function drawBlock(
  pg: Pg,
  name: string,
  mod: { parameters: Record<string, string>; connections: { out: Record<string, any[]>; in: Record<string, any> } },
  cat: ModuleInfo | undefined
): void {
  const L = 14;
  const X = PM + 10;
  const VX = PM + 200;

  // Header: color bar + white text
  const tp = cat?.type || "Unknown";
  const hex = TYPE_COLORS[tp] || "#4a4a4a";
  pg.bar(PM, PW - 2 * PM, 20, hex);
  pg.txtC(name, X, 11, 1, 1, 1, "F2");
  pg.dn(28);

  // Manufacturer / type
  if (cat) {
    pg.txtC(`${cat.manufacturer}  |  ${cat.type}`, X, 8, 0.45, 0.45, 0.45);
    pg.dn(14);
    if (cat.description) {
      pg.txtC(cat.description, X, 7.5, 0.55, 0.55, 0.55);
      pg.dn(14);
    }
  }

  // Parameters
  const pKeys = Object.keys(mod.parameters);
  if (pKeys.length > 0) {
    pg.txtC("Parameters", X, 9, 0.2, 0.2, 0.2, "F2");
    pg.dn(L + 2);
    for (const k of pKeys) {
      pg.txtC(k, X + 8, 8.5, 0.35, 0.35, 0.35);
      pg.txt(mod.parameters[k] || "--", VX, 8.5);
      pg.dn(L);
    }
  } else if (cat && cat.parameters.length > 0) {
    pg.txtC("Parameters (defaults)", X, 9, 0.2, 0.2, 0.2, "F2");
    pg.dn(L + 2);
    for (const cp of cat.parameters) {
      pg.txtC(cp, X + 8, 8.5, 0.55, 0.55, 0.55);
      pg.txtC("--", VX, 8.5, 0.55, 0.55, 0.55);
      pg.dn(L);
    }
  }

  // Connections
  const conns: string[] = [];
  for (const port of Object.keys(mod.connections.out)) {
    for (const c of mod.connections.out[port]) {
      conns.push(`${port} -> ${c.input_module} (${c.input_port})  [${c.connection_type}]`);
    }
  }
  for (const port of Object.keys(mod.connections.in)) {
    const c = mod.connections.in[port];
    if (c) {
      conns.push(`${c.output_module} (${c.output_port}) -> ${port}  [${c.connection_type}]`);
    }
  }
  if (conns.length > 0) {
    pg.dn(2);
    pg.txtC("Connections", X, 9, 0.2, 0.2, 0.2, "F2");
    pg.dn(L + 2);
    for (const c of conns) {
      pg.txtC(c, X + 8, 8.5, 0.35, 0.35, 0.35);
      pg.dn(L);
    }
  }

  // Separator
  pg.dn(8);
  pg.hr(0.3);
  pg.dn(10);
}

// ── Main export ──────────────────────────────────────────────────

export async function exportPDF(graphView: GraphViewProvider, extensionPath: string): Promise<void> {
  let doc: vscode.TextDocument | undefined;
  const sourceUri = graphView.getSourceUri();
  if (sourceUri) {
    doc = await vscode.workspace.openTextDocument(sourceUri);
  } else {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.languageId === "patchbook") { doc = editor.document; }
  }
  if (!doc) {
    vscode.window.showWarningMessage("Patchbook: Open a .pb or .patchbook file first.");
    return;
  }

  const data = parse(doc.getText());
  const moduleNames = Object.keys(data.modules);
  if (moduleNames.length === 0) {
    vscode.window.showInformationMessage("Patchbook: No modules found.");
    return;
  }

  const comments = data.comments || [];
  const patchName = comments.length > 0
    ? comments[0].replace(/^\/\/\s*/, "")
    : path.basename(doc.fileName, path.extname(doc.fileName));

  const pdf = new PdfDoc();

  // ── PAGE 1: Graph image ────────────────────────────────────────
  // Ensure graph panel is open and rendered
  await graphView.ensurePanelReady(doc.uri);

  let img: { jpeg: Buffer; width: number; height: number } | null = null;
  try { img = await graphView.requestGraphImage(); } catch { /* panel not open */ }

  if (img && img.jpeg.length > 0) {
    pdf.setImage(img.jpeg, img.width, img.height);

    // Compute display size to fit A4 with margins, preserving aspect ratio
    const titleH = 50;
    const areaW = PW - 2 * PM;
    const areaH = PH - 2 * PM - titleH;
    const aspect = img.width / img.height;
    let dw: number, dh: number;
    if (areaW / areaH > aspect) { dh = areaH; dw = dh * aspect; } else { dw = areaW; dh = dw / aspect; }
    const dx = PM + (areaW - dw) / 2;
    const dy = PM + (areaH - dh) / 2;

    // Build page 1 content stream
    const ops: string[] = [];
    // Title
    ops.push(`BT /F2 18 Tf ${n2(PM)} ${n2(PH - PM)} Td (${esc(patchName)}) Tj ET`);
    ops.push(`BT /F1 8 Tf 0.5 0.5 0.5 rg ${n2(PM)} ${n2(PH - PM - 16)} Td (${esc("Patchbook - Signal Flow Graph")}) Tj ET`);
    ops.push(`q 0.7 0.7 0.7 RG 0.4 w ${n2(PM)} ${n2(PH - PM - 22)} m ${n2(PW - PM)} ${n2(PH - PM - 22)} l S Q`);
    // Image: scale matrix then draw
    ops.push(`q ${n2(dw)} 0 0 ${n2(dh)} ${n2(dx)} ${n2(dy)} cm /Img1 Do Q`);

    pdf.addPage(ops.join("\n"), true);
  } else {
    // Fallback text page
    const pg = new Pg();
    pg.txt(patchName, PM, 18, "F2");
    pg.dn(22);
    pg.txtC("Patchbook - Signal Flow (open graph panel for visual export)", PM, 8, 0.5, 0.5, 0.5);
    pg.dn(8);
    pg.hr();
    pg.dn(16);
    pg.txt("Modules", PM, 11, "F2");
    pg.dn(16);
    for (const modName of moduleNames) {
      if (!pg.ok(14)) { pdf.addPage(pg.out()); pg.ops = []; pg.y = PH - PM; }
      pg.txt(modName, PM + 4, 9);
      pg.dn(14);
    }
    pdf.addPage(pg.out());
  }

  // ── PAGES 2+: Module details ───────────────────────────────────
  let pg = new Pg();
  pg.txt("MODULE DETAILS", PM, 14, "F2");
  pg.dn(24);

  for (const modName of moduleNames) {
    const mod = data.modules[modName];
    const cat = getModuleByName(modName) || getModuleByName(modName.replace(/\s+#?\d+\s*$/, "").trim());
    const bh = blockH(mod, cat);

    // New page if block won't fit (but not if we're at the top of a fresh page)
    if (!pg.ok(bh) && pg.y < PH - PM - 5) {
      pdf.addPage(pg.out());
      pg = new Pg();
    }
    drawBlock(pg, modName, mod, cat);
  }
  pdf.addPage(pg.out());

  // ── Save ───────────────────────────────────────────────────────
  const fileName = path.basename(doc.fileName, path.extname(doc.fileName));
  const wf = vscode.workspace.workspaceFolders?.[0];
  const defaultUri = wf
    ? vscode.Uri.file(path.join(wf.uri.fsPath, `${fileName}.pdf`))
    : vscode.Uri.file(path.join(path.dirname(doc.fileName), `${fileName}.pdf`));

  const uri = await vscode.window.showSaveDialog({ defaultUri, filters: { "PDF": ["pdf"] } });
  if (!uri) { return; }

  await vscode.workspace.fs.writeFile(uri, pdf.build(extensionPath));
  vscode.window.showInformationMessage(`Patchbook: PDF exported to ${path.basename(uri.fsPath)}`);
}
