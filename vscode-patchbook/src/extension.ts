import * as vscode from "vscode";
import { PatchbookCompletionProvider } from "./completionProvider";
import { loadModules, openModulesFile } from "./moduleDatabase";
import { exportJSON, exportPDF, newPatch, addModule, removeModule } from "./commands";
import { GraphViewProvider } from "./graphView";
import { ModuleSidebarProvider } from "./moduleSidebar";
import { FileExplorerProvider } from "./fileExplorer";
import { openNewPatchbookFile } from "./newPatchFile";

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

  // Module sidebar
  const sidebarProvider = new ModuleSidebarProvider(context);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("patchbookModuleDB", sidebarProvider)
  );

  // File explorer
  const fileExplorer = new FileExplorerProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("patchbookFileExplorer", fileExplorer)
  );

  // New patchbook file command
  context.subscriptions.push(
    vscode.commands.registerCommand("patchbook.files.newPatchbook", () =>
      openNewPatchbookFile(context)
    )
  );

  // Sidebar commands
  context.subscriptions.push(
    vscode.commands.registerCommand("patchbook.db.viewModule", (item) =>
      sidebarProvider.viewModule(item)
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("patchbook.db.addModule", () =>
      sidebarProvider.addModule()
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("patchbook.db.editModule", (item) =>
      sidebarProvider.editModule(item)
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("patchbook.db.deleteModule", (item) =>
      sidebarProvider.deleteModule(item)
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("patchbook.db.resetDefaults", () =>
      sidebarProvider.resetDefaults()
    )
  );

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
  context.subscriptions.push(
    vscode.commands.registerCommand("patchbook.addModule", () => addModule())
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("patchbook.removeModule", () => removeModule())
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("patchbook.graph.zoomIn", () =>
      graphView.executeCommand("zoomIn")
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("patchbook.graph.zoomOut", () =>
      graphView.executeCommand("zoomOut")
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("patchbook.graph.fit", () =>
      graphView.executeCommand("fit")
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("patchbook.graph.reset", () =>
      graphView.executeCommand("reset")
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("patchbook.graph.addModule", () =>
      graphView.executeCommand("addModule")
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("patchbook.graph.removeModule", () =>
      graphView.executeCommand("removeModule")
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("patchbook.exportPDF", () =>
      exportPDF(graphView, context.extensionPath)
    )
  );
}

export function deactivate(): void {
  // No cleanup needed
}
