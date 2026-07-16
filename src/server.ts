import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Config } from "./config.js";
import { MiroClient } from "./miro/client.js";
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
