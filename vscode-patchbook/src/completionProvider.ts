import * as vscode from "vscode";
import {
  getModules,
  getModuleByName,
  ModuleInfo,
} from "./moduleDatabase";

export class PatchbookCompletionProvider
  implements vscode.CompletionItemProvider
{
  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.CompletionItem[] | undefined {
    const lineText = document.lineAt(position).text;
    const textBefore = lineText.substring(0, position.character);

    // After "- " suggest output modules (connection start)
    if (/^\s*-\s+$/.test(textBefore)) {
      return this.moduleCompletions("Output module");
    }

    // After "* " suggest modules (parameter declaration)
    if (/^\s*\*\s+$/.test(textBefore)) {
      return this.moduleCompletions("Parameter target");
    }

    // After connection operator (>> -> p> g> t> c>) followed by space, suggest input modules
    if (/(?:->|>>|[a-z]>)\s+$/.test(textBefore)) {
      return this.moduleCompletions("Input module");
    }

    // Inside parentheses after a module name — suggest ports
    const portCtx = this.getPortContext(textBefore, lineText);
    if (portCtx) {
      return this.portCompletions(portCtx.moduleName, portCtx.direction);
    }

    // After "| " in multi-line params, suggest parameter names
    const paramCtx = this.getParamContext(document, position, textBefore);
    if (paramCtx) {
      return this.parameterCompletions(paramCtx);
    }

    return undefined;
  }

  private moduleCompletions(context: string): vscode.CompletionItem[] {
    const items: vscode.CompletionItem[] = [];
    for (const [, mod] of getModules()) {
      const item = new vscode.CompletionItem(
        mod.name,
        vscode.CompletionItemKind.Module
      );
      item.detail = `${mod.manufacturer} — ${mod.type}`;
      item.documentation = new vscode.MarkdownString(
        this.formatModuleDoc(mod)
      );
      item.sortText = `0_${mod.name}`;
      items.push(item);
    }
    return items;
  }

  private portCompletions(
    moduleName: string,
    direction: "input" | "output"
  ): vscode.CompletionItem[] {
    const mod = getModuleByName(moduleName);
    if (!mod) {
      return [];
    }
    const ports = direction === "output" ? mod.outputs : mod.inputs;
    return ports.map((port) => {
      const item = new vscode.CompletionItem(
        port,
        vscode.CompletionItemKind.Field
      );
      item.detail = `${direction} port — ${mod.name}`;
      return item;
    });
  }

  private parameterCompletions(moduleName: string): vscode.CompletionItem[] {
    const mod = getModuleByName(moduleName);
    if (!mod) {
      return [];
    }
    return mod.parameters.map((param) => {
      const item = new vscode.CompletionItem(
        param,
        vscode.CompletionItemKind.Property
      );
      item.detail = `parameter — ${mod.name}`;
      item.insertText = `${param} = `;
      return item;
    });
  }

  private getPortContext(
    textBefore: string,
    _fullLine: string
  ): { moduleName: string; direction: "input" | "output" } | undefined {
    // Output port: "- ModuleName ("
    const outMatch = textBefore.match(
      /^\s*-\s+(.+?)\s*\(\s*$/
    );
    if (outMatch) {
      return { moduleName: outMatch[1].trim(), direction: "output" };
    }

    // Input port: after connection operator ">> ModuleName ("
    const inMatch = textBefore.match(
      /(?:->|>>|[a-z]>)\s+(.+?)\s*\(\s*$/
    );
    if (inMatch) {
      return { moduleName: inMatch[1].trim(), direction: "input" };
    }

    return undefined;
  }

  private getParamContext(
    document: vscode.TextDocument,
    position: vscode.Position,
    textBefore: string
  ): string | undefined {
    // Multi-line: "| " — look upward for "* Module:"
    if (/^\s*\|\s*$/.test(textBefore)) {
      for (let i = position.line - 1; i >= 0; i--) {
        const prev = document.lineAt(i).text.trim();
        const headerMatch = prev.match(/^\*\s+(.+?):\s*$/);
        if (headerMatch) {
          return headerMatch[1].trim();
        }
        // Stop if we hit a voice or connection line
        if (/^[A-Z][A-Z0-9 ]*:$/.test(prev) || /^\s*-\s+/.test(prev)) {
          break;
        }
      }
    }

    // Single-line after "* Module: " with existing params, suggest after "|"
    const singleMatch = textBefore.match(
      /^\s*\*\s+(.+?):\s+.*\|\s*$/
    );
    if (singleMatch) {
      return singleMatch[1].trim();
    }

    return undefined;
  }

  private formatModuleDoc(mod: ModuleInfo): string {
    const lines: string[] = [];
    lines.push(`**${mod.name}** — *${mod.manufacturer}*\n`);
    lines.push(mod.description + "\n");
    lines.push(`**Type:** ${mod.type}\n`);
    if (mod.inputs.length) {
      lines.push(`**Inputs:** ${mod.inputs.join(", ")}\n`);
    }
    if (mod.outputs.length) {
      lines.push(`**Outputs:** ${mod.outputs.join(", ")}\n`);
    }
    if (mod.parameters.length) {
      lines.push(`**Parameters:** ${mod.parameters.join(", ")}`);
    }
    return lines.join("\n");
  }
}
