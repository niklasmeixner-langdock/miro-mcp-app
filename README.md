# Miro MCP App

An independent, hosted Model Context Protocol server for Miro with an
interactive MCP App workspace. It exposes the 31 tools in Miro's public MCP
documentation while using only public Miro APIs.

## Highlights

- Streamable HTTP MCP endpoint at `/mcp`
- OAuth 2.1, dynamic client registration, PKCE, and Miro OAuth brokering
- Board search, reading, layouts, diagrams, images, and experimental code widgets
- App-managed document, table, and prototype fallbacks
- Interactive board search, mini-canvas, inspector, and Miro deep links
- Explicit compatibility metadata for every result

See [docs/parity.md](docs/parity.md) for native, emulated, and unavailable
capabilities.

## Requirements

- Node.js 20 or newer
- pnpm 10
- A Miro developer app with expiring tokens
- Public HTTPS hosting for the OAuth callback

Configure the Miro app with:

- Scopes: `boards:read`, `boards:write`, `identity:read`
- Redirect URI: `https://YOUR_HOST/oauth/miro/callback`
- Expiring access tokens enabled

## Configuration

Copy `.env.example` and set:

| Variable | Required | Purpose |
|---|---:|---|
| `BASE_URL` | Hosted mode | Public origin used by MCP OAuth metadata |
| `MIRO_CLIENT_ID` | Hosted mode | Miro OAuth client ID |
| `MIRO_CLIENT_SECRET` | Hosted mode | Miro OAuth client secret |
| `MIRO_REDIRECT_URI` | Hosted mode | Registered Miro callback |
| `PORT` | No | HTTP port, default `3000` |
| `MIRO_API_URL` | No | API override for contract testing |
| `MIRO_ACCESS_TOKEN` | Development only | Bypasses MCP OAuth for one local user |
| `MIRO_TEAM_ID` | Development only | Team associated with the static token |

`MIRO_ACCESS_TOKEN` mode is intentionally not user-isolated. Do not use it on a
shared deployment.

## Run

```bash
pnpm build
pnpm start
```

Connect a client to:

```text
https://YOUR_HOST/mcp
```

The client discovers authorization through RFC 9728 and dynamically registers
itself. The user is then redirected through Miro consent.

For local development with a Miro test token:

```bash
MIRO_ACCESS_TOKEN=... MIRO_TEAM_ID=... pnpm dev
```

## HTTP endpoints

| Endpoint | Purpose |
|---|---|
| `/mcp` | Authenticated Streamable HTTP MCP |
| `/health` | Readiness and configuration state |
| `/.well-known/oauth-protected-resource/mcp` | MCP protected-resource metadata |
| `/.well-known/oauth-authorization-server` | OAuth server metadata |
| `/register` | Dynamic client registration |
| `/authorize`, `/token`, `/revoke` | OAuth lifecycle |
| `/oauth/miro/callback` | Miro OAuth callback |
| `/uploads/:token` | Five-minute, single-use image upload |

## MCP App

Tools that return boards or items attach `ui://miro/workspace`. Compatible hosts
render an inline workspace with:

- Board search
- Host-mediated tool calls
- A geometry-based board preview
- Item details and parity warnings
- Safe “Open in Miro” links

The View never receives Miro or MCP access tokens and never calls Miro directly.

## Verification

```bash
pnpm check
pnpm verify
```

The verification harness checks all 31 tool registrations, prompts, the MCP App
resource, DSL discovery, and upload URL issuance without making Miro API calls.

## Deployment note

OAuth clients, grants, app-managed artifacts, and uploads currently use
process-local stores. This is suitable for local development and a single
non-restarting evaluation instance. Before production or horizontal scaling,
replace `OAuthStore`, `ArtifactStore`, and `UploadStore` with durable encrypted
PostgreSQL/object-storage adapters.
