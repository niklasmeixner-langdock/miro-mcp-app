#!/usr/bin/env node
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import cors from "cors";
import express, { type Request, type Response } from "express";

import {
  authenticateRequest,
  createOAuthRouter,
  makeRequestId,
  oauthChallenge,
} from "./auth/router.js";
import { OAuthStore } from "./auth/store.js";
import { loadConfig } from "./config.js";
import { createMcpServer } from "./server.js";
import { ArtifactStore } from "./tools/artifacts.js";
import { UploadStore } from "./tools/uploads.js";

const config = loadConfig();
const oauthStore = new OAuthStore();
const artifactStore = new ArtifactStore();
const uploadStore = new UploadStore();
const app = express();

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(
  cors({
    origin: true,
    exposedHeaders: ["WWW-Authenticate", "MCP-Session-Id"],
  }),
);

app.post(
  "/uploads/:token",
  express.raw({ type: "*/*", limit: "10mb" }),
  (req: Request, res: Response) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ error: "empty_upload" });
      return;
    }
    const stored = uploadStore.put(
      req.params.token,
      req.body,
      req.headers["content-type"],
      typeof req.headers["x-filename"] === "string"
        ? req.headers["x-filename"]
        : undefined,
    );
    if (!stored) {
      res.status(404).json({ error: "invalid_or_expired_upload" });
      return;
    }
    res.status(201).json({ uploaded: true, token: req.params.token });
  },
);

app.use(express.json({ limit: "4mb" }));
app.use(express.urlencoded({ extended: false }));
app.use(createOAuthRouter(config, oauthStore));

app.get("/", (_req, res) => {
  res.type("text").send(
    "Miro MCP App server\n\nConnect an MCP client to /mcp. OAuth discovery is available under /.well-known/.",
  );
});
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "miro-mcp-app",
    oauthConfigured: Boolean(config.miroClientId && config.miroClientSecret),
    developmentTokenMode: Boolean(config.staticAccessToken),
  });
});

app.all("/mcp", async (req: Request, res: Response) => {
  const requestId = makeRequestId();
  const grant = authenticateRequest(req, config, oauthStore);
  if (!grant) {
    res.setHeader("WWW-Authenticate", oauthChallenge(config));
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Authentication required" },
      id: req.body?.id ?? null,
    });
    return;
  }

  const server = createMcpServer({
    config,
    credential: grant.credential,
    artifacts: artifactStore,
    uploads: uploadStore,
  });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  res.on("close", () => {
    transport.close().catch(() => undefined);
    server.close().catch(() => undefined);
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error(JSON.stringify({ requestId, event: "mcp_request_failed", error: String(error) }));
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal error", data: { requestId } },
        id: req.body?.id ?? null,
      });
    }
  }
});

app.listen(config.port, () => {
  console.log(`Miro MCP App listening at ${config.baseUrl}/mcp`);
  if (config.staticAccessToken) {
    console.warn("MIRO_ACCESS_TOKEN development mode is enabled; MCP requests are not user-isolated.");
  }
});
