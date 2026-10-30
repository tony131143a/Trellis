import { readFileSync } from "node:fs";

export function getHooksConfig(): string {
  return readFileSync(new URL("./hooks.json", import.meta.url), "utf-8");
}
