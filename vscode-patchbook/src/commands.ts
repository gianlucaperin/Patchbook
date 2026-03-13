import * as vscode from "vscode";
import { parse } from "./parser";

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
