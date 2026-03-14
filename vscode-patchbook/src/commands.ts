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

// ── Corner decorations (circuit symbols) ─────────────────────────

function cornerDecorations(pageNum: number): string {
  const ops: string[] = [];
  const c = "0.78 0.78 0.78"; // light gray stroke
  const lw = "0.6";
  const m = 12; // margin inset
  const s = 28; // symbol area size

  // On even pages, swap left/right symbols for binding symmetry
  const even = pageNum % 2 === 0;

  // ── Resistor zigzag (horizontal wire + zigzag) ──
  function resistor(ox: number, oy: number, flipX: boolean) {
    const d = flipX ? -1 : 1;
    ops.push(`q ${c} RG ${lw} w`);
    // lead-in wire
    ops.push(`${n2(ox)} ${n2(oy)} m ${n2(ox + d * 8)} ${n2(oy)} l S`);
    // zigzag (4 teeth)
    let x = ox + d * 8;
    for (let i = 0; i < 4; i++) {
      ops.push(`${n2(x)} ${n2(oy)} m ${n2(x + d * 2)} ${n2(oy + 3)} l ${n2(x + d * 4)} ${n2(oy - 3)} l ${n2(x + d * 6)} ${n2(oy)} l S`);
      x += d * 6;
    }
    // lead-out wire
    ops.push(`${n2(x)} ${n2(oy)} m ${n2(x + d * 6)} ${n2(oy)} l S`);
    ops.push("Q");
  }

  // ── Capacitor (two parallel plates with wires) ──
  function capacitor(ox: number, oy: number, flipX: boolean) {
    const d = flipX ? -1 : 1;
    ops.push(`q ${c} RG ${lw} w`);
    // wire in
    ops.push(`${n2(ox)} ${n2(oy)} m ${n2(ox + d * 12)} ${n2(oy)} l S`);
    // plate 1 (vertical)
    ops.push(`${n2(ox + d * 12)} ${n2(oy - 5)} m ${n2(ox + d * 12)} ${n2(oy + 5)} l S`);
    // plate 2
    ops.push(`${n2(ox + d * 15)} ${n2(oy - 5)} m ${n2(ox + d * 15)} ${n2(oy + 5)} l S`);
    // wire out
    ops.push(`${n2(ox + d * 15)} ${n2(oy)} m ${n2(ox + d * 27)} ${n2(oy)} l S`);
    ops.push("Q");
  }

  // ── Ground (vertical line + 3 horizontal lines shrinking) ──
  function ground(ox: number, oy: number) {
    ops.push(`q ${c} RG ${lw} w`);
    // vertical stem
    ops.push(`${n2(ox)} ${n2(oy)} m ${n2(ox)} ${n2(oy - 7)} l S`);
    // 3 horizontal bars
    ops.push(`${n2(ox - 6)} ${n2(oy - 7)} m ${n2(ox + 6)} ${n2(oy - 7)} l S`);
    ops.push(`${n2(ox - 4)} ${n2(oy - 10)} m ${n2(ox + 4)} ${n2(oy - 10)} l S`);
    ops.push(`${n2(ox - 2)} ${n2(oy - 13)} m ${n2(ox + 2)} ${n2(oy - 13)} l S`);
    ops.push("Q");
  }

  // ── Op-amp triangle (small triangle with +/- labels) ──
  function opamp(ox: number, oy: number, flipX: boolean) {
    const d = flipX ? -1 : 1;
    ops.push(`q ${c} RG ${lw} w`);
    // triangle: tip pointing right (or left if flipped)
    ops.push(`${n2(ox)} ${n2(oy + 8)} m ${n2(ox)} ${n2(oy - 8)} l ${n2(ox + d * 16)} ${n2(oy)} l h S`);
    // input wires
    ops.push(`${n2(ox - d * 6)} ${n2(oy + 4)} m ${n2(ox)} ${n2(oy + 4)} l S`);
    ops.push(`${n2(ox - d * 6)} ${n2(oy - 4)} m ${n2(ox)} ${n2(oy - 4)} l S`);
    // output wire
    ops.push(`${n2(ox + d * 16)} ${n2(oy)} m ${n2(ox + d * 22)} ${n2(oy)} l S`);
    ops.push("Q");
  }

  // ── Diode (triangle + bar) ──
  function diode(ox: number, oy: number, flipX: boolean) {
    const d = flipX ? -1 : 1;
    ops.push(`q ${c} RG ${lw} w`);
    // wire in
    ops.push(`${n2(ox)} ${n2(oy)} m ${n2(ox + d * 6)} ${n2(oy)} l S`);
    // triangle (filled lightly)
    ops.push(`q 0.90 0.90 0.90 rg`);
    ops.push(`${n2(ox + d * 6)} ${n2(oy + 5)} m ${n2(ox + d * 6)} ${n2(oy - 5)} l ${n2(ox + d * 14)} ${n2(oy)} l h B`);
    ops.push("Q");
    // bar at tip
    ops.push(`${n2(ox + d * 14)} ${n2(oy - 5)} m ${n2(ox + d * 14)} ${n2(oy + 5)} l S`);
    // wire out
    ops.push(`${n2(ox + d * 14)} ${n2(oy)} m ${n2(ox + d * 22)} ${n2(oy)} l S`);
    ops.push("Q");
  }

  // Corner positions
  const TL = { x: m, y: PH - m };           // top-left
  const TR = { x: PW - m, y: PH - m };      // top-right
  const BL = { x: m, y: m };                 // bottom-left
  const BR = { x: PW - m, y: m };            // bottom-right

  if (!even) {
    // Odd pages: resistor TL, capacitor TR, ground BL, opamp BR
    resistor(TL.x, TL.y - 4, false);
    capacitor(TR.x - 27, TR.y - 4, true);
    ground(BL.x + 10, BL.y + 18);
    diode(BR.x - 22, BR.y + 6, true);
  } else {
    // Even pages: mirror — capacitor TL, resistor TR, opamp BL, ground BR
    capacitor(TL.x, TL.y - 4, false);
    resistor(TR.x - s, TR.y - 4, true);
    diode(BL.x, BL.y + 6, false);
    ground(BR.x - 10, BR.y + 18);
  }

  // Small L-shaped corner marks (thin lines framing the corners)
  const cl = 10; // corner line length
  ops.push(`q 0.85 0.85 0.85 RG 0.3 w`);
  // TL
  ops.push(`${n2(m)} ${n2(PH - m + 6)} m ${n2(m)} ${n2(PH - m + 6)} l ${n2(m)} ${n2(PH - m - cl)} l S`);
  ops.push(`${n2(m - 1)} ${n2(PH - m + 6)} m ${n2(m + cl)} ${n2(PH - m + 6)} l S`);
  // TR
  ops.push(`${n2(PW - m)} ${n2(PH - m + 6)} m ${n2(PW - m)} ${n2(PH - m - cl)} l S`);
  ops.push(`${n2(PW - m + 1)} ${n2(PH - m + 6)} m ${n2(PW - m - cl)} ${n2(PH - m + 6)} l S`);
  // BL
  ops.push(`${n2(m)} ${n2(m - 6)} m ${n2(m)} ${n2(m + cl)} l S`);
  ops.push(`${n2(m - 1)} ${n2(m - 6)} m ${n2(m + cl)} ${n2(m - 6)} l S`);
  // BR
  ops.push(`${n2(PW - m)} ${n2(m - 6)} m ${n2(PW - m)} ${n2(m + cl)} l S`);
  ops.push(`${n2(PW - m + 1)} ${n2(m - 6)} m ${n2(PW - m - cl)} ${n2(m - 6)} l S`);
  ops.push("Q");

  return ops.join("\n");
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

    // ── F1: Source Code Pro Regular (TrueType) ──
    const regularTtf = this.loadFont(extensionPath, "SourceCodePro-Regular.ttf");
    const f1FileId = this.objs.length + 1;
    this.objs.push({
      text: `<< /Length ${regularTtf.length} /Length1 ${regularTtf.length} >>`,
      binary: regularTtf,
    });
    const f1DescId = this.objs.length + 1;
    this.addObj(
      `<< /Type /FontDescriptor /FontName /SourceCodePro-Regular /Flags 33 ` +
      `/FontBBox [-200 -300 1200 1000] /ItalicAngle 0 /Ascent 984 /Descent -273 ` +
      `/CapHeight 700 /StemV 80 /FontFile2 ${f1FileId} 0 R >>`
    );
    const w600 = new Array(95).fill("600").join(" ");
    const f1Id = this.objs.length + 1;
    this.addObj(
      `<< /Type /Font /Subtype /TrueType /BaseFont /SourceCodePro-Regular ` +
      `/FirstChar 32 /LastChar 126 /Widths [${w600}] ` +
      `/FontDescriptor ${f1DescId} 0 R /Encoding /WinAnsiEncoding >>`
    );

    // ── F2: Source Code Pro Bold (TrueType) ──
    const boldTtf = this.loadFont(extensionPath, "SourceCodePro-Bold.ttf");
    const f2FileId = this.objs.length + 1;
    this.objs.push({
      text: `<< /Length ${boldTtf.length} /Length1 ${boldTtf.length} >>`,
      binary: boldTtf,
    });
    const f2DescId = this.objs.length + 1;
    this.addObj(
      `<< /Type /FontDescriptor /FontName /SourceCodePro-Bold /Flags 33 ` +
      `/FontBBox [-200 -300 1200 1000] /ItalicAngle 0 /Ascent 984 /Descent -273 ` +
      `/CapHeight 700 /StemV 120 /FontFile2 ${f2FileId} 0 R >>`
    );
    const f2Id = this.objs.length + 1;
    this.addObj(
      `<< /Type /Font /Subtype /TrueType /BaseFont /SourceCodePro-Bold ` +
      `/FirstChar 32 /LastChar 126 /Widths [${w600}] ` +
      `/FontDescriptor ${f2DescId} 0 R /Encoding /WinAnsiEncoding >>`
    );

    // ── F3: Artypa Regular (CFF / Type1C) ──
    const artypaCff = this.loadFont(extensionPath, "Artypa-Regular.cff");
    const f3FileId = this.objs.length + 1;
    this.objs.push({
      text: `<< /Length ${artypaCff.length} /Subtype /Type1C >>`,
      binary: artypaCff,
    });
    const f3DescId = this.objs.length + 1;
    this.addObj(
      `<< /Type /FontDescriptor /FontName /Artypa-Regular /Flags 32 ` +
      `/FontBBox [-100 -200 1400 1100] /ItalicAngle 0 /Ascent 1100 /Descent -200 ` +
      `/CapHeight 1100 /StemV 80 /FontFile3 ${f3FileId} 0 R >>`
    );
    const artypaWidths = "500 299 600 600 500 500 500 600 500 500 600 500 253 500 299 600 " +
      "500 500 500 500 500 500 500 500 500 500 600 600 500 500 500 692 500 " +
      "949 1018 849 956 864 844 1053 1205 423 606 976 825 1230 910 1024 824 1044 958 853 1108 928 951 1352 832 981 1008 " +
      "500 600 500 600 600 500 " +
      "1124 1018 849 956 864 844 1053 1205 423 606 976 825 1230 910 1024 824 1044 958 853 1108 928 951 1352 832 981 1008 " +
      "500 500 500 500";
    const f3Id = this.objs.length + 1;
    this.addObj(
      `<< /Type /Font /Subtype /Type1 /BaseFont /Artypa-Regular ` +
      `/FirstChar 32 /LastChar 126 /Widths [${artypaWidths}] ` +
      `/FontDescriptor ${f3DescId} 0 R /Encoding /WinAnsiEncoding >>`
    );

    // ── Image XObject (if present) ──
    if (this.imgData) {
      this.imgObjId = this.objs.length + 1;
      this.objs.push({
        text: `<< /Type /XObject /Subtype /Image /Width ${this.imgW} /Height ${this.imgH} ` +
              `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${this.imgData.length} >>`,
        binary: this.imgData,
      });
    }

    // ── Pages ──
    const pids: number[] = [];
    for (const pg of this.pageList) {
      const streamBuf = Buffer.from(pg.stream, "binary");
      const cid = this.objs.length + 1;
      this.objs.push({ text: `<< /Length ${streamBuf.length} >>`, binary: streamBuf });

      let res = `/Resources << /Font << /F1 ${f1Id} 0 R /F2 ${f2Id} 0 R /F3 ${f3Id} 0 R >>`;
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
  room(): number { return this.y - PM - 20; }
  ok(pts: number): boolean { return this.room() >= pts; }
  footer(pageNum: number): void {
    this.ops.push(`BT /F1 7 Tf 0.55 0.55 0.55 rg ${n2(PW / 2)} ${n2(PM / 2)} Td (${esc(String(pageNum))}) Tj ET`);
  }
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

  // ── COVER PAGE ─────────────────────────────────────────────────
  {
    const ops: string[] = [];
    // "PATCHBOOK" in Artypa, centered
    const titleFontSize = 60;
    // Artypa widths for PATCHBOOK: P=824 A=949 T=1108 C=849 H=1205 B=1018 O=1024 K=976
    const artypaW: Record<string, number> = {
      P: 824, A: 949, T: 1108, C: 849, H: 1205, B: 1018, O: 1024, K: 976,
    };
    const titleText = "PATCHBOOK";
    let titleW = 0;
    for (const ch of titleText) { titleW += (artypaW[ch] || 600) / 1000 * titleFontSize; }
    const titleX = (PW - titleW) / 2;
    const titleY = PH / 2 + 30;
    ops.push(`BT /F3 ${titleFontSize} Tf 0.15 0.15 0.15 rg ${n2(titleX)} ${n2(titleY)} Td (${esc(titleText)}) Tj ET`);

    // Patch name in Source Code Pro Regular, centered below
    const subFontSize = 14;
    const subW = patchName.length * 600 / 1000 * subFontSize;
    const subX = (PW - subW) / 2;
    const subY = titleY - 40;
    ops.push(`BT /F1 ${subFontSize} Tf 0.4 0.4 0.4 rg ${n2(subX)} ${n2(subY)} Td (${esc(patchName)}) Tj ET`);

    // Thin line between title and subtitle
    const lineW = 120;
    ops.push(`q 0.75 0.75 0.75 RG 0.5 w ${n2((PW - lineW) / 2)} ${n2(subY + 18)} m ${n2((PW + lineW) / 2)} ${n2(subY + 18)} l S Q`);

    pdf.addPage(ops.join("\n"));
  }

  // ── Collect content pages first (to build TOC) ─────────────────
  // We need to know page assignments before writing the TOC.
  // Strategy: build all content streams, then insert TOC, then add footers.

  // Ensure graph panel is open and rendered
  await graphView.ensurePanelReady(doc.uri);

  let img: { jpeg: Buffer; width: number; height: number } | null = null;
  try { img = await graphView.requestGraphImage(); } catch { /* panel not open */ }

  // -- Graph page stream(s) --
  const graphPages: { stream: string; hasImage: boolean }[] = [];
  if (img && img.jpeg.length > 0) {
    pdf.setImage(img.jpeg, img.width, img.height);

    const titleH = 50;
    const areaW = PW - 2 * PM;
    const areaH = PH - 2 * PM - titleH;
    const aspect = img.width / img.height;
    let dw: number, dh: number;
    if (areaW / areaH > aspect) { dh = areaH; dw = dh * aspect; } else { dw = areaW; dh = dw / aspect; }
    const dx = PM + (areaW - dw) / 2;
    const dy = PM + (areaH - dh) / 2;

    const ops: string[] = [];
    ops.push(`BT /F2 18 Tf ${n2(PM)} ${n2(PH - PM)} Td (${esc(patchName)}) Tj ET`);
    ops.push(`BT /F1 8 Tf 0.5 0.5 0.5 rg ${n2(PM)} ${n2(PH - PM - 16)} Td (${esc("Patchbook - Signal Flow Graph")}) Tj ET`);
    ops.push(`q 0.7 0.7 0.7 RG 0.4 w ${n2(PM)} ${n2(PH - PM - 22)} m ${n2(PW - PM)} ${n2(PH - PM - 22)} l S Q`);
    ops.push(`q ${n2(dw)} 0 0 ${n2(dh)} ${n2(dx)} ${n2(dy)} cm /Img1 Do Q`);
    graphPages.push({ stream: ops.join("\n"), hasImage: true });
  } else {
    const pg = new Pg();
    pg.txt(patchName, PM, 18, "F2");
    pg.dn(22);
    pg.txtC("Patchbook - Signal Flow (open graph panel for visual export)", PM, 8, 0.5, 0.5, 0.5);
    pg.dn(8);
    pg.hr();
    graphPages.push({ stream: pg.out(), hasImage: false });
  }

  // -- Module detail page streams --
  // Track which page each module starts on (relative to detail pages)
  const detailStreams: string[] = [];
  const modulePageMap: { name: string; pageIdx: number }[] = [];

  let pg = new Pg();
  pg.txt("MODULE DETAILS", PM, 14, "F2");
  pg.dn(24);

  for (const modName of moduleNames) {
    const mod = data.modules[modName];
    const cat = getModuleByName(modName) || getModuleByName(modName.replace(/\s+#?\d+\s*$/, "").trim());
    const bh = blockH(mod, cat);

    if (!pg.ok(bh) && pg.y < PH - PM - 5) {
      detailStreams.push(pg.out());
      pg = new Pg();
    }
    modulePageMap.push({ name: modName, pageIdx: detailStreams.length });
    drawBlock(pg, modName, mod, cat);
  }
  detailStreams.push(pg.out());

  // ── Compute absolute page numbers ──────────────────────────────
  // Page 1: Cover (no page number)
  // Page 2: TOC
  // Page 3+: Graph page(s)
  // After graph: Detail pages
  const tocPageNum = 2;
  const graphStartPage = 3; // TOC is always 1 page
  const detailStartPage = graphStartPage + graphPages.length;
  const totalPages = 1 + 1 + graphPages.length + detailStreams.length; // cover + toc + graph + details

  // ── Build TOC page ─────────────────────────────────────────────
  {
    const tp = new Pg();
    tp.txt("TABLE OF CONTENTS", PM, 14, "F2");
    tp.dn(30);

    // Graph section
    tp.txtC("Signal Flow Graph", PM + 10, 10, 0.2, 0.2, 0.2, "F2");
    tp.ops.push(`BT /F1 10 Tf 0.4 0.4 0.4 rg ${n2(PW - PM - 20)} ${n2(tp.y)} Td (${esc(String(graphStartPage))}) Tj ET`);
    tp.dn(20);

    // Module details header
    tp.txtC("Module Details", PM + 10, 10, 0.2, 0.2, 0.2, "F2");
    tp.ops.push(`BT /F1 10 Tf 0.4 0.4 0.4 rg ${n2(PW - PM - 20)} ${n2(tp.y)} Td (${esc(String(detailStartPage))}) Tj ET`);
    tp.dn(18);

    // Dotted leader helper
    const leaderX1 = PM + 30;
    const leaderX2 = PW - PM - 30;

    for (const entry of modulePageMap) {
      if (!tp.ok(14)) {
        // TOC shouldn't overflow one page normally, but handle it
        break;
      }
      const absPage = detailStartPage + entry.pageIdx;
      tp.txtC(entry.name, PM + 20, 9, 0.35, 0.35, 0.35);
      // Dotted leader line
      const nameW = entry.name.length * 600 / 1000 * 9;
      const dotStart = PM + 20 + nameW + 4;
      const dotEnd = PW - PM - 30;
      if (dotEnd > dotStart + 10) {
        tp.ops.push(`q 0.75 0.75 0.75 RG 0.3 w [1 3] 0 d ${n2(dotStart)} ${n2(tp.y + 3)} m ${n2(dotEnd)} ${n2(tp.y + 3)} l S Q`);
      }
      // Page number right-aligned
      tp.ops.push(`BT /F1 9 Tf 0.4 0.4 0.4 rg ${n2(PW - PM - 20)} ${n2(tp.y)} Td (${esc(String(absPage))}) Tj ET`);
      tp.dn(16);
    }

    tp.footer(tocPageNum);
    tp.ops.push(cornerDecorations(tocPageNum));
    pdf.addPage(tp.out());
  }

  // ── Add graph pages with footers ───────────────────────────────
  for (let i = 0; i < graphPages.length; i++) {
    const gpNum = graphStartPage + i;
    const footer = `BT /F1 7 Tf 0.55 0.55 0.55 rg ${n2(PW / 2)} ${n2(PM / 2)} Td (${esc(String(gpNum))}) Tj ET`;
    const stream = graphPages[i].stream + "\n" + footer + "\n" + cornerDecorations(gpNum);
    pdf.addPage(stream, graphPages[i].hasImage);
  }

  // ── Add detail pages with footers ──────────────────────────────
  for (let i = 0; i < detailStreams.length; i++) {
    const dpNum = detailStartPage + i;
    const footer = `BT /F1 7 Tf 0.55 0.55 0.55 rg ${n2(PW / 2)} ${n2(PM / 2)} Td (${esc(String(dpNum))}) Tj ET`;
    pdf.addPage(detailStreams[i] + "\n" + footer + "\n" + cornerDecorations(dpNum));
  }

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
