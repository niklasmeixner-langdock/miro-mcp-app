import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Config } from "../config.js";
import {
  MiroApiError,
  MiroClient,
  boardUrl,
  parseBoardReference,
} from "../miro/client.js";
import type { ArtifactStore } from "./artifacts.js";
import {
  DIAGRAM_DSL_SPEC,
  LAYOUT_DSL_SPEC,
  parseDiagramDsl,
  parseLayoutDsl,
  positionDiagram,
  serializeItems,
  stripHtml,
  type LayoutItem,
} from "./dsl.js";
import type { UploadStore } from "./uploads.js";

export const MIRO_APP_RESOURCE_URI = "ui://miro/workspace";

type ToolArgs = Record<string, any>;
type Handler = (args: ToolArgs) => Promise<Record<string, any>>;

interface Dependencies {
  config: Config;
  client: MiroClient;
  artifacts: ArtifactStore;
  uploads: UploadStore;
}

const boardReference = z
  .string()
  .min(1)
  .describe("Full Miro board URL or board ID. Item-focused URLs are supported.");

function success(
  text: string,
  data: Record<string, unknown>,
  parity: "native" | "emulated" = "native",
  warnings: string[] = [],
): Record<string, any> {
  const structuredContent = { ...data, parity, warnings };
  return {
    content: [{ type: "text", text }, { type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
    _meta: { "mcpui.dev/ui-initial-render-data": structuredContent },
  };
}

function unavailable(tool: string, board?: string): Record<string, any> {
  return success(
    `${tool} is not available through Miro's public API.`,
    {
      capability: tool,
      code: "CAPABILITY_UNAVAILABLE",
      boardUrl: board,
      message:
        "The tool is retained for compatibility, but Miro does not expose this operation in its public REST API.",
    },
    "emulated",
    ["No undocumented or private Miro endpoint was called."],
  );
}

function failure(error: unknown): Record<string, any> {
  const details =
    error instanceof MiroApiError
      ? { status: error.status, details: error.details }
      : undefined;
  return {
    content: [
      {
        type: "text",
        text: error instanceof Error ? error.message : String(error),
      },
    ],
    structuredContent: { code: "TOOL_ERROR", ...details },
    isError: true,
  };
}

function register(
  server: McpServer,
  name: string,
  title: string,
  description: string,
  inputSchema: Record<string, z.ZodType>,
  handler: Handler,
  ui = false,
  readOnly = false,
): void {
  const options = {
    title,
    description,
    inputSchema,
    annotations: { readOnlyHint: readOnly },
  };
  const wrapped = async (args: ToolArgs) => {
    try {
      return await handler(args);
    } catch (error) {
      return failure(error);
    }
  };
  void ui;
  (server.registerTool as any)(name, options, wrapped);
}

function itemEndpoint(type: string): string {
  const endpoints: Record<string, string> = {
    frame: "frames",
    sticky_note: "sticky_notes",
    shape: "shapes",
    text: "texts",
    card: "cards",
  };
  const endpoint = endpoints[type];
  if (!endpoint) throw new Error(`Unsupported layout item type: ${type}`);
  return endpoint;
}

function itemPayload(item: LayoutItem, parentId?: string): Record<string, unknown> {
  const payload: Record<string, any> = {
    position: { x: item.x ?? 0, y: item.y ?? 0, origin: "center" },
  };
  if (parentId) payload.parent = { id: parentId };
  if (item.width || item.height) {
    payload.geometry = {
      ...(item.width ? { width: item.width } : {}),
      ...(item.height ? { height: item.height } : {}),
    };
  }
  switch (item.type) {
    case "frame":
      payload.data = { title: item.text };
      break;
    case "card":
      payload.data = { title: item.text };
      break;
    case "shape":
      payload.data = {
        content: item.text,
        shape: item.shape ?? "round_rectangle",
      };
      break;
    default:
      payload.data = { content: item.text };
  }
  if (item.fill) payload.style = { fillColor: item.fill };
  return payload;
}

async function createLayoutItems(
  client: MiroClient,
  boardId: string,
  items: LayoutItem[],
): Promise<Array<Record<string, any>>> {
  const aliases = new Map<string, string>();
  const created: Array<Record<string, any>> = [];
  const pending = [...items];
  while (pending.length > 0) {
    const index = pending.findIndex(
      (item) => !item.parent || aliases.has(item.parent) || /^\d+$/.test(item.parent),
    );
    if (index < 0) {
      throw new Error("Layout contains an unresolved or cyclic parent alias.");
    }
    const [item] = pending.splice(index, 1);
    const parentId = item.parent ? aliases.get(item.parent) ?? item.parent : undefined;
    const response = await client.request<Record<string, any>>(
      `/v2/boards/${encodeURIComponent(boardId)}/${itemEndpoint(item.type)}`,
      { method: "POST", body: itemPayload(item, parentId) },
    );
    aliases.set(item.alias, String(response.id));
    created.push({ alias: item.alias, ...response });
  }
  return created;
}

function textFromItem(item: Record<string, any>): string {
  return stripHtml(
    item.data?.content ??
      item.data?.title ??
      item.data?.description ??
      item.data?.text ??
      "",
  );
}

async function readImageWithLimit(
  response: Response,
  maximumBytes: number,
): Promise<{ bytes?: Buffer; truncated: boolean }> {
  if (!response.ok) {
    throw new Error(`Image download failed (${response.status}).`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("image/")) {
    throw new Error(`Unexpected image content type: ${contentType || "unknown"}.`);
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body?.cancel();
    return { truncated: true };
  }
  if (!response.body) return { bytes: Buffer.alloc(0), truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      return { truncated: true };
    }
    chunks.push(value);
  }
  return {
    bytes: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),
    truncated: false,
  };
}

export function registerMiroTools(
  server: McpServer,
  { config, client, artifacts, uploads }: Dependencies,
): void {
  register(
    server,
    "board_create",
    "Create New Board",
    "Create a new Miro board. Confirm the intended board name with the user first.",
    {
      name: z.string().min(1),
      description: z.string().optional(),
      team_id: z.string().optional(),
    },
    async ({ name, description, team_id }) => {
      const board = await client.request<Record<string, any>>("/v2/boards", {
        method: "POST",
        body: {
          name,
          description,
          teamId: team_id ?? client.credential.teamId,
        },
      });
      return success(`Created Miro board “${name}”.`, {
        board,
        boardUrl: board.viewLink ?? boardUrl(String(board.id)),
      });
    },
    true,
  );

  register(
    server,
    "board_search_boards",
    "Search Boards",
    "Search and list boards accessible to the current user.",
    {
      query: z.string().optional(),
      limit: z.number().int().min(1).max(50).default(20),
      offset: z.number().int().min(0).default(0),
    },
    async ({ query, limit, offset }) => {
      const page = await client.request<Record<string, any>>("/v2/boards", {
        query: {
          query,
          limit,
          offset,
          team_id: client.credential.teamId,
        },
      });
      const boards = page.data ?? [];
      return success(`Found ${(page.data ?? []).length} Miro boards.`, {
        boards,
        nextOffset: boards.length === limit ? offset + boards.length : undefined,
      });
    },
    true,
    true,
  );

  register(
    server,
    "board_list_items",
    "Read Board Items",
    "List board items with cursor pagination and optional type or parent filtering.",
    {
      board_url: boardReference,
      type: z.string().optional(),
      parent_item_id: z.string().optional(),
      limit: z.number().int().min(1).max(50).default(50),
      cursor: z.string().optional(),
    },
    async ({ board_url, type, parent_item_id, limit, cursor }) => {
      const { boardId, itemId } = parseBoardReference(board_url);
      const page = await client.request<Record<string, any>>(
        `/v2/boards/${encodeURIComponent(boardId)}/items`,
        {
          query: {
            type,
            parent_item_id: parent_item_id ?? itemId,
            limit,
            cursor,
          },
        },
      );
      return success(`Read ${(page.data ?? []).length} board items.`, {
        boardId,
        boardUrl: boardUrl(boardId),
        items: page.data ?? [],
        cursor: page.cursor,
      });
    },
    true,
    true,
  );

  register(
    server,
    "context_explore",
    "Find Formats",
    "Explore high-level frames, documents, diagrams, app tables, and prototypes.",
    { board_url: boardReference, limit: z.number().int().min(1).max(200).default(100) },
    async ({ board_url, limit }) => {
      const { boardId } = parseBoardReference(board_url);
      const items = (await client.getAllItems(boardId, { limit })) as Array<
        Record<string, any>
      >;
      const highLevel = items.filter((item) =>
        ["frame", "document", "embed", "mindmap_node"].includes(item.type),
      );
      const owned = artifacts.list(client.credential.teamId, boardId);
      return success(`Found ${highLevel.length + owned.length} high-level artifacts.`, {
        boardId,
        boardUrl: boardUrl(boardId),
        items: highLevel,
        appArtifacts: owned,
      });
    },
    true,
    true,
  );

  register(
    server,
    "context_get",
    "Summarize Board",
    "Return normalized textual context from a board or focused item for the host model to summarize.",
    {
      board_url: boardReference,
      limit: z.number().int().min(1).max(500).default(200),
    },
    async ({ board_url, limit }) => {
      const { boardId, itemId } = parseBoardReference(board_url);
      const items = itemId
        ? [
            await client.request<Record<string, any>>(
              `/v2/boards/${encodeURIComponent(boardId)}/items/${encodeURIComponent(itemId)}`,
            ),
          ]
        : ((await client.getAllItems(boardId, { limit })) as Array<
            Record<string, any>
          >);
      const context = items
        .map((item) => `[${item.type}:${item.id}] ${textFromItem(item)}`)
        .filter((line) => !line.endsWith("] "))
        .join("\n");
      return success(
        context || "No textual context found.",
        { boardId, itemId, context, itemCount: items.length, boardUrl: boardUrl(boardId, itemId) },
        "emulated",
        ["Context is extracted deterministically; the host model performs summarization."],
      );
    },
    true,
    true,
  );

  register(
    server,
    "layout_get_dsl",
    "Board Layout",
    "Get the DSL format specification for creating board layouts.",
    {},
    async () => success(LAYOUT_DSL_SPEC, { dsl: LAYOUT_DSL_SPEC, version: "1" }),
    false,
    true,
  );

  register(
    server,
    "layout_read",
    "Item Positioning",
    "Read existing board items and return them as layout DSL text.",
    {
      board_url: boardReference,
      type: z.string().optional(),
      parent_item_id: z.string().optional(),
      limit: z.number().int().min(1).max(500).default(200),
    },
    async ({ board_url, type, parent_item_id, limit }) => {
      const { boardId, itemId } = parseBoardReference(board_url);
      const items = await client.getAllItems(boardId, {
        type,
        parentItemId: parent_item_id ?? itemId,
        limit,
      });
      const dsl = serializeItems(items);
      return success(dsl, { boardId, dsl, itemCount: items.length });
    },
    true,
    true,
  );

  register(
    server,
    "layout_create",
    "Create Widgets",
    "Create multiple board items from Miro Layout DSL.",
    { board_url: boardReference, dsl: z.string().min(1) },
    async ({ board_url, dsl }) => {
      const { boardId } = parseBoardReference(board_url);
      const items = parseLayoutDsl(dsl);
      const created = await createLayoutItems(client, boardId, items);
      return success(`Created ${created.length} board items.`, {
        boardId,
        boardUrl: boardUrl(boardId),
        items: created,
      });
    },
    true,
  );

  register(
    server,
    "layout_update",
    "Update Widgets",
    "Update matching textual board items using find-and-replace.",
    {
      board_url: boardReference,
      find: z.string().min(1),
      replace: z.string(),
      replace_all: z.boolean().default(false),
    },
    async ({ board_url, find, replace, replace_all }) => {
      const { boardId, itemId } = parseBoardReference(board_url);
      const items = itemId
        ? [
            await client.request<Record<string, any>>(
              `/v2/boards/${encodeURIComponent(boardId)}/items/${encodeURIComponent(itemId)}`,
            ),
          ]
        : ((await client.getAllItems(boardId, { limit: 500 })) as Array<
            Record<string, any>
          >);
      const updated: string[] = [];
      for (const item of items) {
        const current = textFromItem(item);
        if (!current.includes(find)) continue;
        if (!["frame", "sticky_note", "shape", "text", "card"].includes(item.type)) {
          continue;
        }
        const next = replace_all ? current.split(find).join(replace) : current.replace(find, replace);
        const endpoint = itemEndpoint(item.type);
        const key = item.type === "frame" || item.type === "card" ? "title" : "content";
        await client.request(
          `/v2/boards/${encodeURIComponent(boardId)}/${endpoint}/${encodeURIComponent(item.id)}`,
          { method: "PATCH", body: { data: { [key]: next } } },
        );
        updated.push(String(item.id));
        if (!replace_all) break;
      }
      return success(`Updated ${updated.length} board items.`, { boardId, updatedItemIds: updated });
    },
    true,
  );

  register(
    server,
    "diagram_get_dsl",
    "Diagram Layout",
    "Get the DSL format specification for creating diagrams.",
    {},
    async () => success(DIAGRAM_DSL_SPEC, { dsl: DIAGRAM_DSL_SPEC, version: "1" }),
    false,
    true,
  );

  register(
    server,
    "diagram_create",
    "Create Diagram",
    "Create a Miro diagram from diagram DSL or its JSON form.",
    { board_url: boardReference, dsl: z.string().min(1) },
    async ({ board_url, dsl }) => {
      const { boardId } = parseBoardReference(board_url);
      const diagram = parseDiagramDsl(dsl);
      const nodes = await createLayoutItems(
        client,
        boardId,
        positionDiagram(diagram.nodes, diagram.direction),
      );
      const aliases = new Map(nodes.map((node) => [node.alias, String(node.id)]));
      const connectors: unknown[] = [];
      for (const edge of diagram.edges) {
        const startItem = aliases.get(edge.from);
        const endItem = aliases.get(edge.to);
        if (!startItem || !endItem) throw new Error(`Unknown connector alias: ${edge.from} -> ${edge.to}`);
        connectors.push(
          await client.request(
            `/v2/boards/${encodeURIComponent(boardId)}/connectors`,
            {
              method: "POST",
              body: {
                startItem: { id: startItem },
                endItem: { id: endItem },
                captions: edge.label ? [{ content: edge.label, position: "50%" }] : [],
                shape: "elbowed",
              },
            },
          ),
        );
      }
      return success(`Created a diagram with ${nodes.length} nodes and ${connectors.length} connectors.`, {
        boardId,
        boardUrl: boardUrl(boardId),
        nodes,
        connectors,
      });
    },
    true,
  );

  register(
    server,
    "image_get_upload_url",
    "Get Upload URL",
    "Get a temporary, single-use upload URL valid for five minutes.",
    {},
    async () => {
      const upload = uploads.issue();
      return success("Created a five-minute single-use image upload URL.", {
        uploadToken: upload.token,
        uploadUrl: `${config.baseUrl}/uploads/${upload.token}`,
        method: "POST",
        contentType: "application/octet-stream",
        expiresAt: upload.expiresAt,
      });
    },
  );

  register(
    server,
    "image_create",
    "Upload Image",
    "Create an image item from a public URL or a token returned by image_get_upload_url.",
    {
      board_url: boardReference,
      url: z.string().url().optional(),
      upload_token: z.string().optional(),
      title: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      width: z.number().positive().optional(),
      parent_item_id: z.string().optional(),
    },
    async ({ board_url, url, upload_token, title, x, y, width, parent_item_id }) => {
      if (!url && !upload_token) throw new Error("Provide url or upload_token.");
      const { boardId } = parseBoardReference(board_url);
      let image: Record<string, any>;
      if (upload_token) {
        const upload = uploads.take(upload_token);
        if (!upload?.content) throw new Error("Upload token is missing, expired, or already used.");
        const form = new FormData();
        form.append(
          "resource",
          new Blob([new Uint8Array(upload.content)], {
            type: upload.contentType ?? "application/octet-stream",
          }),
          upload.filename ?? "image",
        );
        form.append(
          "data",
          JSON.stringify({
            title,
            position: { x: x ?? 0, y: y ?? 0 },
            geometry: width ? { width } : undefined,
            parent: parent_item_id ? { id: parent_item_id } : undefined,
          }),
        );
        image = await client.request<Record<string, any>>(
          `/v2/boards/${encodeURIComponent(boardId)}/images`,
          {
            method: "POST",
            body: form,
            headers: {},
          },
        );
      } else {
        image = await client.request<Record<string, any>>(
          `/v2/boards/${encodeURIComponent(boardId)}/images`,
          {
            method: "POST",
            body: {
              data: { url, title },
              position: { x: x ?? 0, y: y ?? 0 },
              geometry: width ? { width } : undefined,
              parent: parent_item_id ? { id: parent_item_id } : undefined,
            },
          },
        );
      }
      return success("Created an image on the board.", {
        boardId,
        image,
        boardUrl: boardUrl(boardId, String(image.id)),
      });
    },
    true,
  );

  const imageSchema = {
    board_url: boardReference,
    item_id: z.string().optional(),
  };
  register(
    server,
    "image_get_url",
    "Download Image",
    "Get the temporary Miro download URL for an image item.",
    imageSchema,
    async ({ board_url, item_id }) => {
      const reference = parseBoardReference(board_url);
      const id = item_id ?? reference.itemId;
      if (!id) throw new Error("An image item ID or focused board URL is required.");
      const image = await client.request<Record<string, any>>(
        `/v2/boards/${encodeURIComponent(reference.boardId)}/images/${encodeURIComponent(id)}`,
      );
      return success("Retrieved the image download URL.", {
        boardId: reference.boardId,
        itemId: id,
        imageUrl: image.data?.imageUrl ?? image.imageUrl,
        image,
      });
    },
    true,
    true,
  );
  register(
    server,
    "image_get_data",
    "Image Metadata",
    "Get image metadata and base64 data for an image item.",
    imageSchema,
    async ({ board_url, item_id }) => {
      const reference = parseBoardReference(board_url);
      const id = item_id ?? reference.itemId;
      if (!id) throw new Error("An image item ID or focused board URL is required.");
      const image = await client.request<Record<string, any>>(
        `/v2/boards/${encodeURIComponent(reference.boardId)}/images/${encodeURIComponent(id)}`,
      );
      const url = image.data?.imageUrl ?? image.imageUrl;
      let base64: string | undefined;
      let contentType: string | undefined;
      let truncated = false;
      if (url) {
        const response = await fetch(url);
        const download = await readImageWithLimit(response, 5 * 1024 * 1024);
        truncated = download.truncated;
        if (download.bytes) {
          base64 = download.bytes.toString("base64");
          contentType = response.headers.get("content-type") ?? undefined;
        }
      }
      return success("Retrieved image metadata and data.", {
        boardId: reference.boardId,
        itemId: id,
        image,
        base64,
        contentType,
        truncated,
      });
    },
    false,
    true,
  );

  registerDocumentTools(server, client, artifacts);
  registerTableTools(server, client, artifacts);
  registerCodeWidgetTools(server, client);
  registerCommentTools(server);
  registerPrototypeTools(server, client, artifacts);
}

function registerDocumentTools(
  server: McpServer,
  client: MiroClient,
  artifacts: ArtifactStore,
): void {
  register(
    server,
    "doc_create",
    "Create Document",
    "Create an app-managed structured Markdown document on a Miro board.",
    {
      board_url: boardReference,
      title: z.string().min(1),
      markdown: z.string(),
      x: z.number().optional(),
      y: z.number().optional(),
      parent_item_id: z.string().optional(),
    },
    async ({ board_url, title, markdown, x, y, parent_item_id }) => {
      const { boardId } = parseBoardReference(board_url);
      const created = await createLayoutItems(client, boardId, [
        {
          alias: "document",
          type: "text",
          text: `${title}\n\n${markdown}`,
          x,
          y,
          width: 600,
          parent: parent_item_id,
        },
      ]);
      const artifact = artifacts.create({
        kind: "document",
        teamId: client.credential.teamId,
        boardId,
        itemId: String(created[0].id),
        title,
        data: { markdown },
      });
      return success(
        `Created app-managed document “${title}”.`,
        { artifact, boardUrl: boardUrl(boardId, artifact.itemId) },
        "emulated",
        ["The public API cannot create native Miro Docs; this is an editable text composition."],
      );
    },
    true,
  );
  register(
    server,
    "doc_get",
    "Read Documents",
    "Read an app-managed document or public document item metadata.",
    {
      board_url: boardReference.optional(),
      artifact_id: z.string().optional(),
      item_id: z.string().optional(),
    },
    async ({ board_url, artifact_id, item_id }) => {
      let artifact = artifact_id
        ? artifacts.get(artifact_id, client.credential.teamId)
        : undefined;
      const reference = board_url ? parseBoardReference(board_url) : undefined;
      const id = item_id ?? reference?.itemId;
      if (!artifact && id) artifact = artifacts.findByItem(id, client.credential.teamId);
      if (artifact) {
        return success("Read app-managed document.", { artifact }, "emulated");
      }
      if (!reference || !id) throw new Error("Provide artifact_id or board_url with an item ID.");
      const document = await client.request(
        `/v2/boards/${encodeURIComponent(reference.boardId)}/documents/${encodeURIComponent(id)}`,
      );
      return success("Read document metadata.", { document });
    },
    true,
    true,
  );
  register(
    server,
    "doc_update",
    "Update Document",
    "Update an app-managed document with find-and-replace.",
    {
      artifact_id: z.string(),
      find: z.string().min(1),
      replace: z.string(),
      replace_all: z.boolean().default(false),
    },
    async ({ artifact_id, find, replace, replace_all }) => {
      const artifact = artifacts.get(artifact_id, client.credential.teamId);
      if (!artifact || artifact.kind !== "document" || !artifact.itemId) {
        throw new Error("Only documents created by this app can be updated.");
      }
      const current = String(artifact.data.markdown ?? "");
      const markdown = replace_all ? current.split(find).join(replace) : current.replace(find, replace);
      await client.request(
        `/v2/boards/${encodeURIComponent(artifact.boardId)}/texts/${encodeURIComponent(artifact.itemId)}`,
        {
          method: "PATCH",
          body: { data: { content: `${artifact.title}\n\n${markdown}` } },
        },
      );
      const updated = artifacts.update(artifact.id, client.credential.teamId, () => ({ markdown }));
      return success("Updated app-managed document.", { artifact: updated }, "emulated");
    },
    true,
  );
}

function registerTableTools(
  server: McpServer,
  client: MiroClient,
  artifacts: ArtifactStore,
): void {
  register(
    server,
    "table_create",
    "Create Table",
    "Create an app-managed visual table with typed column metadata.",
    {
      board_url: boardReference,
      title: z.string(),
      columns: z.array(
        z.object({
          name: z.string(),
          type: z.enum(["text", "select"]).default("text"),
          options: z.array(z.string()).optional(),
        }),
      ),
      rows: z.array(z.record(z.string(), z.unknown())).default([]),
      x: z.number().optional(),
      y: z.number().optional(),
    },
    async ({ board_url, title, columns, rows, x, y }) => {
      const { boardId } = parseBoardReference(board_url);
      const lines = [
        columns.map((column: any) => column.name).join(" | "),
        ...rows.map((row: Record<string, unknown>) =>
          columns.map((column: any) => String(row[column.name] ?? "")).join(" | "),
        ),
      ];
      const created = await createLayoutItems(client, boardId, [
        {
          alias: "table",
          type: "text",
          text: `${title}\n${lines.join("\n")}`,
          x,
          y,
          width: Math.max(500, columns.length * 180),
        },
      ]);
      const artifact = artifacts.create({
        kind: "table",
        teamId: client.credential.teamId,
        boardId,
        itemId: String(created[0].id),
        title,
        data: { columns, rows },
      });
      return success(
        `Created app-managed table “${title}”.`,
        { artifact, boardUrl: boardUrl(boardId, artifact.itemId) },
        "emulated",
        ["Miro's public API does not expose native table CRUD."],
      );
    },
    true,
  );
  register(
    server,
    "table_list_rows",
    "Read Table",
    "Read rows and columns from an app-managed table.",
    {
      artifact_id: z.string(),
      filter_column: z.string().optional(),
      filter_value: z.string().optional(),
      limit: z.number().int().min(1).max(500).default(100),
      cursor: z.number().int().min(0).default(0),
    },
    async ({ artifact_id, filter_column, filter_value, limit, cursor }) => {
      const artifact = artifacts.get(artifact_id, client.credential.teamId);
      if (!artifact || artifact.kind !== "table") throw new Error("App-managed table not found.");
      let rows = (artifact.data.rows ?? []) as Array<Record<string, unknown>>;
      if (filter_column) {
        rows = rows.filter((row) => String(row[filter_column] ?? "") === String(filter_value ?? ""));
      }
      return success(
        "Read app-managed table rows.",
        {
          artifactId: artifact.id,
          columns: artifact.data.columns,
          rows: rows.slice(cursor, cursor + limit),
          cursor: cursor + limit < rows.length ? cursor + limit : undefined,
        },
        "emulated",
      );
    },
    true,
    true,
  );
  register(
    server,
    "table_sync_rows",
    "Update Table",
    "Upsert rows into an app-managed table using a key column.",
    {
      artifact_id: z.string(),
      key_column: z.string(),
      rows: z.array(z.record(z.string(), z.unknown())),
    },
    async ({ artifact_id, key_column, rows }) => {
      const artifact = artifacts.get(artifact_id, client.credential.teamId);
      if (!artifact || artifact.kind !== "table" || !artifact.itemId) {
        throw new Error("App-managed table not found.");
      }
      const current = [...((artifact.data.rows ?? []) as Array<Record<string, unknown>>)];
      for (const row of rows as Array<Record<string, unknown>>) {
        const index = current.findIndex(
          (candidate) => String(candidate[key_column]) === String(row[key_column]),
        );
        if (index >= 0) current[index] = { ...current[index], ...row };
        else current.push(row);
      }
      const columns = artifact.data.columns as Array<{ name: string }>;
      const text = `${artifact.title}\n${columns.map((column) => column.name).join(" | ")}\n${current
        .map((row) => columns.map((column) => String(row[column.name] ?? "")).join(" | "))
        .join("\n")}`;
      await client.request(
        `/v2/boards/${encodeURIComponent(artifact.boardId)}/texts/${encodeURIComponent(artifact.itemId)}`,
        { method: "PATCH", body: { data: { content: text } } },
      );
      const updated = artifacts.update(artifact.id, client.credential.teamId, () => ({
        columns,
        rows: current,
      }));
      return success("Synchronized app-managed table rows.", { artifact: updated }, "emulated");
    },
    true,
  );
}

function registerCodeWidgetTools(server: McpServer, client: MiroClient): void {
  const baseSchema = { board_url: boardReference };
  register(
    server,
    "code_widget_create",
    "Create Code Widget",
    "Create an experimental Miro code widget.",
    {
      ...baseSchema,
      code: z.string().max(6000),
      language: z.string().default("plaintext"),
      title: z.string().optional(),
      line_numbers_visible: z.boolean().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
    },
    async ({ board_url, code, language, title, line_numbers_visible, x, y }) => {
      const { boardId } = parseBoardReference(board_url);
      const widget = await client.request(
        `/v2-experimental/boards/${encodeURIComponent(boardId)}/code_widgets`,
        {
          method: "POST",
          body: {
            data: { code, language, title, lineNumbersVisible: line_numbers_visible },
            position: { x: x ?? 0, y: y ?? 0 },
          },
        },
      );
      return success("Created code widget.", { boardId, widget });
    },
    true,
  );
  register(
    server,
    "code_widget_get",
    "Read Code Widget",
    "Read one experimental Miro code widget.",
    { ...baseSchema, item_id: z.string() },
    async ({ board_url, item_id }) => {
      const { boardId } = parseBoardReference(board_url);
      const widget = await client.request(
        `/v2-experimental/boards/${encodeURIComponent(boardId)}/code_widgets/${encodeURIComponent(item_id)}`,
      );
      return success("Read code widget.", { boardId, widget });
    },
    false,
    true,
  );
  register(
    server,
    "code_widget_list_items",
    "List Code Widgets",
    "List experimental Miro code widgets.",
    { ...baseSchema, limit: z.number().int().min(1).max(50).default(20), cursor: z.string().optional() },
    async ({ board_url, limit, cursor }) => {
      const { boardId } = parseBoardReference(board_url);
      const page = await client.request(
        `/v2-experimental/boards/${encodeURIComponent(boardId)}/code_widgets`,
        { query: { limit, cursor } },
      );
      return success("Listed code widgets.", { boardId, page });
    },
    false,
    true,
  );
  register(
    server,
    "code_widget_update",
    "Update Code Widget",
    "Update an experimental Miro code widget.",
    {
      ...baseSchema,
      item_id: z.string(),
      code: z.string().max(6000).optional(),
      language: z.string().optional(),
      title: z.string().optional(),
      line_numbers_visible: z.boolean().optional(),
    },
    async ({ board_url, item_id, code, language, title, line_numbers_visible }) => {
      const { boardId } = parseBoardReference(board_url);
      const widget = await client.request(
        `/v2-experimental/boards/${encodeURIComponent(boardId)}/code_widgets/${encodeURIComponent(item_id)}`,
        {
          method: "PATCH",
          body: { data: { code, language, title, lineNumbersVisible: line_numbers_visible } },
        },
      );
      return success("Updated code widget.", { boardId, widget });
    },
    true,
  );
  register(
    server,
    "code_widget_delete",
    "Delete Code Widget",
    "Delete an experimental Miro code widget.",
    { ...baseSchema, item_id: z.string() },
    async ({ board_url, item_id }) => {
      const { boardId } = parseBoardReference(board_url);
      await client.request(
        `/v2-experimental/boards/${encodeURIComponent(boardId)}/code_widgets/${encodeURIComponent(item_id)}`,
        { method: "DELETE" },
      );
      return success("Deleted code widget.", { boardId, itemId: item_id });
    },
    false,
  );
}

function registerCommentTools(server: McpServer): void {
  register(
    server,
    "comment_list_comments",
    "Read Comments",
    "List comments when supported by the public API.",
    {
      board_url: boardReference,
      item_id: z.string().optional(),
      resolved: z.boolean().optional(),
      from: z.string().optional(),
      to: z.string().optional(),
    },
    async ({ board_url }) => unavailable("comment_list_comments", board_url),
    false,
    true,
  );
  register(
    server,
    "comment_reply",
    "Reply to Comment",
    "Reply to a comment thread when supported by the public API.",
    { board_url: boardReference, comment_id: z.string(), text: z.string() },
    async ({ board_url }) => unavailable("comment_reply", board_url),
  );
  register(
    server,
    "comment_resolve",
    "Resolve Comment",
    "Resolve or unresolve a comment thread when supported by the public API.",
    { board_url: boardReference, comment_id: z.string(), resolved: z.boolean() },
    async ({ board_url }) => unavailable("comment_resolve", board_url),
  );
}

function registerPrototypeTools(
  server: McpServer,
  client: MiroClient,
  artifacts: ArtifactStore,
): void {
  register(
    server,
    "prototype_create",
    "Create Prototype",
    "Create app-managed prototype screens from inline HTML.",
    {
      board_url: boardReference,
      title: z.string(),
      screens: z.array(z.object({ name: z.string(), html: z.string().max(200_000) })).min(1),
      x: z.number().optional(),
      y: z.number().optional(),
    },
    async ({ board_url, title, screens, x, y }) => {
      const { boardId } = parseBoardReference(board_url);
      const items = (screens as Array<{ name: string; html: string }>).map((screen, index) => ({
        alias: `screen${index}`,
        type: "frame" as const,
        text: `${screen.name}: ${stripHtml(screen.html).slice(0, 300)}`,
        x: (x ?? 0) + index * 520,
        y: y ?? 0,
        width: 460,
        height: 700,
      }));
      const created = await createLayoutItems(client, boardId, items);
      const artifact = artifacts.create({
        kind: "prototype",
        teamId: client.credential.teamId,
        boardId,
        itemId: String(created[0].id),
        title,
        data: {
          screens: screens.map((screen: any, index: number) => ({
            name: screen.name,
            html: screen.html,
            itemId: created[index]?.id,
          })),
        },
      });
      return success(
        `Created ${screens.length} app-managed prototype screens.`,
        { artifact, boardUrl: boardUrl(boardId, artifact.itemId) },
        "emulated",
        ["Screens are safe visual frames; native Miro prototype HTML is not available publicly."],
      );
    },
    true,
  );
  register(
    server,
    "prototype_read",
    "Read Prototype Screens",
    "Read app-managed prototype screen metadata and HTML.",
    { artifact_id: z.string() },
    async ({ artifact_id }) => {
      const artifact = artifacts.get(artifact_id, client.credential.teamId);
      if (!artifact || artifact.kind !== "prototype") throw new Error("App-managed prototype not found.");
      return success("Read app-managed prototype.", { artifact }, "emulated");
    },
    true,
    true,
  );
}
