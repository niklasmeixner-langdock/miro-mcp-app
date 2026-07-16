import crypto from "node:crypto";

export interface OAuthClient {
  clientId: string;
  clientSecret?: string;
  redirectUris: string[];
  clientName?: string;
}

export interface MiroCredential {
  userId: string;
  teamId: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope: string;
}

export interface PendingAuthorization {
  state: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource?: string;
  scope: string;
  clientState?: string;
  createdAt: number;
}

interface AuthorizationCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  credential: MiroCredential;
  scope: string;
  resource?: string;
  expiresAt: number;
}

export interface AccessGrant {
  credential: MiroCredential;
  clientId: string;
  scope: string;
  resource?: string;
  expiresAt: number;
}

interface RefreshGrant extends Omit<AccessGrant, "expiresAt"> {
  expiresAt: number;
}

const CODE_TTL_MS = 5 * 60_000;
const ACCESS_TTL_MS = 60 * 60_000;
const REFRESH_TTL_MS = 60 * 24 * 60 * 60_000;

function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export class OAuthStore {
  private readonly clients = new Map<string, OAuthClient>();
  private readonly pending = new Map<string, PendingAuthorization>();
  private readonly codes = new Map<string, AuthorizationCode>();
  private readonly access = new Map<string, AccessGrant>();
  private readonly refresh = new Map<string, RefreshGrant>();

  registerClient(input: Omit<OAuthClient, "clientId" | "clientSecret">): OAuthClient {
    const client: OAuthClient = {
      ...input,
      clientId: randomToken(18),
      clientSecret: randomToken(24),
    };
    this.clients.set(client.clientId, client);
    return client;
  }

  getClient(clientId: string): OAuthClient | undefined {
    return this.clients.get(clientId);
  }

  putPending(input: Omit<PendingAuthorization, "state" | "createdAt">): string {
    const state = randomToken();
    this.pending.set(state, { ...input, state, createdAt: Date.now() });
    return state;
  }

  takePending(state: string): PendingAuthorization | undefined {
    const value = this.pending.get(state);
    this.pending.delete(state);
    if (!value || value.createdAt + CODE_TTL_MS < Date.now()) return undefined;
    return value;
  }

  issueCode(input: Omit<AuthorizationCode, "expiresAt">): string {
    const code = randomToken();
    this.codes.set(code, { ...input, expiresAt: Date.now() + CODE_TTL_MS });
    return code;
  }

  exchangeCode(
    code: string,
    clientId: string,
    redirectUri: string,
    verifier: string,
  ): { accessToken: string; refreshToken: string; grant: AccessGrant } | undefined {
    const value = this.codes.get(code);
    this.codes.delete(code);
    if (
      !value ||
      value.expiresAt < Date.now() ||
      value.clientId !== clientId ||
      value.redirectUri !== redirectUri ||
      !verifyPkce(verifier, value.codeChallenge)
    ) {
      return undefined;
    }
    return this.issueTokens(value);
  }

  rotateRefresh(
    refreshToken: string,
    clientId: string,
  ): { accessToken: string; refreshToken: string; grant: AccessGrant } | undefined {
    const value = this.refresh.get(refreshToken);
    this.refresh.delete(refreshToken);
    if (!value || value.expiresAt < Date.now() || value.clientId !== clientId) {
      return undefined;
    }
    return this.issueTokens(value);
  }

  getAccessGrant(token: string): AccessGrant | undefined {
    const grant = this.access.get(token);
    if (!grant || grant.expiresAt < Date.now()) {
      this.access.delete(token);
      return undefined;
    }
    return grant;
  }

  revoke(token: string): void {
    this.access.delete(token);
    this.refresh.delete(token);
  }

  private issueTokens(
    source: Omit<AccessGrant, "expiresAt">,
  ): { accessToken: string; refreshToken: string; grant: AccessGrant } {
    const accessToken = randomToken();
    const refreshToken = randomToken();
    const grant: AccessGrant = {
      credential: source.credential,
      clientId: source.clientId,
      scope: source.scope,
      resource: source.resource,
      expiresAt: Date.now() + ACCESS_TTL_MS,
    };
    this.access.set(accessToken, grant);
    this.refresh.set(refreshToken, {
      credential: source.credential,
      clientId: source.clientId,
      scope: source.scope,
      resource: source.resource,
      expiresAt: Date.now() + REFRESH_TTL_MS,
    });
    return { accessToken, refreshToken, grant };
  }
}

function verifyPkce(verifier: string, challenge: string): boolean {
  const digest = crypto.createHash("sha256").update(verifier).digest("base64url");
  if (digest.length !== challenge.length) return false;
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(challenge));
}
