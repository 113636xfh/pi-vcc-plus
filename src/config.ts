import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface Guards {
  /** One "round" = one model request inside the check phase. */
  maxRounds: number;
  maxConsecutiveFails: number;
  maxDraftReads: number;
  /**
   * Optional safety net only. 0 (default) = no time limit: a slow model is not
   * a failure. The check phase is bounded by maxRounds instead.
   */
  callTimeoutMs: number;
}

export interface DraftBudget {
  floorTokens: number;
  ceilingTokens: number;
  tokensPerBlock: number;
}

export interface Config {
  enabled: boolean;
  /** Optional explicit path to the installed @sting8k/pi-vcc package. */
  vccPackagePath: string | null;
  /** null = use the session's active model for the check request. */
  checkModel: { provider: string; id: string } | null;
  draftBudget: DraftBudget;
  guards: Guards;
  /**
   * auto  = manual /compact throws, auto compaction cancels + notifies (fail closed)
   * cancel = always cancel and let the old context stand
   * throw  = always surface an error
   * draft  = fall back to the un-checked VCC draft (explicit opt-in only)
   */
  onFailure: "auto" | "cancel" | "throw" | "draft";
  /** false = fail closed instead of silently deferring to pi's native summarizer. */
  fallbackToNative: boolean;
  /** Register pi-vcc's own vcc_recall tool (read-only history search). */
  upstreamRecallTool: boolean;
  debugLog: boolean;
  systemBlock: string;
}

export const SYSTEM_BLOCK = `<pi-vcc-plus>
This extension takes over context compaction. The flow is:
1. When compaction is needed, a script first extracts this conversation into a mechanical
   "compaction draft" and appends it to the end of the conversation. The draft is not a user
   message: do not comment on it, restate it, or reply to it.
2. The "compaction check phase" then begins: correct the draft with vcc_patch, use vcc_draft
   when you need to see the current full draft, and call vcc_done when you are finished.
3. These three tools are only usable during the compaction check phase; calling them at any
   other time is rejected.
   Separately, vcc_recall (shipped with pi-vcc) stays available in normal turns whenever you
   need to look up earlier parts of this session; it is rejected during the check phase.
4. Your changes are applied to the draft. When compaction completes, the new context is this
   finalized summary plus the last few turns kept verbatim, and the current task continues.
5. During the check phase, output tool calls only: do not continue the conversation and do not
   write user-facing text.
</pi-vcc-plus>`;

export const DEFAULTS: Config = {
  enabled: true,
  vccPackagePath: null,
  checkModel: null,
  draftBudget: { floorTokens: 1100, ceilingTokens: 2000, tokensPerBlock: 15 },
  guards: {
    maxRounds: 8,
    maxConsecutiveFails: 4,
    maxDraftReads: 3,
    callTimeoutMs: 0,
  },
  onFailure: "auto",
  fallbackToNative: false,
  upstreamRecallTool: true,
  debugLog: true,
  systemBlock: SYSTEM_BLOCK,
};

export const agentDir = (): string => join(homedir(), ".pi", "agent");
export const pluginDir = (): string => join(agentDir(), "vcc-plus");
export const configPath = (): string => join(pluginDir(), "config.json");
export const logDir = (): string => join(pluginDir(), "log");

export function ensureConfigFile(): void {
  try {
    const path = configPath();
    if (existsSync(path)) return;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(DEFAULTS, null, 2)}\n`);
  } catch {
    // Best effort: a read-only environment just keeps defaults in memory.
  }
}

export function loadConfig(): Config {
  const base = { ...DEFAULTS, draftBudget: { ...DEFAULTS.draftBudget }, guards: { ...DEFAULTS.guards } };
  try {
    const raw = readFileSync(configPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<Config>;
    return {
      ...base,
      ...parsed,
      draftBudget: { ...base.draftBudget, ...(parsed.draftBudget ?? {}) },
      guards: { ...base.guards, ...(parsed.guards ?? {}) },
    };
  } catch {
    return base;
  }
}
