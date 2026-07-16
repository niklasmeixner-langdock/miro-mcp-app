export interface Config {
  port: number;
  baseUrl: string;
  miroApiUrl: string;
  miroClientId?: string;
  miroClientSecret?: string;
  miroRedirectUri: string;
  staticAccessToken?: string;
  tokenEncryptionKey?: string;
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function loadConfig(): Config {
  const port = Number.parseInt(process.env.PORT ?? "3000", 10);
  const baseUrl = trimSlash(
    process.env.BASE_URL ?? `http://localhost:${Number.isFinite(port) ? port : 3000}`,
  );

  return {
    port: Number.isFinite(port) ? port : 3000,
    baseUrl,
    miroApiUrl: trimSlash(process.env.MIRO_API_URL ?? "https://api.miro.com"),
    miroClientId: process.env.MIRO_CLIENT_ID,
    miroClientSecret: process.env.MIRO_CLIENT_SECRET,
    miroRedirectUri:
      process.env.MIRO_REDIRECT_URI ?? `${baseUrl}/oauth/miro/callback`,
    staticAccessToken: process.env.MIRO_ACCESS_TOKEN,
    tokenEncryptionKey: process.env.TOKEN_ENCRYPTION_KEY,
  };
}
