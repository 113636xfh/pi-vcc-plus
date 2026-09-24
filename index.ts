/**
 * pi-vcc-plus — entry point.
 *
 * Registers (at session start, so the tools array is part of the stable
 * prefix):
 *   - the compaction mechanism block appended to the system prompt
 *   - vcc_patch / vcc_draft / vcc_done (only usable during the compaction check)
 *   - snapshots of the last provider request (prefix source of truth)
 *   - the compaction takeover on session_before_compact
 */
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ensureConfigFile, loadConfig } from "./src/config";
import {
  DESC_VCC_DONE,
  DESC_VCC_DRAFT,
  DESC_VCC_PATCH,
  DESC_VCC_PATCH_NEW,
  DESC_VCC_PATCH_OLD,
} from "./src/prompt";
import {
  onBeforeCompact,
  recordContext,
  recordPayload,
  setToolProvider,
  toolDone,
  toolDraft,
  toolPatch,
} from "./src/engine";
import { createLogger } from "./src/log";
import { loadVccRecallTool } from "./src/vcc";

/**
 * Async on purpose: pi awaits async extension factories before session_start,
 * so tools registered here are part of the tool list from the very first
 * request — the prefix stays stable.
 */
export default async function piVccPlus(pi: ExtensionAPI): Promise<void> {
  ensureConfigFile();
  const cfg = loadConfig();
  if (!cfg.enabled) return;

  pi.registerTool({
    name: "vcc_patch",
    label: "VCC Patch",
    description: DESC_VCC_PATCH,
    parameters: Type.Object({
      changes: Type.Array(
        Type.Object({
          oldText: Type.String({ description: DESC_VCC_PATCH_OLD }),
          newText: Type.String({ description: DESC_VCC_PATCH_NEW }),
        }),
      ),
    }),
    async execute(_toolCallId: string, params: unknown) {
      return toolPatch(params);
    },
  });

  pi.registerTool({
    name: "vcc_draft",
    label: "VCC Draft",
    description: DESC_VCC_DRAFT,
    parameters: Type.Object({
      section: Type.Optional(Type.String({ description: 'e.g. "[Outstanding Context]"' })),
    }),
    async execute(_toolCallId: string, params: unknown) {
      return toolDraft(params);
    },
  });

  pi.registerTool({
    name: "vcc_done",
    label: "VCC Done",
    description: DESC_VCC_DONE,
    parameters: Type.Object({}),
    async execute() {
      return toolDone();
    },
  });

  // pi-vcc's own read-only history search tool, registered from their source.
  if (cfg.upstreamRecallTool) {
    const log = createLogger("startup", cfg.debugLog);
    try {
      const registerRecallTool = await loadVccRecallTool(cfg.vccPackagePath);
      registerRecallTool(pi);
      log("upstream_recall_registered", {});
    } catch (error) {
      log("upstream_recall_failed", { error: String(error) });
    }
  }

  // Prefix snapshots (see src/engine.ts).
  pi.on("context", async (event: any, ctx: any) => {
    recordContext(event?.messages ?? [], ctx);
  });
  pi.on("before_provider_request", async (event: any, ctx: any) => {
    recordPayload(event?.payload, ctx);
  });

  // Cold-start fallback: when no wire snapshot exists (fresh /reload, new
  // process) the engine rebuilds one from the session, and needs pi's own tool
  // registry for that — the active tools in pi-ai's Tool shape.
  setToolProvider(() => {
    try {
      const active = new Set<string>((pi as any).getActiveTools?.() ?? []);
      const all: any[] = (pi as any).getAllTools?.() ?? [];
      return all
        .filter((tool) => tool?.name && (active.size === 0 || active.has(tool.name)))
        .map((tool) => ({
          name: tool.name,
          description: tool.description ?? "",
          parameters: tool.parameters,
        }));
    } catch {
      return [];
    }
  });

  // Constant mechanism block — same string on every run keeps the prefix stable.
  // cfg is read exactly once at load: a mid-session edit of config.json must
  // not change the system block (it would break the prefix invariant);
  // config changes require /reload.
  pi.on("before_agent_start", async (event: any) => {
    const block = cfg.systemBlock;
    if (!block) return undefined;
    return { systemPrompt: `${event?.systemPrompt ?? ""}\n\n${block}` };
  });

  pi.on("session_before_compact", async (event: any, ctx: any) => onBeforeCompact(event, ctx, cfg));
}
