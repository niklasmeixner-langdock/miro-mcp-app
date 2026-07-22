import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createMcpServer } from "../dist/server.js";
import { ArtifactStore } from "../dist/tools/artifacts.js";
import { parseLayoutDsl } from "../dist/tools/dsl.js";
import { UploadStore } from "../dist/tools/uploads.js";

const expectedTools = [
  "board_create", "board_list_items", "board_search_boards",
  "code_widget_create", "code_widget_delete", "code_widget_get",
  "code_widget_list_items", "code_widget_update",
  "comment_list_comments", "comment_reply", "comment_resolve",
  "context_explore", "context_get",
  "diagram_create", "diagram_get_dsl",
  "doc_create", "doc_get", "doc_update",
  "image_create", "image_get_data", "image_get_upload_url", "image_get_url",
  "layout_create", "layout_get_dsl", "layout_read", "layout_update",
  "prototype_create", "prototype_read",
  "render_miro_board",
  "table_create", "table_list_rows", "table_sync_rows",
].sort();

let failures = 0;
function check(name, condition, detail = "") {
  if (!condition) failures += 1;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const server = createMcpServer({
  config: {
    port: 3000,
    baseUrl: "http://localhost:3000",
    miroApiUrl: "https://api.miro.com",
    miroRedirectUri: "http://localhost:3000/oauth/miro/callback",
    staticAccessToken: "test",
  },
  credential: {
    userId: "test-user",
    teamId: "test-team",
    accessToken: "test",
    scope: "boards:read boards:write",
  },
  artifacts: new ArtifactStore(),
  uploads: new UploadStore(),
});
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "verify", version: "1.0.0" });
await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

const { tools } = await client.listTools();
const names = tools.map((tool) => tool.name).sort();
check(
  "registers 31 parity tools plus one render tool",
  JSON.stringify(names) === JSON.stringify(expectedTools),
  names.join(", "),
);
check("all tools expose object input schemas", tools.every((tool) => tool.inputSchema?.type === "object"));
check(
  "only render_miro_board opens the MCP App",
  tools.every((tool) =>
    tool.name === "render_miro_board"
      ? tool._meta?.ui?.resourceUri === "ui://miro/workspace"
      : !tool._meta?.ui?.resourceUri,
  ),
);

const { prompts } = await client.listPrompts();
const promptNames = prompts.map((prompt) => prompt.name);
check("registers documented code prompts", promptNames.includes("code_explain_on_board") && promptNames.includes("code_create_from_board"));

const { resources } = await client.listResources();
check("registers interactive Miro workspace", resources.some((resource) => resource.uri === "ui://miro/workspace"));
const resource = await client.readResource({ uri: "ui://miro/workspace" });
const html = resource.contents[0]?.text ?? "";
check(
  "workspace is one uncluttered Miro iframe",
  html.includes('id="board"') &&
    html.includes("data.embedUrl") &&
    !html.includes('id="canvas"') &&
    !html.includes("<aside"),
);
check(
  "workspace completes the MCP App handshake",
  html.includes("PostMessageTransport") &&
    html.includes("await app.connect"),
);
check(
  "workspace does not poll or reconstruct board items",
  !html.includes("board_list_items") && !html.includes("setInterval"),
);

const layout = await client.callTool({ name: "layout_get_dsl", arguments: {} });
check("layout DSL is runtime discoverable", layout.content?.[0]?.text?.includes("Miro Layout DSL v1"));
const diagram = await client.callTool({ name: "diagram_get_dsl", arguments: {} });
check("diagram DSL is runtime discoverable", diagram.content?.[0]?.text?.includes("Miro Diagram DSL v1"));
const parsedLayout = parseLayoutDsl(
  'retro:frame text="Sprint Retro" x=0 y=0 width=1200 height=700',
);
check(
  "layout DSL preserves quoted property values",
  parsedLayout[0]?.text === "Sprint Retro" && parsedLayout[0]?.width === 1200,
);
const upload = await client.callTool({ name: "image_get_upload_url", arguments: {} });
check("upload URL is temporary and local", upload.structuredContent?.uploadUrl?.startsWith("http://localhost:3000/uploads/"));

await client.close();
await server.close();
console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
