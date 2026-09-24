/**
 * Regression tests for the check-loop engine (the bugs that were only
 * reachable at runtime, since pi loads extensions without typechecking):
 *
 *  1. vcc_draft{section} — extractSection used a SECTION_RE that was never
 *     imported (ReferenceError killed the whole compaction).
 *  2. Non-successful model responses (stopReason error/aborted/length, or
 *     errorMessage) must fail closed — pi-ai resolves with the message, it
 *     does not reject, so an unchecked response looked like "no tool calls".
 *  3. Payload tool normalization (Anthropic input_schema -> parameters).
 *  4. No tools in the snapshot -> fail closed.
 *  5. Text-only "stop" response: accepted by default (with a logged warning),
 *     hard failure under guards.requireDone.
 *  6. fail() must not double the "vcc-plus:" prefix.
 *  7. blockImageMessages mirrors pi's convertToLlmWithBlockImages.
 *  8. Empty patch list still enforces the P4 cap.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS } from "../src/config";
import {
  __internals,
  blockImageMessages,
  toolDraft,
} from "../src/engine";
import { applyDeletes } from "../src/patch";

const {
  toolsFromPayload,
  toolsRoundTripStatus,
  runCheckLoop,
  fail,
  extractSection,
  _testSetPhase,
  _testSetSnapshot,
} = __internals;

const DRAFT = `[Session Goal]
- goal A

[Outstanding Context]
- step 1
- step 2`;

function freshPhase(draft: string) {
  return {
    active: true,
    draft,
    capTokens: 10_000,
    charsPerToken: 4,
    maxDraftReads: 3,
    guard: { rounds: 0, fails: 0, draftReads: 0, done: false },
    failedOldTexts: new Map<string, number>(),
  };
}

const VCC_TOOL = { name: "vcc_add", description: "", parameters: { type: "object" } };

function snapshotWith(tools: unknown[] | undefined) {
  _testSetSnapshot({
    messages: [{ role: "user", content: "hi", timestamp: 0 }],
    systemPrompt: "sys",
    tools,
    toolsSource: "test",
    prefixTokens: 10,
    at: 0,
  });
}

function fakeCtx(response: unknown, completeCalls?: number[]) {
  return {
    hasUI: false,
    ui: { notify: () => {} },
    modelRegistry: {
      complete: async () => {
        completeCalls?.push(1);
        return response;
      },
    },
  };
}

const assistant = (content: unknown[], stopReason: string, errorMessage?: string) => ({
  role: "assistant",
  content,
  api: "anthropic-messages",
  provider: "test",
  model: "test",
  usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason,
  errorMessage,
  timestamp: 0,
});

const doneCall = { type: "toolCall", id: "c1", name: "vcc_done", arguments: {} };
const cfg = () => structuredClone(DEFAULTS);

describe("extractSection (vcc_draft section support)", () => {
  test("extracts a section by header", () => {
    expect(extractSection(DRAFT, "[Outstanding Context]")).toBe("4 | [Outstanding Context]\n5 | - step 1\n6 | - step 2");
  });
  test("extracts the trailing section without a trailing header", () => {
    expect(extractSection(DRAFT, "Outstanding Context")).toContain("- step 2");
  });
  test("falls back to the full draft for unknown sections", () => {
    expect(extractSection(DRAFT, "[Nope]")).toContain("Section [Nope] not found");
  });
  test("toolDraft with a section works while the phase is active", async () => {
    _testSetPhase(freshPhase(DRAFT));
    const out = toolDraft({ section: "[Session Goal]" });
    expect(out.isError).not.toBe(true);
    const text = (out.content[0] as { text: string }).text;
    expect(text).toContain("[Session Goal]");
    expect(text).not.toContain("- step 2");
    _testSetPhase(null);
  });
});

describe("runCheckLoop fail-closed on non-successful responses", () => {
  test.each([
    ["error", assistant([], "error", "rate limited")],
    ["aborted", assistant([], "aborted")],
    ["truncated length", assistant([doneCall], "length")],
    ["deferred", assistant([], "deferred")],
    ["errorMessage without stopReason", assistant([], "stop", "boom")],
  ])("fail closed for %s", async (_label, response) => {
    _testSetPhase(freshPhase(DRAFT));
    snapshotWith([VCC_TOOL]);
    await expect(
      runCheckLoop({ ctx: fakeCtx(response), model: { maxTokens: 4096 }, cfg: cfg(), signal: undefined, capTokens: 10_000, charsPerToken: 4, reserveTokens: 16384, log: silentLog() }),
    ).rejects.toThrow(/check request did not succeed/);
    _testSetPhase(null);
    _testSetSnapshot(null);
  });

  test("aborted signal -> throws", async () => {
    _testSetPhase(freshPhase(DRAFT));
    snapshotWith([VCC_TOOL]);
    const controller = new AbortController();
    controller.abort();
    const response = assistant([doneCall], "stop");
    // Already-aborted signal: the loop's top-of-round check throws first
    // ("aborted by the user"); a mid-call abort resolves with stopReason
    // "aborted" and hits the post-complete check instead.
    await expect(
      runCheckLoop({ ctx: fakeCtx(response), model: { maxTokens: 4096 }, cfg: cfg(), signal: controller.signal, capTokens: 10_000, charsPerToken: 4, reserveTokens: 16384, log: silentLog() }),
    ).rejects.toThrow(/aborted by the user|check request did not succeed/);
    _testSetPhase(null);
    _testSetSnapshot(null);
  });

  test("no tools in snapshot -> throws (fail closed, not a degraded request)", async () => {
    _testSetPhase(freshPhase(DRAFT));
    snapshotWith(undefined);
    await expect(
      runCheckLoop({ ctx: fakeCtx(assistant([doneCall], "stop")), model: { maxTokens: 4096 }, cfg: cfg(), signal: undefined, capTokens: 10_000, charsPerToken: 4, reserveTokens: 16384, log: silentLog() }),
    ).rejects.toThrow(/no tool definitions/);
    _testSetPhase(null);
    _testSetSnapshot(null);
  });
});

describe("runCheckLoop success paths", () => {
  test("vcc_done finalizes the draft", async () => {
    _testSetPhase(freshPhase(DRAFT));
    snapshotWith([VCC_TOOL]);
    const result = await runCheckLoop({
      ctx: fakeCtx(assistant([doneCall], "stop")),
      model: { maxTokens: 4096 },
      cfg: cfg(),
      signal: undefined,
      capTokens: 10_000,
      charsPerToken: 4,
      reserveTokens: 16384,
      log: silentLog(),
    });
    expect(result.summary).toBe(DRAFT);
    expect(result.rounds).toBe(1);
    _testSetPhase(null);
    _testSetSnapshot(null);
  });

  test("text-only stop response is accepted by default (cap-validated draft)", async () => {
    _testSetPhase(freshPhase(DRAFT));
    snapshotWith([VCC_TOOL]);
    const result = await runCheckLoop({
      ctx: fakeCtx(assistant([{ type: "text", text: "draft looks fine" }], "stop")),
      model: { maxTokens: 4096 },
      cfg: cfg(),
      signal: undefined,
      capTokens: 10_000,
      charsPerToken: 4,
      reserveTokens: 16384,
      log: silentLog(),
    });
    expect(result.summary).toBe(DRAFT);
    _testSetPhase(null);
    _testSetSnapshot(null);
  });

  test("text-only stop response fails under guards.requireDone", async () => {
    const c = cfg();
    c.guards.requireDone = true;
    _testSetPhase(freshPhase(DRAFT));
    snapshotWith([VCC_TOOL]);
    await expect(
      runCheckLoop({
        ctx: fakeCtx(assistant([{ type: "text", text: "draft looks fine" }], "stop")),
        model: { maxTokens: 4096 },
        cfg: c,
        signal: undefined,
        capTokens: 10_000,
        charsPerToken: 4,
        reserveTokens: 16384,
        log: silentLog(),
      }),
    ).rejects.toThrow(/vcc_done/);
    _testSetPhase(null);
    _testSetSnapshot(null);
  });

  test("vcc_add round trip applies changes then vcc_done finalizes", async () => {
    _testSetPhase(freshPhase(DRAFT));
    snapshotWith([VCC_TOOL]);
    const responses = [
      assistant([{ type: "toolCall", id: "c1", name: "vcc_add", arguments: { section: "Outstanding Context", lines: ["- step 1 (done)"] } }], "stop"),
      assistant([doneCall], "stop"),
    ];
    let i = 0;
    const ctx: any = { hasUI: false, ui: { notify: () => {} }, modelRegistry: { complete: async () => responses[i++] } };
    const result = await runCheckLoop({
      ctx,
      model: { maxTokens: 4096 },
      cfg: cfg(),
      signal: undefined,
      capTokens: 10_000,
      charsPerToken: 4,
      reserveTokens: 16384,
      log: silentLog(),
    });
    expect(result.summary).toContain("- step 1 (done)");
    expect(result.rounds).toBe(2);
    _testSetPhase(null);
    _testSetSnapshot(null);
  });
});

describe("toolsFromPayload (wire tool normalization)", () => {
  test("OpenAI nested function tools", () => {
    const out = toolsFromPayload({
      tools: [{ type: "function", function: { name: "read", description: "read a file", parameters: { type: "object", properties: {} } } }],
    });
    const t = out?.[0];
    expect(t?.name).toBe("read");
    expect(t?.parameters).toEqual({ type: "object", properties: {} });
    expect(t?.input_schema).toBeUndefined();
  });
  test("Anthropic input_schema tools map to parameters (byte-stable round trip)", () => {
    const inputSchema = { type: "object", properties: { path: { type: "string" } }, required: ["path"] };
    const out = toolsFromPayload({
      tools: [{ name: "read", description: "read a file", input_schema: inputSchema, cache_control: { type: "ephemeral" } }],
    });
    const t = out?.[0];
    expect(t?.name).toBe("read");
    expect(t?.parameters).toBe(inputSchema);
    expect(t?.cache_control).toBeUndefined();
  });
  test("already-normalized tools pass through", () => {
    const out = toolsFromPayload({ tools: [{ name: "x", description: "d", parameters: { type: "object" } }] });
    expect(out?.[0]?.parameters).toEqual({ type: "object" });
  });
  test("missing or shapeless tools -> undefined", () => {
    expect(toolsFromPayload({})).toBeUndefined();
    expect(toolsFromPayload({ tools: [] })).toBeUndefined();
    expect(toolsFromPayload({ tools: [{}] })).toBeUndefined();
  });
});

describe("toolsRoundTripStatus (byte-reconstructability guard)", () => {
  const okOpenAi = { type: "function", function: { name: "read", description: "d", parameters: { type: "object" }, strict: false } };
  const okAnthropic = { name: "read", description: "d", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } };

  test("plain tools are ok (strict: false and cache_control are re-derived identically)", () => {
    expect(toolsRoundTripStatus([okOpenAi, okAnthropic, { name: "x", description: "d", parameters: { type: "object" } }])).toBe("ok");
  });
  test("grammar/custom wire tools -> mismatch", () => {
    expect(toolsRoundTripStatus([{ type: "custom", custom: { name: "g", description: "d", format: { type: "grammar" } } }])).toBe("mismatch");
  });
  test("strict: true (OpenAI shape) -> mismatch", () => {
    expect(toolsRoundTripStatus([{ type: "function", function: { name: "read", parameters: { type: "object" }, strict: true } }])).toBe("mismatch");
  });
  test("strict: true (Anthropic shape) -> mismatch", () => {
    expect(toolsRoundTripStatus([{ name: "read", input_schema: { type: "object" }, strict: true }])).toBe("mismatch");
  });
  test("defer_loading -> mismatch", () => {
    expect(toolsRoundTripStatus([{ type: "function", function: { name: "read", parameters: { type: "object" } }, defer_loading: true }])).toBe("mismatch");
  });
  test("unrecognized shape -> mismatch", () => {
    expect(toolsRoundTripStatus([{ weird: true }])).toBe("mismatch");
  });
  test("no tools array -> undefined (nothing to verify)", () => {
    expect(toolsRoundTripStatus(undefined)).toBeUndefined();
  });

  test("mismatched snapshot -> runCheckLoop fails closed", async () => {
    _testSetPhase(freshPhase(DRAFT));
    snapshotWith([VCC_TOOL]);
    _testSetSnapshot({
      messages: [{ role: "user", content: "hi", timestamp: 0 }],
      systemPrompt: "sys",
      tools: [VCC_TOOL],
      toolsSource: "before_provider_request.payload",
      toolsRoundTrip: "mismatch",
      prefixTokens: 10,
      at: 0,
    });
    await expect(
      runCheckLoop({ ctx: fakeCtx(assistant([doneCall], "stop")), model: { maxTokens: 4096 }, cfg: cfg(), signal: undefined, capTokens: 10_000, charsPerToken: 4, reserveTokens: 16384, log: silentLog() }),
    ).rejects.toThrow(/not byte-reconstructable/);
    _testSetPhase(null);
    _testSetSnapshot(null);
  });
});

describe("fail() prefix handling", () => {
  test("does not double the vcc-plus: prefix", () => {
    const c = { ...DEFAULTS, onFailure: "throw" as const };
    expect(() => fail(c, { hasUI: false }, silentLog(), "manual", "vcc-plus: inner boom", {})).toThrow(
      /^vcc-plus: inner boom$/,
    );
    expect(() => fail(c, { hasUI: false }, silentLog(), "manual", "bare message", {})).toThrow(/^vcc-plus: bare message$/);
  });
  test("auto + threshold reason cancels instead of throwing", () => {
    const c = { ...DEFAULTS, onFailure: "auto" as const };
    expect(fail(c, { hasUI: false }, silentLog(), "threshold", "boom", {})).toEqual({ cancel: true });
  });
});

describe("blockImageMessages (mirrors pi's convertToLlmWithBlockImages)", () => {
  test("replaces image parts in user messages and dedupes the placeholder", () => {
    const out = blockImageMessages([
      { role: "user", content: [{ type: "text", text: "a" }, { type: "image", data: "x" }, { type: "image", data: "y" }, { type: "text", text: "b" }], timestamp: 0 },
    ]);
    expect(out[0].content).toEqual([
      { type: "text", text: "a" },
      { type: "text", text: "Image reading is disabled." },
      { type: "text", text: "b" },
    ]);
  });
  test("leaves assistant messages and image-free messages untouched", () => {
    const messages = [
      { role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 0 },
      { role: "user", content: "plain string", timestamp: 0 },
    ];
    expect(blockImageMessages(messages)).toEqual(messages);
  });
});

describe("empty patch list still enforces P4", () => {
  test("no-op patch rejects when the draft is already over the cap", () => {
    const result = applyDeletes({ draft: DRAFT, lines: [], capTokens: 5, charsPerToken: 4 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("over the cap");
  });
  test("no-op patch accepts when under the cap", () => {
    const result = applyDeletes({ draft: DRAFT, lines: [], capTokens: 10_000, charsPerToken: 4 });
    expect(result.ok).toBe(true);
  });
});

function silentLog() {
  return ((event: string, _data?: Record<string, unknown>) => {
    void event;
  }) as unknown as import("../src/log").Logger;
}

/** A Logger that records the events (used to assert what got logged). */
function collectingLog(events: Array<[string, Record<string, unknown>]>) {
  const fn = ((event: string, data: Record<string, unknown> = {}) => {
    events.push([event, data]);
  }) as unknown as import("../src/log").Logger;
  return fn;
}

describe("snapshot persistence (reload survival)", () => {
  const { persistSnapshot, restoreSnapshot, _getSnapshot } = __internals;

  const tmpCtx = (cwd: string, sessionId: string) => ({
    cwd,
    sessionManager: { getSessionId: () => sessionId },
  });

  let cwd: string;
  const snapFile = () => join(cwd, ".pi", "vcc-plus", "last-snapshot.json");

  test("persists a complete snapshot and restores it after cold start", () => {
    cwd = mkdtempSync(join(tmpdir(), "vcc-snap-"));
    try {
      snapshotWith([VCC_TOOL]);
      persistSnapshot(cwd, "sess-1");
      expect(existsSync(snapFile())).toBe(true);
      const stored = JSON.parse(readFileSync(snapFile(), "utf8"));
      expect(stored.sessionId).toBe("sess-1");
      expect(stored.tools).toEqual([VCC_TOOL]);

      // Cold start: module state lost (e.g. /reload)
      _testSetSnapshot(null);
      expect(restoreSnapshot(tmpCtx(cwd, "sess-1"))).toBe(true);
      const restored = _getSnapshot();
      expect(restored?.tools).toEqual([VCC_TOOL]);
      expect(restored?.toolsSource).toBe("persisted (restored after reload)");
      expect(restored?.messages).toEqual(
        [{ role: "user", content: "hi", timestamp: 0 }],
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("refuses a persisted snapshot from a different session", () => {
    cwd = mkdtempSync(join(tmpdir(), "vcc-snap-"));
    try {
      snapshotWith([VCC_TOOL]);
      persistSnapshot(cwd, "sess-1");
      _testSetSnapshot(null);
      expect(restoreSnapshot(tmpCtx(cwd, "sess-2"))).toBe(false);
      expect(_getSnapshot()).toBeNull();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("refuses incomplete or corrupt persisted snapshots", () => {
    cwd = mkdtempSync(join(tmpdir(), "vcc-snap-"));
    try {
      // incomplete: written without tools (never happens via recordPayload,
      // but the file must be validated on read)
      persistSnapshot(cwd, "sess-1"); // snapshot has no tools -> no file
      expect(existsSync(snapFile())).toBe(false);

      // corrupt
      mkdirSync(join(cwd, ".pi", "vcc-plus"), { recursive: true });
      writeFileSync(snapFile(), "{not json", "utf8");
      _testSetSnapshot(null);
      expect(restoreSnapshot(tmpCtx(cwd, "sess-1"))).toBe(false);
      expect(_getSnapshot()).toBeNull();

      // tools stripped / mismatch status
      writeFileSync(snapFile(), JSON.stringify({ sessionId: "sess-1", messages: [{ role: "user", content: "hi" }], tools: [] }), "utf8");
      expect(restoreSnapshot(tmpCtx(cwd, "sess-1"))).toBe(false);
      writeFileSync(snapFile(), JSON.stringify({ sessionId: "sess-1", messages: [{ role: "user", content: "hi" }], tools: [VCC_TOOL], toolsRoundTrip: "mismatch" }), "utf8");
      expect(restoreSnapshot(tmpCtx(cwd, "sess-1"))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("a fresh in-memory snapshot is never overwritten by the persisted one", () => {
    cwd = mkdtempSync(join(tmpdir(), "vcc-snap-"));
    try {
      snapshotWith([VCC_TOOL]);
      persistSnapshot(cwd, "sess-1");
      // simulate a newer request having refreshed the in-memory snapshot
      _testSetSnapshot({
        messages: [{ role: "user", content: "newer", timestamp: 1 }],
        systemPrompt: "sys2",
        tools: [{ name: "x", description: "", parameters: {} }],
        toolsSource: "before_provider_request.payload",
        prefixTokens: 99,
        at: 42,
      });
      expect(restoreSnapshot(tmpCtx(cwd, "sess-1"))).toBe(true);
      expect(_getSnapshot()?.messages).toEqual([{ role: "user", content: "newer", timestamp: 1 }]);
      expect(_getSnapshot()?.toolsSource).toBe("before_provider_request.payload");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("context overflow (pi estimates chars/4, the provider counts the real tokens)", () => {
  const LLAMA_400 =
    'error: 400: {"code":400,"message":"request (322385 tokens) exceeds the available context size (262144 tokens), try increasing it","type":"exceed_context_size_error","n_prompt_tokens":322385,"n_ctx":262144}';

  test("parses the provider's numbers across backends", () => {
    const { parseOverflowError } = __internals;
    expect(parseOverflowError(LLAMA_400)).toEqual({ tokens: 322385, limit: 262144 });
    expect(parseOverflowError("This model's maximum context length is 262144 tokens")).toEqual({
      tokens: null,
      limit: 262144,
    });
    expect(parseOverflowError("429 rate limit")).toBeNull();
  });

  test("trims to the newest slice that fits, keeping at least two messages", () => {
    const { trimCheckMessages } = __internals;
    const messages = Array.from({ length: 10 }, (_, i) => ({ role: "user", content: `m${i} ${"x".repeat(1000)}` }));
    const sentChars = JSON.stringify(messages).length;
    // the provider counted 1/2 of pi's chars: 5000 chars -> 2500 tokens
    const out = trimCheckMessages({
      messages,
      sentChars,
      reportedTokens: Math.ceil(sentChars / 2),
      limitTokens: 2000,
      reserveTokens: 200,
      draftTokens: 100,
    });
    expect(out.messages.length).toBeGreaterThanOrEqual(2);
    expect(out.messages.length).toBeLessThan(messages.length);
    expect(out.messages.at(-1)).toBe(messages.at(-1));
    const keptChars = JSON.stringify(out.messages).length;
    expect(keptChars).toBeLessThanOrEqual(Number(out.report.keepChars));
    expect(Number(out.report.charsPerToken)).toBeCloseTo(2, 1);
    expect(out.report.dropped).toBe(messages.length - out.messages.length);
  });

  test("retries once with a trimmed request, then finishes normally", async () => {
    _testSetPhase(freshPhase(DRAFT));
    snapshotWith([VCC_TOOL]);
    const snapshot = __internals._getSnapshot()!;
    snapshot.messages = Array.from({ length: 20 }, (_, i) => ({
      role: "user",
      content: `msg ${i} ${"x".repeat(2000)}`,
      timestamp: i,
    }));
    const responses = [
      assistant([], "error", LLAMA_400),
      assistant([doneCall], "stop"),
    ];
    let i = 0;
    const seen: number[] = [];
    const ctx: any = {
      hasUI: false,
      ui: { notify: () => {} },
      modelRegistry: {
        complete: async (_m: unknown, context: any) => {
          seen.push(context.messages.length);
          return responses[i++];
        },
      },
    };
    const events: Array<[string, Record<string, unknown>]> = [];
    const result = await runCheckLoop({
      ctx,
      model: { maxTokens: 4096, contextWindow: 262144 },
      cfg: cfg(),
      signal: undefined,
      capTokens: 10_000,
      charsPerToken: 4,
      reserveTokens: 16384,
      log: collectingLog(events),
    });
    expect(result.rounds).toBe(1);
    expect(seen.length).toBe(2); // original + retry
    expect(seen[1]).toBeLessThan(seen[0]);
    const trimmed = events.find(([name]) => name === "check_trimmed");
    expect(trimmed).toBeDefined();
    expect(Number(trimmed![1].limitTokens)).toBe(262144);
    _testSetPhase(null);
    _testSetSnapshot(null);
  });

  test("overflow again after the retry → a marked error for the draft fallback", async () => {
    _testSetPhase(freshPhase(DRAFT));
    snapshotWith([VCC_TOOL]);
    const ctx: any = {
      hasUI: false,
      ui: { notify: () => {} },
      modelRegistry: { complete: async () => assistant([], "error", LLAMA_400) },
    };
    const events: Array<[string, Record<string, unknown>]> = [];
    const error: any = await runCheckLoop({
      ctx,
      model: { maxTokens: 4096, contextWindow: 262144 },
      cfg: cfg(),
      signal: undefined,
      capTokens: 10_000,
      charsPerToken: 4,
      reserveTokens: 16384,
      log: collectingLog(events),
    }).catch((thrown: any) => thrown);
    expect(String(error?.message)).toContain("does not fit the provider's context window");
    expect(error?.overflow).toEqual({ tokens: 322385, limit: 262144 });
    // it trimmed once, then gave up (the caller turns this into the draft fallback)
    expect(events.some(([name]) => name === "check_trimmed")).toBe(true);
    _testSetPhase(null);
    _testSetSnapshot(null);
  });

  test("draftFallback compacts with the finalized mechanical draft and is visible", () => {
    _testSetPhase(freshPhase(DRAFT));
    const events: Array<[string, Record<string, unknown>]> = [];
    const notes: string[] = [];
    const result = __internals.draftFallback(
      { hasUI: true, ui: { notify: (m: string) => notes.push(m) } },
      collectingLog(events),
      "overflow_fallback",
      "the check request cannot fit the provider's context window; compacting with the mechanical draft (unchecked)",
      { firstKeptEntryId: "entry-1", tokensBefore: 1234 },
    );
    expect(result?.compaction.summary).toContain("[Session Goal]");
    expect(result?.compaction.firstKeptEntryId).toBe("entry-1");
    expect(events.some(([name]) => name === "overflow_fallback")).toBe(true);
    expect(events.some(([name]) => name === "finalize")).toBe(true);
    expect(notes.join(" ")).toContain("mechanical draft");
    _testSetPhase(null);
  });

  test("onContextOverflow: \"fail\" keeps the old fail-closed behaviour", async () => {
    _testSetPhase(freshPhase(DRAFT));
    snapshotWith([VCC_TOOL]);
    const config = cfg();
    config.onContextOverflow = "fail";
    const ctx: any = {
      hasUI: false,
      ui: { notify: () => {} },
      modelRegistry: { complete: async () => assistant([], "error", LLAMA_400) },
    };
    await expect(
      runCheckLoop({
        ctx,
        model: { maxTokens: 4096, contextWindow: 262144 },
        cfg: config,
        signal: undefined,
        capTokens: 10_000,
        charsPerToken: 4,
        reserveTokens: 16384,
        log: silentLog(),
      }),
    ).rejects.toThrow(/check request did not succeed/);
    _testSetPhase(null);
    _testSetSnapshot(null);
  });
});
