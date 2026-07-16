import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Config } from "./config.js";
import { MiroClient, boardUrl, parseBoardReference } from "./miro/client.js";
import type { MiroCredential } from "./auth/store.js";
import type { ArtifactStore } from "./tools/artifacts.js";
import {
  MIRO_APP_RESOURCE_URI,
  registerMiroTools,
} from "./tools/register.js";
import type { UploadStore } from "./tools/uploads.js";
import { getMiroHtml } from "./utils/getMiroHtml.js";

const UI_META = {
  ui: {
    csp: {
      connectDomains: ["https://api.miro.com"],
      resourceDomains: [
        "https://esm.sh",
        "https://miro.com",
        "https://*.mirostatic.com",
      ],
    },
  },
} as const;

export interface ServerDependencies {
  config: Config;
  credential: MiroCredential;
  artifacts: ArtifactStore;
  uploads: UploadStore;
}

function safeJsonForHtml(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function createMcpServer(dependencies: ServerDependencies): McpServer {
  const server = new McpServer({
    name: "miro-mcp-app",
    version: "0.1.0",
  });

  registerAppResource(
    server,
    MIRO_APP_RESOURCE_URI,
    MIRO_APP_RESOURCE_URI,
    { mimeType: RESOURCE_MIME_TYPE, _meta: UI_META },
    async () => ({
      contents: [
        {
          uri: MIRO_APP_RESOURCE_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: await getMiroHtml(),
          _meta: UI_META,
        },
      ],
    }),
  );

  const client = new MiroClient(dependencies.config, dependencies.credential);
  registerMiroTools(server, {
    config: dependencies.config,
    client,
    artifacts: dependencies.artifacts,
    uploads: dependencies.uploads,
  });

  registerAppTool(
    server,
    "render_miro_board",
    {
      title: "Render Miro Board",
      description:
        "Open one interactive Miro board canvas in the client. Call this once after creating or selecting a board; subsequent board mutations appear inside the same canvas automatically.",
      inputSchema: {
        board_url: z.string().min(1).describe("Full Miro board URL or board ID."),
        limit: z.number().int().min(1).max(500).default(200),
      },
      _meta: { ui: { resourceUri: MIRO_APP_RESOURCE_URI } },
    },
    async ({ board_url, limit }) => {
      try {
        const { boardId, itemId } = parseBoardReference(board_url);
        const [board, items] = await Promise.all([
          client.request<Record<string, any>>(
            `/v2/boards/${encodeURIComponent(boardId)}`,
          ),
          client.getAllItems(boardId, {
            parentItemId: itemId,
            limit,
          }),
        ]);
        const renderData = {
          board,
          boardId,
          boardUrl: board.viewLink ?? boardUrl(boardId, itemId),
          focusedItemId: itemId,
          items,
          parity: "native",
          warnings: [],
        };
        const html = (await getMiroHtml()).replace(
          "</head>",
          `<script>window.MIRO_DATA=${safeJsonForHtml(renderData)};</script></head>`,
        );
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(renderData) },
            {
              type: "resource" as const,
              resource: {
                uri: MIRO_APP_RESOURCE_URI,
                mimeType: RESOURCE_MIME_TYPE,
                text: html,
                _meta: UI_META,
              },
            },
          ],
          structuredContent: renderData,
          _meta: { "mcpui.dev/ui-initial-render-data": renderData },
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: error instanceof Error ? error.message : String(error),
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerPrompt(
    "code_explain_on_board",
    {
      title: "Explain Code on a Miro Board",
      description: "Create a visual explanation of code on a Miro board.",
      argsSchema: {
        board_url: z.string().describe("Target Miro board URL."),
        code: z.string().describe("Code or code context to explain."),
      },
    },
    ({ board_url, code }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Explain the following code visually on ${board_url}. Use diagram_get_dsl, then diagram_create, and add a document for important details.\n\n${code}`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "code_create_from_board",
    {
      title: "Create Code from a Miro Board",
      description: "Read a Miro board and turn its specification into code.",
      argsSchema: {
        board_url: z.string().describe("Source Miro board URL."),
      },
    },
    ({ board_url }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Read ${board_url} with context_explore and context_get, clarify ambiguities, then implement the specification represented on the board.`,
          },
        },
      ],
    }),
  );

  return server;
}
