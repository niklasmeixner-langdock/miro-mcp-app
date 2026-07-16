import type { Config } from "../config.js";
import type { MiroCredential } from "../auth/store.js";

export class MiroApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export function parseBoardReference(value: string): {
  boardId: string;
  itemId?: string;
} {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("A board URL or board ID is required.");
  if (/^https?:\/\//i.test(trimmed)) {
    const url = new URL(trimmed);
    if (url.hostname !== "miro.com" && !url.hostname.endsWith(".miro.com")) {
      throw new Error("Board URLs must use a miro.com host.");
    }
    const match = url.pathname.match(/\/(?:app\/)?board\/([^/]+)/);
    if (!match) throw new Error("The URL is not a Miro board URL.");
    return {
      boardId: decodeURIComponent(match[1]),
      itemId:
        url.searchParams.get("moveToWidget") ??
        url.searchParams.get("focusWidget") ??
        undefined,
    };
  }
  return { boardId: trimmed };
}

export function boardUrl(boardId: string, itemId?: string): string {
  const url = new URL(`https://miro.com/app/board/${encodeURIComponent(boardId)}/`);
  if (itemId) url.searchParams.set("moveToWidget", itemId);
  return url.toString();
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
}

export class MiroClient {
  private refreshPromise?: Promise<void>;

  constructor(
    private readonly config: Config,
    readonly credential: MiroCredential,
  ) {}

  async request<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
    await this.refreshIfNeeded();
    let response = await this.fetch(path, options);
    if (response.status === 401 && this.credential.refreshToken) {
      await this.refresh(true);
      response = await this.fetch(path, options);
    }
    const text = await response.text();
    let payload: unknown;
    try {
      payload = text ? JSON.parse(text) : undefined;
    } catch {
      payload = text;
    }
    if (!response.ok) {
      const retryAfter = response.headers.get("retry-after");
      throw new MiroApiError(
        `Miro API request failed (${response.status})${retryAfter ? `; retry after ${retryAfter}s` : ""}`,
        response.status,
        payload,
      );
    }
    return payload as T;
  }

  async getAllItems(
    boardId: string,
    options: { type?: string; parentItemId?: string; limit?: number } = {},
  ): Promise<unknown[]> {
    const items: unknown[] = [];
    let cursor: string | undefined;
    const maximum = options.limit ?? 200;
    do {
      const page = await this.request<{
        data?: unknown[];
        cursor?: string;
        links?: { next?: string };
      }>(`/v2/boards/${encodeURIComponent(boardId)}/items`, {
        query: {
          limit: Math.min(50, maximum - items.length),
          cursor,
          type: options.type,
          parent_item_id: options.parentItemId,
        },
      });
      items.push(...(page.data ?? []));
      cursor = page.cursor;
      if (!cursor && page.links?.next) {
        try {
          cursor = new URL(page.links.next).searchParams.get("cursor") ?? undefined;
        } catch {
          cursor = undefined;
        }
      }
    } while (cursor && items.length < maximum);
    return items.slice(0, maximum);
  }

  private async fetch(path: string, options: RequestOptions): Promise<Response> {
    const url = new URL(path, `${this.config.miroApiUrl}/`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: `Bearer ${this.credential.accessToken}`,
      ...options.headers,
    };
    let body: BodyInit | undefined;
    if (options.body !== undefined) {
      if (options.body instanceof FormData) {
        delete headers["content-type"];
        body = options.body;
      } else {
        headers["content-type"] ??= "application/json";
        body =
          headers["content-type"] === "application/json"
            ? JSON.stringify(options.body)
            : (options.body as BodyInit);
      }
    }
    return fetch(url, {
      method: options.method ?? "GET",
      headers,
      body,
    });
  }

  private async refreshIfNeeded(): Promise<void> {
    if (
      this.credential.refreshToken &&
      this.credential.expiresAt &&
      this.credential.expiresAt < Date.now() + 60_000
    ) {
      await this.refresh();
    }
  }

  private async refresh(force = false): Promise<void> {
    if (!this.credential.refreshToken) return;
    if (!force && this.credential.expiresAt && this.credential.expiresAt > Date.now() + 60_000) {
      return;
    }
    if (!this.config.miroClientId || !this.config.miroClientSecret) {
      throw new Error("Miro OAuth client credentials are required to refresh access.");
    }
    if (!this.refreshPromise) {
      this.refreshPromise = (async () => {
        const response = await fetch(`${this.config.miroApiUrl}/v1/oauth/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: this.config.miroClientId!,
            client_secret: this.config.miroClientSecret!,
            refresh_token: this.credential.refreshToken!,
          }),
        });
        const payload = (await response.json()) as Record<string, unknown>;
        if (!response.ok || typeof payload.access_token !== "string") {
          throw new MiroApiError("Unable to refresh Miro access.", response.status, payload);
        }
        this.credential.accessToken = payload.access_token;
        this.credential.refreshToken =
          typeof payload.refresh_token === "string"
            ? payload.refresh_token
            : this.credential.refreshToken;
        this.credential.expiresAt =
          Date.now() + Number(payload.expires_in ?? 3599) * 1000;
      })().finally(() => {
        this.refreshPromise = undefined;
      });
    }
    await this.refreshPromise;
  }
}
