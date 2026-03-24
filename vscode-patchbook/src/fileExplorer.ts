import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

class FileItem extends vscode.TreeItem {
  constructor(
    public readonly resourceUri: vscode.Uri,
    public readonly isDirectory: boolean
  ) {
    super(
      resourceUri,
      isDirectory
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );
    if (!isDirectory) {
      this.command = {
        command: "vscode.open",
        title: "Open File",
        arguments: [resourceUri],
      };
    }
  }
}

export class FileExplorerProvider implements vscode.TreeDataProvider<FileItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<FileItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private watcher: vscode.FileSystemWatcher | undefined;

  constructor() {
    this.watcher = vscode.workspace.createFileSystemWatcher("**/*");
    this.watcher.onDidCreate(() => this._onDidChangeTreeData.fire());
    this.watcher.onDidDelete(() => this._onDidChangeTreeData.fire());
    this.watcher.onDidChange(() => this._onDidChangeTreeData.fire());
  }

  getTreeItem(element: FileItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: FileItem): FileItem[] {
    const dir = element
      ? element.resourceUri.fsPath
      : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    if (!dir || !fs.existsSync(dir)) {
      return [];
    }

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      return entries
        .sort((a, b) => {
          // Directories first, then alphabetical
          if (a.isDirectory() && !b.isDirectory()) { return -1; }
          if (!a.isDirectory() && b.isDirectory()) { return 1; }
          return a.name.localeCompare(b.name);
        })
        .map(
          (e) =>
            new FileItem(
              vscode.Uri.file(path.join(dir, e.name)),
              e.isDirectory()
            )
        );
    } catch {
      return [];
    }
  }

  dispose(): void {
    this.watcher?.dispose();
  }
}
