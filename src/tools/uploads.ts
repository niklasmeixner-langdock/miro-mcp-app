import crypto from "node:crypto";

interface Upload {
  content?: Buffer;
  contentType?: string;
  filename?: string;
  expiresAt: number;
  consumed: boolean;
}

export class UploadStore {
  private readonly uploads = new Map<string, Upload>();

  issue(): { token: string; expiresAt: string } {
    const token = crypto.randomBytes(24).toString("base64url");
    const expiresAt = Date.now() + 5 * 60_000;
    this.uploads.set(token, { expiresAt, consumed: false });
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }

  put(token: string, content: Buffer, contentType?: string, filename?: string): boolean {
    const upload = this.uploads.get(token);
    if (
      !upload ||
      upload.expiresAt < Date.now() ||
      upload.consumed ||
      upload.content
    ) {
      return false;
    }
    upload.content = content;
    upload.contentType = contentType;
    upload.filename = filename;
    return true;
  }

  take(token: string): Upload | undefined {
    const upload = this.uploads.get(token);
    if (
      !upload ||
      upload.expiresAt < Date.now() ||
      upload.consumed ||
      !upload.content
    ) {
      return undefined;
    }
    upload.consumed = true;
    return upload;
  }
}
