import crypto from "node:crypto";
import { Router, type Request, type Response } from "express";

import type { Config } from "../config.js";
import { OAuthStore, type AccessGrant, type MiroCredential } from "./store.js";

const MCP_SCOPES = ["boards:read", "boards:write"];

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function appendQuery(url: string, values: Record<string, string | undefined>): string {
  const target = new URL(url);
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) target.searchParams.set(key, value);
  }
  return target.toString();
}

function isAllowedRedirectUri(value: string): boolean {
  try {
    const parsed = new URL(value);
    const loopback =
      parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "[::1]";
    return parsed.protocol === "https:" || (parsed.protocol === "http:" && loopback);
  } catch {
    return false;
  }
}

function clientCredentials(req: Request): { clientId?: string; clientSecret?: string } {
  const authorization = req.headers.authorization;
  if (authorization?.startsWith("Basic ")) {
    const [clientId, clientSecret] = Buffer.from(
      authorization.slice("Basic ".length),
      "base64",
    )
      .toString("utf8")
      .split(":", 2);
    return { clientId, clientSecret };
  }
  return {
    clientId: asString(req.body?.client_id),
    clientSecret: asString(req.body?.client_secret),
  };
}

export function createOAuthRouter(config: Config, store: OAuthStore): Router {
  const router = Router();
  const issuer = config.baseUrl;
  const resource = `${config.baseUrl}/mcp`;

  router.get("/.well-known/oauth-protected-resource", (_req, res) => {
    res.json({
      resource,
      authorization_servers: [issuer],
      scopes_supported: MCP_SCOPES,
      bearer_methods_supported: ["header"],
    });
  });

  router.get("/.well-known/oauth-protected-resource/mcp", (_req, res) => {
    res.json({
      resource,
      authorization_servers: [issuer],
      scopes_supported: MCP_SCOPES,
      bearer_methods_supported: ["header"],
    });
  });

  const authorizationMetadata = {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    revocation_endpoint: `${issuer}/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: [
      "none",
      "client_secret_post",
      "client_secret_basic",
    ],
    scopes_supported: MCP_SCOPES,
  };

  router.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.json(authorizationMetadata);
  });
  router.post("/register", (req, res) => {
    const redirectUris = Array.isArray(req.body?.redirect_uris)
      ? req.body.redirect_uris.filter(
          (uri: unknown): uri is string =>
            typeof uri === "string" && isAllowedRedirectUri(uri),
        )
      : [];
    if (redirectUris.length === 0) {
      res.status(400).json({ error: "invalid_redirect_uri" });
      return;
    }
    const client = store.registerClient({
      redirectUris,
      clientName: asString(req.body?.client_name),
    });
    res.status(201).json({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: client.redirectUris,
      client_name: client.clientName,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_post",
    });
  });

  router.get("/authorize", (req, res) => {
    if (!config.miroClientId || !config.miroClientSecret) {
      res.status(503).send("Miro OAuth is not configured.");
      return;
    }
    const clientId = asString(req.query.client_id);
    const redirectUri = asString(req.query.redirect_uri);
    const codeChallenge = asString(req.query.code_challenge);
    const method = asString(req.query.code_challenge_method);
    const client = clientId ? store.getClient(clientId) : undefined;
    if (
      !client ||
      !redirectUri ||
      !client.redirectUris.includes(redirectUri) ||
      !codeChallenge ||
      method !== "S256" ||
      req.query.response_type !== "code"
    ) {
      res.status(400).send("Invalid OAuth authorization request.");
      return;
    }

    const requestedScope = asString(req.query.scope) ?? MCP_SCOPES.join(" ");
    const scope = requestedScope
      .split(/\s+/)
      .filter((item) => MCP_SCOPES.includes(item))
      .join(" ");
    const state = store.putPending({
      clientId,
      redirectUri,
      codeChallenge,
      resource: asString(req.query.resource),
      scope,
      clientState: asString(req.query.state),
    });
    res.redirect(
      appendQuery("https://miro.com/oauth/authorize", {
        response_type: "code",
        client_id: config.miroClientId,
        redirect_uri: config.miroRedirectUri,
        state,
      }),
    );
  });

  router.get("/oauth/miro/callback", async (req, res) => {
    const state = asString(req.query.state);
    const code = asString(req.query.code);
    const pending = state ? store.takePending(state) : undefined;
    const authorizationError = asString(req.query.error);
    if (pending && authorizationError) {
      res.redirect(
        appendQuery(pending.redirectUri, {
          error: authorizationError,
          error_description: asString(req.query.error_description),
          state: pending.clientState,
        }),
      );
      return;
    }
    if (!pending || !code || !config.miroClientId || !config.miroClientSecret) {
      res.status(400).send("Invalid or expired Miro authorization callback.");
      return;
    }
    try {
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        client_id: config.miroClientId,
        client_secret: config.miroClientSecret,
        code,
        redirect_uri: config.miroRedirectUri,
      });
      const response = await fetch(`${config.miroApiUrl}/v1/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
      const payload = (await response.json()) as Record<string, unknown>;
      if (!response.ok || typeof payload.access_token !== "string") {
        throw new Error(`Miro token exchange failed (${response.status})`);
      }
      const credential: MiroCredential = {
        userId: String(payload.user_id ?? "unknown"),
        teamId: String(payload.team_id ?? "unknown"),
        accessToken: payload.access_token,
        refreshToken: asString(payload.refresh_token),
        expiresAt: Number.isFinite(Number(payload.expires_in))
          ? Date.now() + Number(payload.expires_in) * 1000
          : undefined,
        scope: String(payload.scope ?? "boards:read boards:write"),
      };
      const authCode = store.issueCode({
        clientId: pending.clientId,
        redirectUri: pending.redirectUri,
        codeChallenge: pending.codeChallenge,
        credential,
        scope: pending.scope,
        resource: pending.resource,
      });
      res.redirect(
        appendQuery(pending.redirectUri, {
          code: authCode,
          state: pending.clientState,
        }),
      );
    } catch (error) {
      console.error("Miro OAuth callback failed:", error);
      res.status(502).send("Miro authorization failed.");
    }
  });

  router.post("/token", (req, res) => {
    const { clientId, clientSecret } = clientCredentials(req);
    const client = clientId ? store.getClient(clientId) : undefined;
    if (!client || (client.clientSecret && client.clientSecret !== clientSecret)) {
      res.status(401).json({ error: "invalid_client" });
      return;
    }

    const grantType = asString(req.body?.grant_type);
    let issued:
      | ReturnType<OAuthStore["exchangeCode"]>
      | ReturnType<OAuthStore["rotateRefresh"]>
      | undefined;
    if (grantType === "authorization_code") {
      issued = store.exchangeCode(
        asString(req.body?.code) ?? "",
        client.clientId,
        asString(req.body?.redirect_uri) ?? "",
        asString(req.body?.code_verifier) ?? "",
      );
    } else if (grantType === "refresh_token") {
      issued = store.rotateRefresh(
        asString(req.body?.refresh_token) ?? "",
        client.clientId,
      );
    }
    if (!issued) {
      res.status(400).json({ error: "invalid_grant" });
      return;
    }
    res.json({
      access_token: issued.accessToken,
      refresh_token: issued.refreshToken,
      token_type: "Bearer",
      expires_in: 3600,
      scope: issued.grant.scope,
    });
  });

  router.post("/revoke", (req, res) => {
    const token = asString(req.body?.token);
    if (token) store.revoke(token);
    res.status(200).end();
  });

  return router;
}

export function authenticateRequest(
  req: Request,
  config: Config,
  store: OAuthStore,
): AccessGrant | undefined {
  if (config.staticAccessToken) {
    return {
      clientId: "static-development-client",
      scope: "boards:read boards:write",
      expiresAt: Number.MAX_SAFE_INTEGER,
      credential: {
        userId: "development-user",
        teamId: process.env.MIRO_TEAM_ID ?? "development-team",
        accessToken: config.staticAccessToken,
        scope: "boards:read boards:write",
      },
    };
  }
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return undefined;
  const grant = store.getAccessGrant(header.slice("Bearer ".length));
  if (grant?.resource && grant.resource !== `${config.baseUrl}/mcp`) return undefined;
  return grant;
}

export function oauthChallenge(config: Config): string {
  const metadata = `${config.baseUrl}/.well-known/oauth-protected-resource/mcp`;
  return `Bearer resource_metadata="${metadata}", scope="${MCP_SCOPES.join(" ")}"`;
}

export function makeRequestId(): string {
  return crypto.randomUUID();
}
