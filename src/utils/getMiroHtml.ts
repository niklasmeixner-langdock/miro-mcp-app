import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
let cached: string | undefined;

export async function getMiroHtml(): Promise<string> {
  cached ??= await fs.readFile(path.join(directory, "../ui", "miro.html"), "utf8");
  return cached;
}
