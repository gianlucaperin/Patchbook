import * as vscode from "vscode";
import * as path from "path";
import { parse } from "./parser";
import { getModules, ModuleInfo } from "./moduleDatabase";

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
