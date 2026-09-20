/**
 * Loads pi-vcc's *own* published source (never a copy we edited).
 *
 * The package is expected to be installed but not loaded as an extension:
 *   pi install npm:@sting8k/pi-vcc
 *   settings.json:  { "source": "npm:@sting8k/pi-vcc", "extensions": [] }
 * The empty resource filter keeps its session_before_compact hook disabled so
 * it cannot race pi-vcc-plus for the same compaction.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface VccModule {
  compileRanked: (input: any) => string;
  calibrateCharsPerToken: (chars: number, tokens?: number) => { charsPerToken: number; mode?: string };
  estimateMessageContentChars: (content: unknown) => number;
  packageDir: string;
  version: string;
}

let cached: VccModule | null = null;

const expand = (value: string): string => (value.startsWith("~") ? join(homedir(), value.slice(1)) : value);

export function candidateVccDirs(explicit?: string | null): string[] {
  const dirs: string[] = [];
  if (explicit) dirs.push(expand(explicit));
  const envPath = process.env.PI_VCC_PLUS_VCC_PATH;
  if (envPath) dirs.push(expand(envPath));
  // Repo-relative checkout (git submodule at <repo>/third_party/pi-vcc).
  for (const relative of ["../third_party/pi-vcc", "../../third_party/pi-vcc"]) {
    try {
      dirs.push(fileURLToPath(new URL(relative, import.meta.url)));
    } catch {
      /* ignore */
    }
  }
  dirs.push(join(homedir(), ".pi", "agent", "npm", "node_modules", "@sting8k", "pi-vcc"));
  dirs.push(join(process.cwd(), ".pi", "npm", "node_modules", "@sting8k", "pi-vcc"));
  return [...new Set(dirs)];
}

/** First candidate directory that actually holds pi-vcc's source. */
export function resolveVccDir(explicit?: string | null): string | null {
  for (const dir of candidateVccDirs(explicit)) {
    if (existsSync(join(dir, "src", "core", "summarize.ts"))) return dir;
  }
  return null;
}

/**
 * pi-vcc's own vcc_recall tool registration (their code, untouched).
 * Registers the same tool name/description/schema as the upstream extension.
 */
export async function loadVccRecallTool(
  explicit?: string | null,
): Promise<(pi: any) => void> {
  const dir = resolveVccDir(explicit);
  if (!dir) throw new Error("pi-vcc source directory not found (cannot register vcc_recall)");
  const recall = await import(pathToFileURL(join(dir, "src", "tools", "recall.ts")).href);
  const register = (recall as any).registerRecallTool;
  if (typeof register !== "function") {
    throw new Error("pi-vcc/src/tools/recall.ts does not export registerRecallTool");
  }
  return register;
}

export async function loadVcc(explicit?: string | null): Promise<VccModule> {
  if (cached && !explicit) return cached;

  const tried: string[] = [];
  for (const dir of candidateVccDirs(explicit)) {
    const entry = join(dir, "src", "core", "summarize.ts");
    tried.push(entry);
    if (!existsSync(entry)) continue;
    try {
      const summarize = await import(pathToFileURL(entry).href);
      const tokenEstimate = await import(pathToFileURL(join(dir, "src", "core", "token-estimate.ts")).href);
      let version = "unknown";
      try {
        version = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version ?? "unknown";
      } catch {
        /* version is informational only */
      }
      cached = {
        compileRanked: summarize.compileRanked,
        calibrateCharsPerToken: tokenEstimate.calibrateCharsPerToken,
        estimateMessageContentChars: tokenEstimate.estimateMessageContentChars,
        packageDir: dir,
        version,
      };
      return cached;
    } catch {
      // Fall through to the next candidate.
    }
  }

  // Last resort: let the runtime resolve the bare specifier (works when the
  // package happens to be reachable through the normal module resolution).
  try {
    const summarize = await import("@sting8k/pi-vcc/src/core/summarize.ts" as string);
    const tokenEstimate = await import("@sting8k/pi-vcc/src/core/token-estimate.ts" as string);
    cached = {
      compileRanked: (summarize as any).compileRanked,
      calibrateCharsPerToken: (tokenEstimate as any).calibrateCharsPerToken,
      estimateMessageContentChars: (tokenEstimate as any).estimateMessageContentChars,
      packageDir: "@sting8k/pi-vcc",
      version: "unknown",
    };
    return cached;
  } catch {
    /* report below */
  }

  throw new Error(
    "pi-vcc package not found (pi-vcc-plus does not ship its own copy). " +
      "Install it with: pi install npm:@sting8k/pi-vcc, then keep it unloaded with " +
      '{"source":"npm:@sting8k/pi-vcc","extensions":[]} in settings.json. ' +
      `Tried: ${tried.join(" | ")}`,
  );
}
