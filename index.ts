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
  toolDone,
  toolDraft,
  toolPatch,
} from "./src/engine";

export default function piVccPlus(pi: ExtensionAPI): void {
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
    async execute(_toolCallId: string, params: unknown): Promise<unknown> {
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
    async execute(_toolCallId: string, params: unknown): Promise<unknown> {
      return toolDraft(params);
    },
  });

  pi.registerTool({
    name: "vcc_done",
    label: "VCC Done",
    description: DESC_VCC_DONE,
    parameters: Type.Object({}),
    async execute(): Promise<unknown> {
      return toolDone();
    },
  });

  // Prefix snapshots (see src/engine.ts).
  pi.on("context", async (event: any, ctx: any) => {
    recordContext(event?.messages ?? [], ctx);
  });
  pi.on("before_provider_request", async (event: any, ctx: any) => {
    recordPayload(event?.payload, ctx);
  });

  // Constant mechanism block — same string on every run keeps the prefix stable.
  pi.on("before_agent_start", async (event: any) => {
    const block = loadConfig().systemBlock;
    if (!block) return undefined;
    return { systemPrompt: `${event?.systemPrompt ?? ""}\n\n${block}` };
  });

  pi.on("session_before_compact", async (event: any, ctx: any) => onBeforeCompact(pi, event, ctx));
}
