import * as vscode from "vscode";
import { parse, PatchbookData } from "./parser";

export class GraphViewProvider {
  private panel: vscode.WebviewPanel | undefined;

  constructor(private readonly extensionUri: vscode.Uri) {}

  show(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== "patchbook") {
      vscode.window.showWarningMessage(
        "Patchbook: Open a .pb or .patchbook file first."
      );
      return;
    }

    const text = editor.document.getText();
    const data = parse(text);

    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
    } else {
      this.panel = vscode.window.createWebviewPanel(
        "patchbookGraph",
        "Patchbook — Signal Flow",
        vscode.ViewColumn.Beside,
        { enableScripts: true }
      );
      this.panel.onDidDispose(() => {
        this.panel = undefined;
      });
    }

    this.panel.webview.html = this.buildHtml(data);
  }

  private buildHtml(data: PatchbookData): string {
    const graphData = this.toGraphData(data);
    const config =
      vscode.workspace.getConfiguration("patchbook").get<string>("graphDirection") ?? "LR";

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Patchbook Graph</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #1e1e1e;
    color: #ccc;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    overflow: hidden;
    width: 100vw; height: 100vh;
  }
  svg { width: 100%; height: 100%; }
  .module-box { fill: #2d2d2d; stroke: #555; stroke-width: 1.5; rx: 6; ry: 6; }
  .module-box:hover { stroke: #0af; stroke-width: 2; }
  .module-name { fill: #fff; font-size: 13px; font-weight: 600; text-anchor: middle; }
  .port-label { fill: #aaa; font-size: 10px; }
  .port-in .port-label { text-anchor: end; }
  .port-out .port-label { text-anchor: start; }
  .port-dot { r: 4; stroke-width: 1.5; }
  .port-dot.in { fill: #444; stroke: #888; }
  .port-dot.out { fill: #555; stroke: #aaa; }
  .param-text { fill: #888; font-size: 9px; text-anchor: middle; }
  .edge { fill: none; stroke-width: 2; }
  .edge.audio { stroke: #e8e8e8; stroke-width: 2.5; }
  .edge.cv { stroke: #888; }
  .edge.gate { stroke: #ff4444; stroke-dasharray: 6 3; }
  .edge.trigger { stroke: #ff8800; stroke-dasharray: 6 3; }
  .edge.pitch { stroke: #4488ff; }
  .edge.clock { stroke: #aa44ff; stroke-dasharray: 6 3; }
  .legend { fill: #333; stroke: #555; rx: 4; }
  .legend-text { fill: #aaa; font-size: 10px; }
  .legend-line { stroke-width: 2; }
  #controls {
    position: fixed; top: 10px; right: 10px; z-index: 10;
    display: flex; gap: 6px;
  }
  #controls button {
    background: #333; color: #ccc; border: 1px solid #555;
    border-radius: 4px; padding: 4px 10px; cursor: pointer; font-size: 13px;
  }
  #controls button:hover { background: #444; }
</style>
</head>
<body>
<div id="controls">
  <button onclick="zoomIn()">+</button>
  <button onclick="zoomOut()">−</button>
  <button onclick="resetView()">Reset</button>
</div>
<svg id="canvas"><g id="root"></g></svg>
<script>
const DATA = ${JSON.stringify(graphData)};
const DIR = "${config}";

const PORT_H = 20;
const PORT_PAD = 14;
const MOD_MIN_W = 140;
const MOD_PAD_X = 20;
const MOD_NAME_H = 28;
const PARAM_LINE_H = 14;
const LAYER_GAP_X = 260;
const LAYER_GAP_Y = 200;
const NODE_GAP = 30;

// --- layout ---
const nodes = DATA.nodes;
const edges = DATA.edges;
const nodeMap = {};
nodes.forEach(n => nodeMap[n.id] = n);

// Compute node sizes
nodes.forEach(n => {
  const maxPorts = Math.max(n.inputs.length, n.outputs.length, 1);
  const paramLines = Object.keys(n.params).length;
  const bodyH = maxPorts * PORT_H + PORT_PAD * 2;
  const paramH = paramLines * PARAM_LINE_H;
  n._h = MOD_NAME_H + bodyH + (paramH > 0 ? paramH + 8 : 0);
  const maxPortLen = Math.max(
    ...n.inputs.map(p => p.length),
    ...n.outputs.map(p => p.length),
    4
  );
  n._w = Math.max(MOD_MIN_W, maxPortLen * 7 + 80, n.name.length * 9 + 40);
});

// Assign layers via longest path (topological)
const adj = {};
const inDeg = {};
nodes.forEach(n => { adj[n.id] = []; inDeg[n.id] = 0; });
edges.forEach(e => {
  adj[e.from] = adj[e.from] || [];
  adj[e.from].push(e.to);
  inDeg[e.to] = (inDeg[e.to] || 0) + 1;
});

// BFS layer assignment
const layer = {};
const queue = nodes.filter(n => (inDeg[n.id] || 0) === 0).map(n => n.id);
queue.forEach(id => layer[id] = 0);
const visited = new Set(queue);
let qi = 0;
while (qi < queue.length) {
  const cur = queue[qi++];
  for (const next of (adj[cur] || [])) {
    layer[next] = Math.max(layer[next] || 0, (layer[cur] || 0) + 1);
    if (!visited.has(next)) {
      visited.add(next);
      queue.push(next);
    }
  }
}
// Assign unvisited nodes
nodes.forEach(n => { if (layer[n.id] === undefined) layer[n.id] = 0; });

// Group by layer
const layers = {};
nodes.forEach(n => {
  const l = layer[n.id];
  if (!layers[l]) layers[l] = [];
  layers[l].push(n);
});

const layerKeys = Object.keys(layers).map(Number).sort((a,b) => a - b);

// Position nodes
let maxW = 0, maxH = 0;
const isLR = DIR === 'LR';
layerKeys.forEach((lk, li) => {
  const group = layers[lk];
  let offset = 40;
  group.forEach(n => {
    if (isLR) {
      n._x = 40 + li * LAYER_GAP_X;
      n._y = offset;
    } else {
      n._x = offset;
      n._y = 40 + li * LAYER_GAP_Y;
    }
    offset += (isLR ? n._h : n._w) + NODE_GAP;
    maxW = Math.max(maxW, n._x + n._w);
    maxH = Math.max(maxH, n._y + n._h);
  });
});

// Compute port positions
nodes.forEach(n => {
  n._inPorts = {};
  n._outPorts = {};
  const bodyStart = n._y + MOD_NAME_H;
  n.inputs.forEach((p, i) => {
    n._inPorts[p] = {
      x: n._x,
      y: bodyStart + PORT_PAD + i * PORT_H + PORT_H / 2
    };
  });
  n.outputs.forEach((p, i) => {
    n._outPorts[p] = {
      x: n._x + n._w,
      y: bodyStart + PORT_PAD + i * PORT_H + PORT_H / 2
    };
  });
});

// --- render ---
const svg = document.getElementById('canvas');
const root = document.getElementById('root');
let scale = 1, tx = 0, ty = 0;

function renderAll() {
  root.innerHTML = '';

  // Edges (behind nodes)
  edges.forEach(e => {
    const fromNode = nodeMap[e.from];
    const toNode = nodeMap[e.to];
    if (!fromNode || !toNode) return;
    const src = fromNode._outPorts[e.fromPort];
    const dst = toNode._inPorts[e.toPort];
    if (!src || !dst) return;

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const dx = Math.abs(dst.x - src.x) * 0.5;
    const d = 'M' + src.x + ',' + src.y
            + ' C' + (src.x + dx) + ',' + src.y
            + ' ' + (dst.x - dx) + ',' + dst.y
            + ' ' + dst.x + ',' + dst.y;
    path.setAttribute('d', d);
    path.setAttribute('class', 'edge ' + e.type);
    root.appendChild(path);
  });

  // Nodes
  nodes.forEach(n => {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');

    // Background box
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', n._x);
    rect.setAttribute('y', n._y);
    rect.setAttribute('width', n._w);
    rect.setAttribute('height', n._h);
    rect.setAttribute('class', 'module-box');
    g.appendChild(rect);

    // Name header
    const nameEl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    nameEl.setAttribute('x', n._x + n._w / 2);
    nameEl.setAttribute('y', n._y + 18);
    nameEl.setAttribute('class', 'module-name');
    nameEl.textContent = n.name.toUpperCase();
    g.appendChild(nameEl);

    // Header separator
    const sep = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    sep.setAttribute('x1', n._x);
    sep.setAttribute('y1', n._y + MOD_NAME_H);
    sep.setAttribute('x2', n._x + n._w);
    sep.setAttribute('y2', n._y + MOD_NAME_H);
    sep.setAttribute('stroke', '#555');
    sep.setAttribute('stroke-width', '1');
    g.appendChild(sep);

    // Input ports
    n.inputs.forEach(p => {
      const pos = n._inPorts[p];
      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dot.setAttribute('cx', pos.x);
      dot.setAttribute('cy', pos.y);
      dot.setAttribute('class', 'port-dot in');
      g.appendChild(dot);

      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.setAttribute('x', pos.x + 10);
      label.setAttribute('y', pos.y + 3);
      label.setAttribute('class', 'port-label');
      label.setAttribute('text-anchor', 'start');
      label.textContent = p;
      g.appendChild(label);
    });

    // Output ports
    n.outputs.forEach(p => {
      const pos = n._outPorts[p];
      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dot.setAttribute('cx', pos.x);
      dot.setAttribute('cy', pos.y);
      dot.setAttribute('class', 'port-dot out');
      g.appendChild(dot);

      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.setAttribute('x', pos.x - 10);
      label.setAttribute('y', pos.y + 3);
      label.setAttribute('class', 'port-label');
      label.setAttribute('text-anchor', 'end');
      label.textContent = p;
      g.appendChild(label);
    });

    // Parameters
    const paramKeys = Object.keys(n.params);
    if (paramKeys.length > 0) {
      const maxPorts = Math.max(n.inputs.length, n.outputs.length, 1);
      const paramStartY = n._y + MOD_NAME_H + maxPorts * PORT_H + PORT_PAD * 2 + 4;
      // Separator
      const sep2 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      sep2.setAttribute('x1', n._x);
      sep2.setAttribute('y1', paramStartY - 4);
      sep2.setAttribute('x2', n._x + n._w);
      sep2.setAttribute('y2', paramStartY - 4);
      sep2.setAttribute('stroke', '#444');
      sep2.setAttribute('stroke-width', '1');
      g.appendChild(sep2);

      paramKeys.forEach((pk, pi) => {
        const pt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        pt.setAttribute('x', n._x + n._w / 2);
        pt.setAttribute('y', paramStartY + pi * PARAM_LINE_H + 10);
        pt.setAttribute('class', 'param-text');
        pt.textContent = pk + ' = ' + n.params[pk];
        g.appendChild(pt);
      });
    }

    root.appendChild(g);
  });

  // Legend
  const legendTypes = [
    { name: 'Audio', cls: 'audio' },
    { name: 'CV', cls: 'cv' },
    { name: 'Pitch', cls: 'pitch' },
    { name: 'Gate', cls: 'gate' },
    { name: 'Trigger', cls: 'trigger' },
    { name: 'Clock', cls: 'clock' },
  ];
  const lx = 20, ly = maxH + 40;
  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bg.setAttribute('x', lx);
  bg.setAttribute('y', ly);
  bg.setAttribute('width', 360);
  bg.setAttribute('height', 30);
  bg.setAttribute('class', 'legend');
  root.appendChild(bg);
  legendTypes.forEach((lt, i) => {
    const ex = lx + 10 + i * 58;
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', ex);
    line.setAttribute('y1', ly + 15);
    line.setAttribute('x2', ex + 16);
    line.setAttribute('y2', ly + 15);
    line.setAttribute('class', 'edge legend-line ' + lt.cls);
    root.appendChild(line);
    const txt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    txt.setAttribute('x', ex + 20);
    txt.setAttribute('y', ly + 19);
    txt.setAttribute('class', 'legend-text');
    txt.textContent = lt.name;
    root.appendChild(txt);
  });

  applyTransform();
}

function applyTransform() {
  root.setAttribute('transform', 'translate('+tx+','+ty+') scale('+scale+')');
}
function zoomIn() { scale *= 1.2; applyTransform(); }
function zoomOut() { scale /= 1.2; applyTransform(); }
function resetView() { scale = 1; tx = 0; ty = 0; applyTransform(); }

// Pan with mouse drag
let dragging = false, lastX = 0, lastY = 0;
svg.addEventListener('pointerdown', e => { dragging = true; lastX = e.clientX; lastY = e.clientY; });
svg.addEventListener('pointermove', e => {
  if (!dragging) return;
  tx += e.clientX - lastX;
  ty += e.clientY - lastY;
  lastX = e.clientX;
  lastY = e.clientY;
  applyTransform();
});
svg.addEventListener('pointerup', () => dragging = false);
svg.addEventListener('pointerleave', () => dragging = false);

// Zoom with wheel
svg.addEventListener('wheel', e => {
  e.preventDefault();
  const factor = e.deltaY > 0 ? 0.9 : 1.1;
  scale *= factor;
  applyTransform();
}, { passive: false });

renderAll();
</script>
</body>
</html>`;
  }

  /** Convert PatchbookData to a flat graph structure for the webview */
  private toGraphData(data: PatchbookData): {
    nodes: {
      id: string;
      name: string;
      inputs: string[];
      outputs: string[];
      params: Record<string, string>;
    }[];
    edges: {
      from: string;
      to: string;
      fromPort: string;
      toPort: string;
      type: string;
    }[];
  } {
    const nodes = Object.keys(data.modules).map((key) => {
      const mod = data.modules[key];
      return {
        id: key,
        name: key,
        inputs: Object.keys(mod.connections.in).sort(),
        outputs: Object.keys(mod.connections.out).sort(),
        params: { ...mod.parameters },
      };
    });

    const edges: {
      from: string;
      to: string;
      fromPort: string;
      toPort: string;
      type: string;
    }[] = [];
    const seen = new Set<number>();
    for (const key of Object.keys(data.modules)) {
      const mod = data.modules[key];
      for (const port of Object.keys(mod.connections.out)) {
        for (const conn of mod.connections.out[port]) {
          if (!seen.has(conn.id)) {
            seen.add(conn.id);
            edges.push({
              from: key,
              to: conn.input_module,
              fromPort: port,
              toPort: conn.input_port,
              type: conn.connection_type,
            });
          }
        }
      }
    }

    return { nodes, edges };
  }
}
