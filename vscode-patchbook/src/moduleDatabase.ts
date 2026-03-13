import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

export interface ModuleInfo {
  name: string;
  manufacturer: string;
  type: string;
  description: string;
  inputs: string[];
  outputs: string[];
  parameters: string[];
}

interface ModulesFile {
  modules: ModuleInfo[];
}

let moduleMap: Map<string, ModuleInfo> = new Map();
let modulesFilePath: string | undefined;

/** Return the path to the user's modules JSON file, refreshing from defaults when the bundled catalog is updated */
function getModulesPath(context: vscode.ExtensionContext): string {
  if (modulesFilePath) {
    return modulesFilePath;
  }
  const storageDir = context.globalStorageUri.fsPath;
  if (!fs.existsSync(storageDir)) {
    fs.mkdirSync(storageDir, { recursive: true });
  }
  const userFile = path.join(storageDir, "modules.json");
  const defaultFile = path.join(
    context.extensionPath,
    "data",
    "default-modules.json"
  );
  // Re-copy defaults when the bundled file is newer than the cached copy
  if (!fs.existsSync(userFile)) {
    fs.copyFileSync(defaultFile, userFile);
  } else {
    const defaultMtime = fs.statSync(defaultFile).mtimeMs;
    const userMtime = fs.statSync(userFile).mtimeMs;
    if (defaultMtime > userMtime) {
      fs.copyFileSync(defaultFile, userFile);
    }
  }
  modulesFilePath = userFile;
  return userFile;
}

export function loadModules(context: vscode.ExtensionContext): void {
  const filePath = getModulesPath(context);
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const data: ModulesFile = JSON.parse(raw);
    moduleMap.clear();
    for (const mod of data.modules) {
      moduleMap.set(mod.name.toLowerCase(), mod);
    }
  } catch {
    vscode.window.showErrorMessage("Patchbook: Failed to load module database.");
  }
}

export function getModules(): Map<string, ModuleInfo> {
  return moduleMap;
}

export function getModuleByName(name: string): ModuleInfo | undefined {
  return moduleMap.get(name.toLowerCase());
}

export function getAllModuleNames(): string[] {
  return Array.from(moduleMap.values()).map((m) => m.name);
}

export async function openModulesFile(
  context: vscode.ExtensionContext
): Promise<void> {
  const filePath = getModulesPath(context);
  const doc = await vscode.workspace.openTextDocument(filePath);
  await vscode.window.showTextDocument(doc);
}
