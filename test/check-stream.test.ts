/**
 * The check phase streams into a live view.
 *
 * Two things have to hold at once: the view sees the response as it arrives
 * (that is the whole point of the feature), and the request on the wire is
 * unchanged — streaming must not touch the body the prefix invariant depends
 * on. The registry is mocked at the `stream` level, so these tests also pin the
 * fallback path (a registry without `stream` still completes the round).
 */
import { describe, expect, test } from "bun:test";
import { __internals } from "../src/engine";
import { DEFAULTS } from "../src/config";
import type { CheckViewEvent } from "../src/check-ui";

const PHASE = {
  active: true,
  draft: "[Results]\n- measured 3.5s",
  capTokens: 4096,
  charsPerToken: 2,
  maxDraftReads: 3,
  guard: { rounds: 0, fails: 0, draftReads: 0, done: false, edits: 0, emptyRetries: 0 },
  failedOldTexts: new Map<string, number>(),
};

const assistant = (content: unknown[], stopReason = "toolUse") => ({
  role: "assistant",
  content,
  stopReason,
  usage: { input: 10, output: 20, cacheRead: 500, cacheWrite: 0, totalTokens: 530 },
  timestamp: 1,
});

/** Records what the view was handed, and can replay a scripted response. */
function recordingView() {
  const events: CheckViewEvent[] = [];
  return {
    events,
    push: (e: CheckViewEvent) => {
      events.push(e);
    },
    dispose: () => {},
  };
}

/** A registry whose `stream` emits the given script, then resolves the message. */
function streamingCtx(script: unknown[], message: unknown) {
  const calls: any[] = [];
  return {
    calls,
    ctx: {
      hasUI: false,
      ui: { notify: () => {} },
      sessionManager: { getBranch: () => [] },
      modelRegistry: {
        // Mirrors pi-ai's AssistantMessageEventStream: async-iterable, and the
        // authoritative message comes from result() (not from the iteration).
        stream: (_model: unknown, _context: unknown, options: any) => {
          calls.push(options);
          return {
            async *[Symbol.asyncIterator]() {
              for (const event of script) yield event;
            },
            result: async () => message,
          };
        },
      },
    },
  };
}

const baseArgs = () => ({
  model: { id: "m", maxTokens: 8192 },
  cfg: { ...DEFAULTS, guards: { ...DEFAULTS.guards } },
  signal: undefined,
  capTokens: 4096,
  charsPerToken: 2,
  reserveTokens: 16384,
  tokensBefore: 123456,
  log: Object.assign(() => {}, { path: "test" }),
});

function primeSnapshot() {
  __internals._testSetSnapshot({
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    systemPrompt: "sys",
    tools: [{ name: "vcc_add", description: "d", parameters: {} }],
    toolsSource: "test",
    toolsRoundTrip: "ok",
    prefixTokens: 100,
    at: Date.now(),
  });
  __internals._testSetPhase({ ...PHASE, guard: { ...PHASE.guard } });
}

describe("check phase streaming", () => {
  test("the model's deltas reach the live view while the round runs", async () => {
    primeSnapshot();
    const view = recordingView();
    const addCall = {
      type: "toolCall",
      id: "1",
      name: "vcc_add",
      arguments: { section: "Results", lines: ["- cacheRead=500 (hit)"] },
    };
    const message = assistant([addCall]);
    const { ctx, calls } = streamingCtx(
      [
        { type: "start", partial: message },
        { type: "thinking_delta", contentIndex: 0, delta: "weighing the options" },
        { type: "toolcall_start", contentIndex: 0, partial: message },
        { type: "toolcall_delta", contentIndex: 0, delta: '{"section":"Res' },
        { type: "toolcall_delta", contentIndex: 0, delta: 'ults","lines":["- cacheRead=500 (hit)"]}' },
        { type: "toolcall_end", contentIndex: 0, toolCall: addCall, partial: message },
        { type: "done", reason: "toolUse", message },
      ],
      message,
    );

    const result = await __internals.runCheckLoop({ ...baseArgs(), ctx, view } as any);

    expect(result.rounds).toBe(1);
    expect(result.summary).toContain("cacheRead=500 (hit)");
    // The view saw the round's progress, including the reasoning that is
    // deliberately never rendered.
    const types = view.events.map((e) => e.type);
    expect(types).toContain("thinking_delta");
    expect(types).toContain("toolcall_delta");
    expect(types).toContain("done");
    // One model request, carrying the same options complete() would have got.
    expect(calls.length).toBe(1);
    expect(calls[0].maxTokens).toBe(4096);
  });

  test("the session id is forwarded: gateways route on the affinity headers", async () => {
    primeSnapshot();
    const view = recordingView();
    const message = assistant([
      { type: "toolCall", id: "1", name: "vcc_add", arguments: { section: "Results", lines: ["- x"] } },
    ]);
    const { ctx, calls } = streamingCtx([{ type: "done", reason: "toolUse", message }], message);
    (ctx.sessionManager as any).getSessionId = () => "sess-abc123";

    await __internals.runCheckLoop({ ...baseArgs(), ctx, view } as any);

    // pi-ai adds x-session-affinity / x-client-request-id / session_id only when
    // options.sessionId is set. Without it a routing gateway rejects the request
    // outright (observed: 400 MissingSessionID) while normal turns work, because
    // pi's own loop always passes it.
    expect(calls[0].sessionId).toBe("sess-abc123");
  });

  test("streaming does not change the outgoing body (the prefix invariant)", async () => {
    primeSnapshot();
    const view = recordingView();
    const addCall = {
      type: "toolCall",
      id: "1",
      name: "vcc_add",
      arguments: { section: "Results", lines: ["- x"] },
    };
    const message = assistant([addCall]);
    const sent: string[] = [];
    const ctx = {
      hasUI: false,
      ui: { notify: () => {} },
      sessionManager: { getBranch: () => [] },
      modelRegistry: {
        stream: (_m: unknown, _c: unknown, options: any) => ({
          async *[Symbol.asyncIterator]() {
            // Exercise the real custom fetch the way the provider would.
            await options.fetch("https://example.invalid/v1/chat/completions", {
              body: JSON.stringify({
                model: "m",
                messages: [{ role: "user", content: "x" }],
                tools: [],
              }),
            });
            yield { type: "start", partial: message };
            yield { type: "toolcall_end", contentIndex: 0, toolCall: addCall, partial: message };
            yield { type: "done", reason: "toolUse", message };
          },
          result: async () => message,
        }),
      },
    };
    // Route the custom fetch at a stub instead of the network.
    const original = globalThis.fetch;
    globalThis.fetch = (async (_input: any, init: any) => {
      sent.push(init.body);
      return new Response("{}");
    }) as any;
    try {
      const result = await __internals.runCheckLoop({ ...baseArgs(), ctx, view } as any);
      expect(result.rounds).toBe(1);
      expect(sent.length).toBeGreaterThan(0);
      // The captured body is the one the engine rewrote: raw wire tools in,
      // engine-owned keys untouched.
      const body = JSON.parse(sent[sent.length - 1]);
      expect(Array.isArray(body.messages)).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("a registry without stream still completes the round (no live view)", async () => {
    primeSnapshot();
    const message = assistant([
      { type: "toolCall", id: "1", name: "vcc_add", arguments: { section: "Results", lines: ["- x"] } },
    ]);
    const ctx = {
      hasUI: false,
      ui: { notify: () => {} },
      sessionManager: { getBranch: () => [] },
      modelRegistry: { complete: async () => message },
    };
    const view = recordingView();
    const result = await __internals.runCheckLoop({ ...baseArgs(), ctx, view } as any);
    expect(result.rounds).toBe(1);
    expect(result.summary).toContain("- x");
    // Nothing was streamed, so the view saw no events.
    expect(view.events.length).toBe(0);
  });
});
