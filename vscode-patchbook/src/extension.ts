import * as vscode from "vscode";
import { PatchbookCompletionProvider } from "./completionProvider";
import { loadModules, openModulesFile } from "./moduleDatabase";
import { exportJSON, newPatch } from "./commands";
import { GraphViewProvider } from "./graphView";

export function activate(context: vscode.ExtensionContext): void {
  // Load module database
  loadModules(context);

  // Completion provider
  const completionProvider = new PatchbookCompletionProvider();
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      { language: "patchbook" },
      completionProvider,
      "-",
      "*",
      "(",
      "|",
      " "
    )
  );

  // Graph view
  const graphView = new GraphViewProvider(context.extensionUri);

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand("patchbook.newPatch", () => newPatch())
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("patchbook.exportJSON", exportJSON)
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("patchbook.showGraph", () =>
      graphView.show()
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("patchbook.editModules", () =>
      openModulesFile(context)
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("patchbook.reloadModules", () => {
      loadModules(context);
      vscode.window.showInformationMessage(
        "Patchbook: Module database reloaded."
      );
    })
  );
}

export function deactivate(): void {
  // No cleanup needed
}
