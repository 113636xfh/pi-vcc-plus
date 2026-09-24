/**
 * Tests for the check-request byte verification:
 *  - buildCheckFetch: replaces the outgoing body's tools with the captured
 *    raw wire tools (byte-exact) and captures the outgoing body.
 *  - verifyCheckPrefix: prefix comparison of the check body against the
 *    previous real request's wire body.
 *  - runCheckLoop integration: fake modelRegistry.complete simulates pi-ai
 *    calling options.fetch, and the checkPrefix log entry is produced.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS } from "../src/config";
import { __internals } from "../src/engine";
import { type Logger } from "../src/log";

const { buildCheckFetch, verifyCheckPrefix, readWireBaseline, runCheckLoop, _testSetPhase, _testSetSnapshot } = __internals;

type Any = any;

const WIRE_TOOLS = [
  { name: "t1", description: "d1", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } },
  { name: "t2", description: "d2", input_schema: { type: "object" } },
];
// what pi-ai would reconstruct (no cache_control — the wire-only field)
const RECONSTRUCTED_TOOLS = [
  { name: "t1", description: "d1", input_schema: { type: "object" } },
  { name: "t2", description: "d2", input_schema: { type: "object" } },
];

let originalFetch: typeof globalThis.fetch;
const fetchCalls: Array<{ url: string; init: unknown }> = [];

beforeAll(() => {
  originalFetch = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = (async (url: unknown, init: unknown) => {
    fetchCalls.push({ url: String(url), init });
    return { ok: true } as Response;
  }) as typeof globalThis.fetch;
});

afterAll(() => {
  (globalThis as { fetch: unknown }).fetch = originalFetch;
});

function bodyOf(callIndex = 0): Record<string, unknown> {
  const init = fetchCalls[callIndex]?.init as { body: string };
  return JSON.parse(init.body) as Record<string, unknown>;
}

describe("buildCheckFetch", () => {
  test("replaces tools with the raw wire tools, keeps everything else byte-identical", async () => {
    fetchCalls.length = 0;
    const capture: { url?: string; bodyText?: string } = {};
    const fetch = buildCheckFetch(WIRE_TOOLS, capture);
    const outgoing = {
      model: "m",
      max_tokens: 100,
      system: "S",
      messages: [{ role: "user", content: "x" }],
      tools: RECONSTRUCTED_TOOLS, // pi-ai's reconstruction (cache_control lost)
    };
    await fetch("https://x.test/v1/messages", { method: "POST", headers: { a: "1" }, body: JSON.stringify(outgoing) });

    const got = bodyOf(0);
    expect(JSON.parse(JSON.stringify(got.tools))).toEqual(WIRE_TOOLS); // byte-exact wire tools restored
    const strip = (o: Record<string, unknown>) =>
      JSON.stringify({ model: o.model, max_tokens: o.max_tokens, system: o.system, messages: o.messages });
    expect(strip(got)).toBe(strip(outgoing)); // untouched fields byte-identical
    expect(capture.url).toBe("https://x.test/v1/messages");
    expect(capture.bodyText).toBe(typeof (fetchCalls[0]!.init as { body?: unknown }).body === "string" ? (fetchCalls[0]!.init as { body: string }).body : undefined);
  });

  test("only the first outgoing body is captured (the SENT body, tools replaced)", async () => {
    fetchCalls.length = 0;
    const capture: { url?: string; bodyText?: string } = {};
    const fetch = buildCheckFetch(WIRE_TOOLS, capture);
    const b1 = JSON.stringify({ model: "m", messages: [{ role: "user", content: "1" }], tools: RECONSTRUCTED_TOOLS });
    const b2 = JSON.stringify({ model: "m", messages: [{ role: "user", content: "2" }], tools: RECONSTRUCTED_TOOLS });
    await fetch("u", { body: b1 });
    await fetch("u", { body: b2 });
    // capture holds the first SENT body: original fields + wire tools swapped in
    expect(capture.bodyText).toBe(JSON.stringify({ model: "m", messages: [{ role: "user", content: "1" }], tools: WIRE_TOOLS }));
    expect(fetchCalls.length).toBe(2); // both requests actually went through
  });

  test("no body: passed through, capture stays empty string", async () => {
    fetchCalls.length = 0;
    const capture: { url?: string; bodyText?: string } = {};
    const fetch = buildCheckFetch(WIRE_TOOLS, capture);
    await fetch("u", { method: "GET" });
    expect((fetchCalls[0]!.init as { body?: unknown }).body).toBeUndefined();
    expect(capture.bodyText).toBe("");
  });

  test("unparseable body: original request goes out unchanged, no throw", async () => {
    fetchCalls.length = 0;
    const capture: { url?: string; bodyText?: string } = {};
    const fetch = buildCheckFetch(WIRE_TOOLS, capture);
    await expect(fetch("u", { body: "{ not json" })).resolves.toBeDefined();
    expect((fetchCalls[0]!.init as { body: string }).body).toBe("{ not json");
    expect(capture.bodyText).toBe("{ not json");
  });

  test("restores the last real request's wire parameters (the prefix-cache key)", async () => {
    fetchCalls.length = 0;
    const capture: { url?: string; bodyText?: string } = {};
    // What the provider saw on the last real request: thinking enabled, full
    // output budget, store=false. The check call would otherwise send
    // enable_thinking:false + max_tokens:capTokens and lose every cache hit.
    const wireParams = {
      max_tokens: 32768,
      store: false,
      stream: false,
      stream_options: { include_usage: false },
      chat_template_kwargs: { enable_thinking: true, preserve_thinking: true },
    };
    const fetch = buildCheckFetch(WIRE_TOOLS, capture, wireParams);
    const outgoing = {
      model: "m",
      max_tokens: 26214,
      store: false,
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "user", content: "x" }],
      tools: RECONSTRUCTED_TOOLS,
      chat_template_kwargs: { enable_thinking: false, preserve_thinking: true },
    };
    await fetch("u", { method: "POST", body: JSON.stringify(outgoing) });

    const got = bodyOf(0);
    expect(got.max_tokens).toBe(32768);
    expect(got.chat_template_kwargs).toEqual({ enable_thinking: true, preserve_thinking: true });
    expect(JSON.parse(JSON.stringify(got.tools))).toEqual(WIRE_TOOLS);
    expect(got.messages).toEqual(outgoing.messages); // engine-owned, untouched
    expect(got.model).toBe("m");
    // transport flags stay pi-ai's: a captured stream:false must not turn the
    // streaming check call into a non-streaming one
    expect(got.stream).toBe(true);
    expect(got.stream_options).toEqual({ include_usage: true });
  });

  test("wireParams never overwrite model/messages/tools", async () => {
    fetchCalls.length = 0;
    const fetch = buildCheckFetch(WIRE_TOOLS, {}, {
      model: "EVIL",
      messages: [{ role: "user", content: "EVIL" }],
      tools: [{ name: "EVIL" }],
      max_tokens: 7,
    });
    const outgoing = { model: "m", messages: [{ role: "user", content: "x" }], tools: RECONSTRUCTED_TOOLS };
    await fetch("u", { body: JSON.stringify(outgoing) });
    const got = bodyOf(0);
    expect(got.model).toBe("m");
    expect(got.messages).toEqual(outgoing.messages);
    expect(JSON.parse(JSON.stringify(got.tools))).toEqual(WIRE_TOOLS);
    expect(got.max_tokens).toBe(7); // ordinary parameter is restored
  });
});

describe("verifyCheckPrefix", () => {
  const baseline = {
    model: "m",
    system: "S",
    tools: WIRE_TOOLS,
    messages: [
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
    ],
  };
  const tail = { role: "user", content: "TAIL" };

  test("baseline + appended tail -> identical", () => {
    const v = verifyCheckPrefix(baseline, { ...baseline, messages: [...baseline.messages, tail] }, "sentinel");
    expect(v.identical).toBe(true);
    expect(v.firstDivergence).toBeNull();
    expect(v.messages).toEqual({ baseline: 3, check: 4 });
  });

  test("divergent message -> field messages + index", () => {
    const v = verifyCheckPrefix(baseline, { ...baseline, messages: [baseline.messages[0], { role: "assistant", content: "CHANGED" }, baseline.messages[2]] }, "sentinel");
    expect(v.identical).toBe(false);
    expect(v.firstDivergence).toEqual({ field: "messages", index: 1 });
  });

  test("tools differ -> field tools (system/messages still pass)", () => {
    const v = verifyCheckPrefix(baseline, { ...baseline, messages: [...baseline.messages, tail], tools: RECONSTRUCTED_TOOLS }, "sentinel");
    expect(v.identical).toBe(false);
    expect(v.firstDivergence).toEqual({ field: "tools" });
    expect(v.checks.messages).toBe(true);
  });

  test("system differs -> field system", () => {
    const v = verifyCheckPrefix(baseline, { ...baseline, system: "S2" }, "sentinel");
    expect(v.firstDivergence).toEqual({ field: "system" });
  });

  test("check body shorter than baseline -> messages fail at the drop point", () => {
    const v = verifyCheckPrefix(baseline, { ...baseline, messages: baseline.messages.slice(0, 2) }, "self");
    expect(v.identical).toBe(false);
    expect(v.firstDivergence).toEqual({ field: "messages", index: 2 });
    expect(v.baselineSource).toBe("self");
  });

  test("OpenAI-style (no top-level system): system prompt lives in messages[0]", () => {
    const openai = {
      model: "m",
      tools: WIRE_TOOLS,
      messages: [{ role: "system", content: "SYS" }, { role: "user", content: "u" }],
    };
    const v = verifyCheckPrefix(openai, { ...openai, messages: [...openai.messages, { role: "user", content: "t" }] }, "sentinel");
    expect(v.identical).toBe(true);
  });
});

describe("readWireBaseline: freshness and precedence", () => {
  const scratch = mkdtempSync(join(tmpdir(), "vcc-plus-baseline-"));
  function write(cwd: string, source: "sentinel" | "self", ts: number, extra?: Record<string, unknown>) {
    const dir = join(cwd, ".pi", source === "sentinel" ? "prefix-sentinel" : "vcc-plus");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, source === "sentinel" ? "last-request.json" : "last-wire-request.json"),
      JSON.stringify({ ts, pretty: "{}", ...extra }),
      "utf8",
    );
  }

  test("both stale (older than snapshot) -> null", () => {
    const cwd = join(scratch, "stale");
    mkdirSync(cwd, { recursive: true });
    write(cwd, "sentinel", 100);
    write(cwd, "self", 150);
    expect(readWireBaseline(cwd, 200)).toBeNull();
  });

  test("stale sentinel, fresh self -> self wins", () => {
    const cwd = join(scratch, "self-fresh");
    mkdirSync(cwd, { recursive: true });
    write(cwd, "sentinel", 100);
    write(cwd, "self", 300);
    expect(readWireBaseline(cwd, 200)?.source).toBe("self");
  });

  test("both fresh -> newest wins", () => {
    const cwd = join(scratch, "newest");
    mkdirSync(cwd, { recursive: true });
    write(cwd, "sentinel", 250);
    write(cwd, "self", 300);
    expect(readWireBaseline(cwd, 200)?.source).toBe("self");
  });

  test("tie -> sentinel (independent capture) preferred", () => {
    const cwd = join(scratch, "tie");
    mkdirSync(cwd, { recursive: true });
    write(cwd, "sentinel", 300);
    write(cwd, "self", 300);
    expect(readWireBaseline(cwd, 200)?.source).toBe("sentinel");
  });

  test("missing ts -> treated as stale", () => {
    const cwd = join(scratch, "nots");
    mkdirSync(cwd, { recursive: true });
    const dir = join(cwd, ".pi", "vcc-plus");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "last-wire-request.json"), JSON.stringify({ pretty: "{}" }), "utf8");
    expect(readWireBaseline(cwd, 1)).toBeNull();
  });

  test("no sinceTs -> any parseable candidate is accepted", () => {
    const cwd = join(scratch, "nosince");
    mkdirSync(cwd, { recursive: true });
    write(cwd, "sentinel", 100);
    expect(readWireBaseline(cwd)?.source).toBe("sentinel");
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });
});

describe("runCheckLoop: check-request byte verification (integration)", () => {
  const scratch = mkdtempSync(join(tmpdir(), "vcc-plus-checkfetch-"));

  function setup(cwd: string, baselineMessages: unknown[], baselineTools: unknown[]) {
    const sentinelDir = join(cwd, ".pi", "prefix-sentinel");
    mkdirSync(sentinelDir, { recursive: true });
    writeFileSync(
      join(sentinelDir, "last-request.json"),
      JSON.stringify({
        index: 1,
        ts: 0,
        modelId: "m",
        pretty: JSON.stringify({ model: "m", system: "S", tools: baselineTools, messages: baselineMessages }, null, 2),
        messages: baselineMessages,
      }),
      "utf8",
    );
  }

  function ctxWithCwd(cwd: string, completeImpl: (context: unknown, options: { fetch: unknown }) => Promise<unknown>) {
    return {
      cwd,
      hasUI: false,
      ui: { notify: () => {} },
      modelRegistry: { complete: async (_m: unknown, context: unknown, options: { fetch: unknown }) => completeImpl(context, options) },
    };
  }

  function captureLog() {
    const entries: Array<[string, Record<string, unknown>]> = [];
    const log = ((name: string, data: Record<string, unknown> = {}) => {
      entries.push([name, data]);
    }) as Logger;
    log.path = "";
    return { log, entries };
  }

  const u1 = { role: "user", content: "u1" };

  function doneResponse() {
    return {
      role: "assistant",
      content: [{ type: "toolCall", id: "c1", name: "vcc_done", arguments: {} }],
      api: "anthropic-messages",
      provider: "test",
      model: "test",
      usage: { input: 10, output: 5, cacheRead: 10, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse",
      timestamp: 0,
    };
  }

  function freshPhase() {
    return {
      active: true,
      draft: "[Session Goal]\n- g",
      capTokens: 10_000,
      charsPerToken: 4,
      maxDraftReads: 3,
      guard: { rounds: 0, fails: 0, draftReads: 0, done: false },
      failedOldTexts: new Map<string, number>(),
    };
  }

  function snapWith(overrides: Record<string, unknown> = {}) {
    return {
      messages: [u1],
      systemPrompt: "sys",
      tools: RECONSTRUCTED_TOOLS.map((t) => ({ ...t, parameters: t.input_schema })),
      wireTools: WIRE_TOOLS,
      toolsSource: "test",
      toolsRoundTrip: "ok",
      prefixTokens: 10,
      at: 0,
      ...overrides,
    } as any;
  }

  test("identical prefix: checkPrefix identical=true, check-request.json written with wire tools", async () => {
    const cwd = join(scratch, "ok");
    mkdirSync(cwd, { recursive: true });
    setup(cwd, [u1], WIRE_TOOLS);
    _testSetPhase({
      active: true,
      draft: "[Session Goal]\n- g",
      capTokens: 10_000,
      charsPerToken: 4,
      maxDraftReads: 3,
      guard: { rounds: 0, fails: 0, draftReads: 0, done: false },
      failedOldTexts: new Map(),
    });
    _testSetSnapshot({
      messages: [u1],
      systemPrompt: "sys",
      tools: RECONSTRUCTED_TOOLS.map((t) => ({ ...t, parameters: t.input_schema })),
      wireTools: WIRE_TOOLS,
      toolsSource: "test",
      toolsRoundTrip: "ok",
      prefixTokens: 10,
      at: 0,
    });

    const { log, entries } = captureLog();
    fetchCalls.length = 0;
    await runCheckLoop({
      ctx: ctxWithCwd(cwd, async (_context, options) => {
        // simulate pi-ai: body with pi-ai's RECONSTRUCTED tools + appended tail
        const body = JSON.stringify({ model: "m", system: "S", tools: RECONSTRUCTED_TOOLS, messages: [u1, { role: "user", content: "TAIL" }] });
        await (options.fetch as typeof globalThis.fetch)("https://x.test/v1/messages", { method: "POST", body });
        return {
          role: "assistant",
          content: [{ type: "toolCall", id: "c1", name: "vcc_done", arguments: {} }],
          api: "anthropic-messages",
          provider: "test",
          model: "test",
          usage: { input: 10, output: 5, cacheRead: 10, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "toolUse",
          timestamp: 0,
        };
      }),
      model: { maxTokens: 4096 },
      cfg: structuredClone(DEFAULTS),
      signal: undefined,
      capTokens: 10_000,
      charsPerToken: 4,
      reserveTokens: 16384,
      log,
    });

    const checkPrefix = entries.find(([n]) => n === "checkPrefix")?.[1];
    expect(checkPrefix).toBeDefined();
    expect(checkPrefix!.identical).toBe(true);
    expect(checkPrefix!.baselineSource).toBe("sentinel");
    const written = JSON.parse(readFileSync(join(cwd, ".pi", "prefix-sentinel", "check-request.json"), "utf8"));
    expect(JSON.parse(JSON.stringify(written.tools))).toEqual(WIRE_TOOLS);
    _testSetPhase(null);
    _testSetSnapshot(null);
  });

  test("divergent prefix: checkPrefix identical=false with firstDivergence", async () => {
    const cwd = join(scratch, "divergent");
    mkdirSync(cwd, { recursive: true });
    setup(cwd, [{ role: "user", content: "u1-ORIGINAL" }], WIRE_TOOLS);
    _testSetPhase({
      active: true,
      draft: "[Session Goal]\n- g",
      capTokens: 10_000,
      charsPerToken: 4,
      maxDraftReads: 3,
      guard: { rounds: 0, fails: 0, draftReads: 0, done: false },
      failedOldTexts: new Map(),
    });
    _testSetSnapshot({
      messages: [u1], // different from the baseline's u1-ORIGINAL
      systemPrompt: "sys",
      tools: RECONSTRUCTED_TOOLS.map((t) => ({ ...t, parameters: t.input_schema })),
      wireTools: WIRE_TOOLS,
      toolsSource: "test",
      toolsRoundTrip: "ok",
      prefixTokens: 10,
      at: 0,
    });

    const { log, entries } = captureLog();
    await runCheckLoop({
      ctx: ctxWithCwd(cwd, async (_context, options) => {
        const body = JSON.stringify({ model: "m", system: "S", tools: RECONSTRUCTED_TOOLS, messages: [u1, { role: "user", content: "TAIL" }] });
        await (options.fetch as typeof globalThis.fetch)("https://x.test/v1/messages", { method: "POST", body });
        return {
          role: "assistant",
          content: [{ type: "toolCall", id: "c1", name: "vcc_done", arguments: {} }],
          api: "anthropic-messages",
          provider: "test",
          model: "test",
          usage: { input: 10, output: 5, cacheRead: 10, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "toolUse",
          timestamp: 0,
        };
      }),
      model: { maxTokens: 4096 },
      cfg: structuredClone(DEFAULTS),
      signal: undefined,
      capTokens: 10_000,
      charsPerToken: 4,
      reserveTokens: 16384,
      log,
    });

    const checkPrefix = entries.find(([n]) => n === "checkPrefix")?.[1];
    expect(checkPrefix!.identical).toBe(false);
    expect(checkPrefix!.firstDivergence).toEqual({ field: "messages", index: 0 });
    _testSetPhase(null);
    _testSetSnapshot(null);
  });

  test("no baseline: checkPrefix identical=null with reason", async () => {
    const cwd = join(scratch, "nobl");
    mkdirSync(cwd, { recursive: true });
    _testSetPhase({
      active: true,
      draft: "[Session Goal]\n- g",
      capTokens: 10_000,
      charsPerToken: 4,
      maxDraftReads: 3,
      guard: { rounds: 0, fails: 0, draftReads: 0, done: false },
      failedOldTexts: new Map(),
    });
    _testSetSnapshot({
      messages: [u1],
      systemPrompt: "sys",
      tools: RECONSTRUCTED_TOOLS.map((t) => ({ ...t, parameters: t.input_schema })),
      wireTools: WIRE_TOOLS,
      toolsSource: "test",
      toolsRoundTrip: "ok",
      prefixTokens: 10,
      at: 0,
    });

    const { log, entries } = captureLog();
    await runCheckLoop({
      ctx: ctxWithCwd(cwd, async (_context, options) => {
        await (options.fetch as typeof globalThis.fetch)("https://x.test/v1/messages", {
          method: "POST",
          body: JSON.stringify({ model: "m", system: "S", tools: RECONSTRUCTED_TOOLS, messages: [u1] }),
        });
        return doneResponse();
      }),
      model: { maxTokens: 4096 },
      cfg: structuredClone(DEFAULTS),
      signal: undefined,
      capTokens: 10_000,
      charsPerToken: 4,
      reserveTokens: 16384,
      log,
    });

    const checkPrefix = entries.find(([n]) => n === "checkPrefix")?.[1];
    expect(checkPrefix!.identical).toBeNull();
    expect(String(checkPrefix!.reason)).toContain("no fresh wire baseline");
    _testSetPhase(null);
    _testSetSnapshot(null);
  });

  test("stale self-baseline (ts < snapshot.at) is ignored, not used", async () => {
    const cwd = join(scratch, "stale-self");
    mkdirSync(join(cwd, ".pi", "vcc-plus"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "vcc-plus", "last-wire-request.json"),
      JSON.stringify({ ts: 500, pretty: JSON.stringify({ model: "m", system: "S", tools: WIRE_TOOLS, messages: [u1] }, null, 2) }),
      "utf8",
    );
    _testSetPhase(freshPhase());
    _testSetSnapshot(snapWith({ at: 1000 }));

    const { log, entries } = captureLog();
    await runCheckLoop({
      ctx: ctxWithCwd(cwd, async (_context, options) => {
        await (options.fetch as typeof globalThis.fetch)("https://x.test/v1/messages", {
          method: "POST",
          body: JSON.stringify({ model: "m", system: "S", tools: RECONSTRUCTED_TOOLS, messages: [u1, { role: "user", content: "TAIL" }] }),
        });
        return doneResponse();
      }),
      model: { maxTokens: 4096 },
      cfg: structuredClone(DEFAULTS),
      signal: undefined,
      capTokens: 10_000,
      charsPerToken: 4,
      reserveTokens: 16384,
      log,
    });

    const checkPrefix = entries.find(([n]) => n === "checkPrefix")?.[1];
    expect(checkPrefix!.identical).toBeNull();
    expect(String(checkPrefix!.reason)).toContain("no fresh wire baseline");
    _testSetPhase(null);
    _testSetSnapshot(null);
  });

  test("fresh self-baseline (sentinel absent) is used: baselineSource=self", async () => {
    const cwd = join(scratch, "self-fresh");
    mkdirSync(join(cwd, ".pi", "vcc-plus"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "vcc-plus", "last-wire-request.json"),
      JSON.stringify({ ts: 1000, pretty: JSON.stringify({ model: "m", system: "S", tools: WIRE_TOOLS, messages: [u1] }, null, 2) }),
      "utf8",
    );
    _testSetPhase(freshPhase());
    _testSetSnapshot(snapWith({ at: 1000 }));

    const { log, entries } = captureLog();
    await runCheckLoop({
      ctx: ctxWithCwd(cwd, async (_context, options) => {
        await (options.fetch as typeof globalThis.fetch)("https://x.test/v1/messages", {
          method: "POST",
          body: JSON.stringify({ model: "m", system: "S", tools: RECONSTRUCTED_TOOLS, messages: [u1, { role: "user", content: "TAIL" }] }),
        });
        return doneResponse();
      }),
      model: { maxTokens: 4096 },
      cfg: structuredClone(DEFAULTS),
      signal: undefined,
      capTokens: 10_000,
      charsPerToken: 4,
      reserveTokens: 16384,
      log,
    });

    const checkPrefix = entries.find(([n]) => n === "checkPrefix")?.[1];
    expect(checkPrefix!.identical).toBe(true);
    expect(checkPrefix!.baselineSource).toBe("self");
    _testSetPhase(null);
    _testSetSnapshot(null);
  });

  test("fetch never called: visible 'not verified' state (fetchCalled=false)", async () => {
    const cwd = join(scratch, "nofetch");
    mkdirSync(cwd, { recursive: true });
    _testSetPhase(freshPhase());
    _testSetSnapshot(snapWith());

    const { log, entries } = captureLog();
    await runCheckLoop({
      ctx: ctxWithCwd(cwd, async () => doneResponse()), // provider ignored options.fetch
      model: { maxTokens: 4096 },
      cfg: structuredClone(DEFAULTS),
      signal: undefined,
      capTokens: 10_000,
      charsPerToken: 4,
      reserveTokens: 16384,
      log,
    });

    const checkPrefix = entries.find(([n]) => n === "checkPrefix")?.[1];
    expect(checkPrefix).toBeDefined();
    expect(checkPrefix!.identical).toBeNull();
    expect(checkPrefix!.fetchCalled).toBe(false);
    expect(String(checkPrefix!.reason)).toContain("never called");
    _testSetPhase(null);
    _testSetSnapshot(null);
  });

  test("fetch called without a JSON body string: visible 'not verified' state", async () => {
    const cwd = join(scratch, "nobody");
    mkdirSync(cwd, { recursive: true });
    _testSetPhase(freshPhase());
    _testSetSnapshot(snapWith());

    const { log, entries } = captureLog();
    await runCheckLoop({
      ctx: ctxWithCwd(cwd, async (_context, options) => {
        await (options.fetch as typeof globalThis.fetch)("https://x.test/v1/messages", { method: "POST" });
        return doneResponse();
      }),
      model: { maxTokens: 4096 },
      cfg: structuredClone(DEFAULTS),
      signal: undefined,
      capTokens: 10_000,
      charsPerToken: 4,
      reserveTokens: 16384,
      log,
    });

    const checkPrefix = entries.find(([n]) => n === "checkPrefix")?.[1];
    expect(checkPrefix!.identical).toBeNull();
    expect(checkPrefix!.fetchCalled).toBe(true);
    expect(String(checkPrefix!.reason)).toContain("no JSON body string");
    _testSetPhase(null);
    _testSetSnapshot(null);
  });

  test("continuation: the last session assistant beyond the snapshot is inserted before the tail", async () => {
    const reply = {
      role: "assistant",
      content: [{ type: "text", text: "R's reply" }],
      api: "test",
      provider: "test",
      model: "test",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "end",
      timestamp: 0,
    };
    let capturedRoles: string[] = [];
    let capturedAssistant: any = null;
    _testSetPhase(freshPhase());
    _testSetSnapshot(snapWith({}));
    const { log, entries } = captureLog();
    const ctx = {
      cwd: scratch,
      hasUI: false,
      ui: { notify: () => {} },
      sessionManager: {
        getBranch: () => [
          { type: "message", message: u1 },
          { type: "message", message: reply },
        ],
      },
      modelRegistry: {
        complete: async (_m: unknown, context: unknown, _options: { fetch: unknown }) => {
          // copy at call time — the loop mutates the same array afterwards
          const msgs = ((context as any).messages as any[]).map((m) => ({ ...m }));
          capturedRoles = msgs.map((m) => m.role);
          capturedAssistant = msgs[1];
          return doneResponse();
        },
      },
    } as any;
    await runCheckLoop({
      ctx,
      model: { maxTokens: 4096 },
      cfg: structuredClone(DEFAULTS),
      signal: undefined,
      capTokens: 10_000,
      charsPerToken: 4,
      reserveTokens: 16384,
      log,
    });
    expect(capturedRoles).toEqual(["user", "assistant", "user"]);
    expect(capturedAssistant).toEqual(reply);
    expect(entries.some(([n]) => n === "continuation")).toBe(true);
    _testSetPhase(null);
    _testSetSnapshot(null);
  });

  test("continuation: no insertion when the last assistant is already in the snapshot", async () => {
    const reply = {
      role: "assistant",
      content: [{ type: "text", text: "old reply" }],
      timestamp: 0,
    };
    let capturedRoles: string[] = [];
    _testSetPhase(freshPhase());
    _testSetSnapshot(snapWith({ messages: [u1, reply] }));
    const { log, entries } = captureLog();
    const ctx = {
      cwd: scratch,
      hasUI: false,
      ui: { notify: () => {} },
      sessionManager: {
        getBranch: () => [
          { type: "message", message: u1 },
          { type: "message", message: { ...reply, timestamp: 999 } },
        ],
      },
      modelRegistry: {
        complete: async (_m: unknown, context: unknown, _options: { fetch: unknown }) => {
          capturedRoles = ((context as any).messages as any[]).map((m) => m.role);
          return doneResponse();
        },
      },
    } as any;
    await runCheckLoop({
      ctx,
      model: { maxTokens: 4096 },
      cfg: structuredClone(DEFAULTS),
      signal: undefined,
      capTokens: 10_000,
      charsPerToken: 4,
      reserveTokens: 16384,
      log,
    });
    expect(capturedRoles).toEqual(["user", "assistant", "user"]);
    expect(entries.some(([n]) => n === "continuation")).toBe(false);
    _testSetPhase(null);
    _testSetSnapshot(null);
  });

  test("snapshotContinuationAssistant: unit cases", () => {
    const { snapshotContinuationAssistant } = __internals;
    const reply = { role: "assistant", content: [{ type: "text", text: "R's reply" }], timestamp: 5 };
    const ctxFor = (entries: unknown[]) => ({
      cwd: scratch,
      sessionManager: { getBranch: () => entries },
    });
    // no snapshot
    _testSetSnapshot(null);
    expect(snapshotContinuationAssistant(ctxFor([{ type: "message", message: reply }]))).toBeNull();
    // no assistant in session / no sessionManager
    _testSetSnapshot(snapWith({}));
    expect(snapshotContinuationAssistant(ctxFor([]))).toBeNull();
    expect(snapshotContinuationAssistant(ctxFor([{ type: "message", message: u1 }]))).toBeNull();
    expect(snapshotContinuationAssistant({ cwd: scratch })).toBeNull();
    // last assistant beyond the snapshot
    expect(
      snapshotContinuationAssistant(
        ctxFor([{ type: "message", message: u1 }, { type: "message", message: reply }]),
      ),
    ).toEqual(reply);
    // last assistant already carried by the snapshot (timestamp/extra fields ignored)
    _testSetSnapshot(snapWith({ messages: [u1, { role: "assistant", content: reply.content, timestamp: 77, api: "x" }] }));
    expect(snapshotContinuationAssistant(ctxFor([{ type: "message", message: reply }]))).toBeNull();
    _testSetSnapshot(null);
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });
});
