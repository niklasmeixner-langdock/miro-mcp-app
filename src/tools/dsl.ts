export interface LayoutItem {
  alias: string;
  type: "frame" | "sticky_note" | "shape" | "text" | "card";
  text: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  parent?: string;
  fill?: string;
  shape?: string;
}

export interface DiagramEdge {
  from: string;
  to: string;
  label?: string;
}

export const LAYOUT_DSL_SPEC = `Miro Layout DSL v1
One item per line:
  <alias>:<type> text="..." x=<number> y=<number> width=<number> height=<number> parent=<alias-or-id> fill=<hex> shape=<shape>
Types: frame, sticky_note, shape, text, card.
Example:
  retro:frame text="Sprint Retro" x=0 y=0 width=1200 height=700
  good:sticky_note text="What went well?" x=-300 y=0 parent=retro fill=#fff9b1
Comments begin with #. Aliases are local to one call.`;

export const DIAGRAM_DSL_SPEC = `Miro Diagram DSL v1
Nodes:
  node <alias> "<label>" shape=<rectangle|round_rectangle|circle|diamond|cylinder> fill=<hex>
Edges:
  <alias> -> <alias> "optional label"
Optional first line: direction TB|LR
JSON input is also accepted: {"nodes":[{"id":"a","label":"Start","shape":"circle"}],"edges":[{"from":"a","to":"b"}],"direction":"TB"}.
Supported use cases include flowcharts, mind maps, UML-style class/sequence layouts, and ER diagrams.`;

function tokens(line: string): string[] {
  return line.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((part) =>
    part.startsWith('"') && part.endsWith('"') ? part.slice(1, -1) : part,
  ) ?? [];
}

function properties(parts: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of parts) {
    const index = part.indexOf("=");
    if (index > 0) {
      result[part.slice(0, index)] = part.slice(index + 1).replace(/^"|"$/g, "");
    }
  }
  return result;
}

function finite(value?: string): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

export function parseLayoutDsl(input: string): LayoutItem[] {
  const trimmed = input.trim();
  if (trimmed.startsWith("[")) {
    return JSON.parse(trimmed) as LayoutItem[];
  }
  const result: LayoutItem[] = [];
  for (const raw of trimmed.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const header = line.match(/^([A-Za-z0-9_-]+):([A-Za-z_]+)\s*(.*)$/);
    const alias = header?.[1];
    const type = header?.[2];
    if (
      !alias ||
      !type ||
      !["frame", "sticky_note", "shape", "text", "card"].includes(type)
    ) {
      throw new Error(`Invalid layout line: ${line}`);
    }
    const remainder = header?.[3] ?? "";
    const props: Record<string, string> = {};
    const propertyPattern = /([A-Za-z_][A-Za-z0-9_]*)=("(?:[^"\\]|\\.)*"|[^\s]+)/g;
    let match: RegExpExecArray | null;
    const propertyRanges: Array<[number, number]> = [];
    while ((match = propertyPattern.exec(remainder))) {
      const rawValue = match[2];
      props[match[1]] = rawValue.startsWith('"')
        ? JSON.parse(rawValue)
        : rawValue;
      propertyRanges.push([match.index, propertyPattern.lastIndex]);
    }
    let freeText = remainder;
    for (const [start, end] of propertyRanges.reverse()) {
      freeText = `${freeText.slice(0, start)} ${freeText.slice(end)}`;
    }
    freeText = freeText.trim().replace(/^"|"$/g, "");
    result.push({
      alias,
      type: type as LayoutItem["type"],
      text: props.text ?? (freeText || alias),
      x: finite(props.x),
      y: finite(props.y),
      width: finite(props.width),
      height: finite(props.height),
      parent: props.parent,
      fill: props.fill,
      shape: props.shape,
    });
  }
  if (result.length === 0) throw new Error("The layout DSL contains no items.");
  return result;
}

export function parseDiagramDsl(input: string): {
  nodes: LayoutItem[];
  edges: DiagramEdge[];
  direction: "TB" | "LR";
} {
  const trimmed = input.trim();
  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed) as {
      nodes?: Array<Record<string, unknown>>;
      edges?: Array<Record<string, unknown>>;
      direction?: string;
    };
    const direction = parsed.direction === "LR" ? "LR" : "TB";
    return {
      nodes: (parsed.nodes ?? []).map((node, index) => ({
        alias: String(node.id ?? `node${index + 1}`),
        type: "shape",
        text: String(node.label ?? node.id ?? `Node ${index + 1}`),
        shape: String(node.shape ?? "round_rectangle"),
        fill: typeof node.fill === "string" ? node.fill : undefined,
      })),
      edges: (parsed.edges ?? []).map((edge) => ({
        from: String(edge.from ?? edge.source),
        to: String(edge.to ?? edge.target),
        label: typeof edge.label === "string" ? edge.label : undefined,
      })),
      direction,
    };
  }

  let direction: "TB" | "LR" = "TB";
  const nodes: LayoutItem[] = [];
  const edges: DiagramEdge[] = [];
  for (const raw of trimmed.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (/^direction\s+/i.test(line)) {
      direction = /\bLR\b/i.test(line) ? "LR" : "TB";
      continue;
    }
    const edge = line.match(/^([A-Za-z0-9_-]+)\s*--?>\s*([A-Za-z0-9_-]+)(?:\s+"([^"]*)")?$/);
    if (edge) {
      edges.push({ from: edge[1], to: edge[2], label: edge[3] });
      continue;
    }
    const parts = tokens(line);
    if (parts[0] !== "node" || !parts[1]) throw new Error(`Invalid diagram line: ${line}`);
    const props = properties(parts.slice(2));
    const label = parts.slice(2).find((part) => !part.includes("=")) ?? parts[1];
    nodes.push({
      alias: parts[1],
      type: "shape",
      text: label,
      shape: props.shape ?? "round_rectangle",
      fill: props.fill,
    });
  }
  if (nodes.length === 0) throw new Error("The diagram contains no nodes.");
  return { nodes, edges, direction };
}

export function positionDiagram(
  nodes: LayoutItem[],
  direction: "TB" | "LR",
): LayoutItem[] {
  const perRow = Math.max(1, Math.ceil(Math.sqrt(nodes.length)));
  return nodes.map((node, index) => {
    const row = Math.floor(index / perRow);
    const column = index % perRow;
    return {
      ...node,
      x: direction === "LR" ? row * 260 : column * 260,
      y: direction === "LR" ? column * 160 : row * 160,
      width: 180,
      height: 80,
    };
  });
}

export function stripHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

export function serializeItems(items: unknown[]): string {
  return items
    .map((item, index) => {
      const value = item as Record<string, any>;
      const data = value.data ?? {};
      const position = value.position ?? {};
      const geometry = value.geometry ?? {};
      const text = stripHtml(data.content ?? data.title ?? data.text ?? value.type);
      return [
        `item${index + 1}:${value.type ?? "text"}`,
        `id=${value.id}`,
        `text=${JSON.stringify(text)}`,
        position.x !== undefined ? `x=${position.x}` : "",
        position.y !== undefined ? `y=${position.y}` : "",
        geometry.width !== undefined ? `width=${geometry.width}` : "",
        geometry.height !== undefined ? `height=${geometry.height}` : "",
        value.parent?.id ? `parent=${value.parent.id}` : "",
      ]
        .filter(Boolean)
        .join(" ");
    })
    .join("\n");
}
