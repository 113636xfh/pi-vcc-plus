/**
 * Reads pi's own settings (project `.pi/settings.json` overrides
 * `~/.pi/agent/settings.json`) for values that the extension needs to
 * replicate pi's wire behavior but that the event ctx does not expose.
 *
 * Fail-open to the default on any read error: a misread here would change
 * the snapshot, so unknown settings never mutate behavior.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { agentDir } from "./config";

function readKey(path: string, keyPath: string[]): unknown {
  try {
    if (!existsSync(path)) return undefined;
    let node: unknown = JSON.parse(readFileSync(path, "utf8"));
    for (const key of keyPath) {
      if (typeof node !== "object" || node === null) return undefined;
      node = (node as Record<string, unknown>)[key];
    }
    return node;
  } catch {
    return undefined;
  }
}

/**
 * pi's `images.blockImages` (default false). When true, pi replaces image
 * parts in user/toolResult messages with "Image reading is disabled." before
 * each provider request — the snapshot must do the same or the prefix
 * diverges (see blockImageMessages in engine.ts).
 *
 * Precedence follows pi's own (docs/settings.md): project settings override
 * global, so the project file is checked first.
 */
export function isBlockImagesEnabled(cwd: string | undefined): boolean {
  const paths = [
    ...(cwd ? [join(cwd, ".pi", "settings.json")] : []),
    join(agentDir(), "settings.json"),
  ];
  for (const path of paths) {
    const value = readKey(path, ["images", "blockImages"]);
    if (typeof value === "boolean") return value;
  }
  return false;
}
