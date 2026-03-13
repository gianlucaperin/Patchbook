/**
 * Patchbook Parser — TypeScript port of patchbook.py
 * Parses Patchbook markup into a structured JSON object.
 */

export interface ConnectionOut {
  input_module: string;
  input_port: string;
  connection_type: string;
  voice: string;
  id: number;
  [key: string]: string | number;
}

export interface ConnectionIn {
  output_module: string;
  output_port: string;
  connection_type: string;
  voice: string;
  id: number;
  [key: string]: string | number;
}

export interface ModuleData {
  parameters: Record<string, string>;
  connections: {
    out: Record<string, ConnectionOut[]>;
    in: Record<string, ConnectionIn>;
  };
}

export interface PatchbookData {
  info: { patchbook_version: string };
  modules: Record<string, ModuleData>;
  comments: string[];
}

const CONNECTION_TYPES: Record<string, string> = {
  "->": "audio",
  ">>": "cv",
  "p>": "pitch",
  "g>": "gate",
  "t>": "trigger",
  "c>": "clock",
};

export function parse(text: string): PatchbookData {
  const data: PatchbookData = {
    info: { patchbook_version: "b3" },
    modules: {},
    comments: [],
  };

  let lastModule = "";
  let lastVoice = "";
  let connectionID = 0;

  function ensureModule(module: string, port?: string, direction?: string) {
    if (!(module in data.modules)) {
      data.modules[module] = {
        parameters: {},
        connections: { out: {}, in: {} },
      };
    }
    if (port && direction === "in") {
      if (!(port in data.modules[module].connections.in)) {
        // Will be set when connection is added
      }
    }
    if (port && direction === "out") {
      if (!(port in data.modules[module].connections.out)) {
        data.modules[module].connections.out[port] = [];
      }
    }
  }

  function parseArguments(argsStr: string): Record<string, string> {
    const clean = argsStr.replace(/^\[/, "").replace(/\]$/, "");
    const pairs = clean.split(",");
    const result: Record<string, string> = {};
    for (const pair of pairs) {
      const parts = pair.split("=");
      if (parts.length === 2) {
        result[parts[0].trim()] = parts[1].trim();
      }
    }
    return result;
  }

  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();

    // Comments: // ...
    const commentMatch = trimmed.match(/^\/\/\s?(.+)$/);
    if (commentMatch) {
      data.comments.push(commentMatch[1].trim());
      continue;
    }

    // Voices: VOICE 1:
    const voiceMatch = line.match(/^([A-Z][A-Z0-9 ]*):$/);
    if (voiceMatch) {
      lastVoice = voiceMatch[1].toUpperCase();
      continue;
    }

    // Connections: - Module (Port) >> Module (Port) [args]
    const connMatch = trimmed.match(
      /^-\s+(.+?)\s*\((.+?)\)\s*(->|>>|[a-z]>)\s+(.+?)\s*\((.+?)\)\s*(\[.+\])?\s*$/
    );
    if (connMatch) {
      connectionID++;
      const outModule = connMatch[1].toLowerCase().trim();
      const outPort = connMatch[2].toLowerCase().trim();
      const connType = CONNECTION_TYPES[connMatch[3].toLowerCase()] ?? "cv";
      const inModule = connMatch[4].toLowerCase().trim();
      const inPort = connMatch[5].toLowerCase().trim();
      const args = connMatch[6] ? parseArguments(connMatch[6]) : {};

      ensureModule(outModule, outPort, "out");
      ensureModule(inModule, inPort, "in");

      const outEntry: ConnectionOut = {
        input_module: inModule,
        input_port: inPort,
        connection_type: connType,
        voice: lastVoice,
        id: connectionID,
        ...args,
      };

      const inEntry: ConnectionIn = {
        output_module: outModule,
        output_port: outPort,
        connection_type: connType,
        voice: lastVoice,
        id: connectionID,
        ...args,
      };

      data.modules[outModule].connections.out[outPort].push(outEntry);
      data.modules[inModule].connections.in[inPort] = inEntry;
      continue;
    }

    // Single-line parameters: * Module: param = val | param = val
    const paramSingleMatch = trimmed.match(/^\*\s+(.+?):\s+(.+)$/);
    if (paramSingleMatch) {
      const module = paramSingleMatch[1].trim().toLowerCase();
      const paramsStr = paramSingleMatch[2];
      ensureModule(module);
      const paramPairs = paramsStr.split("|");
      for (const pair of paramPairs) {
        const parts = pair.split("=");
        if (parts.length === 2) {
          data.modules[module].parameters[parts[0].trim().toLowerCase()] =
            parts[1].trim();
        }
      }
      lastModule = module;
      continue;
    }

    // Module header (multi-line params): * Module:
    const paramHeaderMatch = trimmed.match(/^\*\s+(.+?):\s*$/);
    if (paramHeaderMatch) {
      const module = paramHeaderMatch[1].trim().toLowerCase();
      ensureModule(module);
      lastModule = module;
      continue;
    }

    // Multi-line parameter: | param = value
    if (trimmed.startsWith("|") && trimmed.includes("=") && lastModule) {
      const paramLine = trimmed.replace(/^\|/, "").trim();
      const parts = paramLine.split("=");
      if (parts.length >= 2) {
        const name = parts[0].trim().toLowerCase();
        const value = parts.slice(1).join("=").trim();
        ensureModule(lastModule);
        data.modules[lastModule].parameters[name] = value;
      }
      continue;
    }
  }

  return data;
}

/** Generate DOT code for GraphViz from parsed data */
export function generateDot(
  data: PatchbookData,
  direction: "LR" | "TB" = "LR"
): string {
  const lineTypes: Record<string, Record<string, string>> = {
    audio: { style: "bold" },
    cv: { color: "gray" },
    gate: { color: "red", style: "dashed" },
    trigger: { color: "orange", style: "dashed" },
    pitch: { color: "blue" },
    clock: { color: "purple", style: "dashed" },
  };

  const rankDir = direction === "TB" ? "BT" : "LR";
  const fromToken = direction === "TB" ? ":s -> " : ":e -> ";
  const toToken = direction === "TB" ? ":n " : ":w ";

  const lines: string[] = [];
  const connections: string[] = [];

  lines.push(`digraph G{`);
  lines.push(`rankdir = ${rankDir};`);
  lines.push(`splines = polyline;`);
  lines.push(`ordering=out;`);

  const sanitize = (s: string) => s.replace(/[^A-Za-z0-9]/g, "");

  for (const module of Object.keys(data.modules).sort()) {
    const mod = data.modules[module];

    // Outputs
    const outputs = mod.connections.out;
    const outParts: string[] = [];
    for (const out of Object.keys(outputs).sort()) {
      const outF = "_" + sanitize(out);
      outParts.push(`<${outF}> ${out.toUpperCase()}`);

      for (const c of outputs[out]) {
        const styleArr: string[] = [];
        const gvParams = ["color", "weight", "style", "arrowtail", "dir"];
        for (const p of gvParams) {
          if (p in c && typeof c[p] === "string") {
            styleArr.push(`${p}=${c[p]}`);
          } else if (lineTypes[c.connection_type]?.[p]) {
            styleArr.push(`${p}=${lineTypes[c.connection_type][p]}`);
          }
        }
        const lineStyle =
          styleArr.length > 0 ? `[${styleArr.join(", ")}]` : "";
        const inF = "_" + sanitize(c.input_port);
        connections.push(
          `${sanitize(module)}:${outF}${fromToken}${sanitize(
            c.input_module
          )}:${inF}${toToken}${lineStyle}`
        );
      }
    }

    // Inputs
    const inputs = mod.connections.in;
    const inParts: string[] = [];
    for (const inp of Object.keys(inputs).sort()) {
      const inF = "_" + sanitize(inp);
      inParts.push(`<${inF}> ${inp.toUpperCase()}`);
    }

    // Parameters
    const params = mod.parameters;
    const paramParts: string[] = [];
    for (const par of Object.keys(params).sort()) {
      paramParts.push(`${par.charAt(0).toUpperCase() + par.slice(1)} = ${params[par]}`);
    }

    const middle =
      paramParts.length > 0
        ? `{{${module.toUpperCase()}}|{${paramParts.join("\\n")}}}`
        : module.toUpperCase();

    const label = `{ {${inParts.join(" | ")}}|${middle}| {${outParts.join(
      " | "
    )}}}`;
    lines.push(
      `${sanitize(module)}[label="${label}"  shape=Mrecord]`
    );
  }

  connections.sort();
  lines.push(...connections);

  if (data.comments.length > 0) {
    const fmtComments = data.comments
      .map((c) => `{${c}}`)
      .join("|");
    lines.push(
      `comments[label=<{{{<b>PATCH COMMENTS</b>}|${fmtComments}}}>  shape=Mrecord]`
    );
  }

  lines.push("}");
  return lines.join("\n");
}
