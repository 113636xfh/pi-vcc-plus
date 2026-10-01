/**
 * The supported wire contract.
 *
 * The check request rebuilds the previous request's prefix by rewriting its body
 * (raw wire tools in, captured request-level parameters back). That needs an
 * adapter which takes a custom `fetch` and speaks a JSON body we can parse:
 * OpenAI-compatible chat completions, plus Anthropic messages. Everything else
 * must fail closed *and say why* — a silently degraded check request would cost
 * a full prefill while looking like a cache miss.
 */
import { describe, expect, test } from "bun:test";
import { __internals } from "../src/engine";
import { DEFAULTS } from "../src/config";

const { toolsRoundTripStatus, unsupportedToolReason, unsupportedApiReason, wireToolCaveats } = __internals as any;

const openaiTool = {
  type: "function",
  function: { name: "a", description: "d", parameters: { type: "object", properties: {} } },
};

describe("supported wire contract", () => {
  test("OpenAI-compatible tool shapes are accepted", () => {
    expect(toolsRoundTripStatus([openaiTool])).toBe("ok");
    expect(unsupportedToolReason([openaiTool])).toBeNull();
    // Anthropic's tool encoding is reconstructed exactly too.
    expect(toolsRoundTripStatus([{ name: "a", description: "d", input_schema: { type: "object" } }])).toBe("ok");
    // Plain {name, description, parameters}.
    expect(toolsRoundTripStatus([{ name: "a", description: "d", parameters: { type: "object" } }])).toBe("ok");
  });

  test("an unrecognized shape is refused and named", () => {
    expect(toolsRoundTripStatus([{ nope: 1 }])).toBe("mismatch");
    expect(unsupportedToolReason([{ nope: 1 }])).toBe("an unrecognized tool shape");
  });

  test("only the refusal reasons name the actual shape", () => {
    expect(unsupportedToolReason([{ type: "custom", custom: { grammar: {} } }])).toMatch(/grammar/);
    expect(unsupportedToolReason([{ functionDeclarations: [{ name: "a" }] }])).toMatch(/Google/);
    expect(unsupportedToolReason([{ toolSpec: { name: "a" } }])).toMatch(/Bedrock/);
    expect(unsupportedToolReason([null])).toMatch(/not an object/);
    // A supported shape in the list must not be blamed for a later bad one.
    expect(unsupportedToolReason([openaiTool, { toolSpec: { name: "a" } }])).toMatch(/Bedrock/);
    // strict/defer_loading are no longer refusal reasons — the write-back
    // restores them, so they must not be reported as the cause of anything.
    expect(toolsRoundTripStatus([{ ...openaiTool, function: { ...openaiTool.function, strict: true } }])).toBe("ok");
    expect(unsupportedToolReason([{ ...openaiTool, function: { ...openaiTool.function, strict: true } }])).toBeNull();
    expect(unsupportedToolReason([{ ...openaiTool, defer_loading: true }])).toBeNull();
  });

  test("write-back-only flags are reported, not refused", () => {
    const strict = [{ ...openaiTool, function: { ...openaiTool.function, strict: true } }];
    const deferred = [{ ...openaiTool, defer_loading: true, eager_input_streaming: true }];
    expect(wireToolCaveats(strict)).toEqual(["strict"]);
    expect(wireToolCaveats(deferred)).toEqual(["defer_loading", "eager_input_streaming"]);
    expect(wireToolCaveats([openaiTool])).toEqual([]);
    expect(wireToolCaveats(undefined)).toEqual([]);
    // strict:false is pi-ai's own default and re-derived identically — not a caveat.
    expect(wireToolCaveats([{ ...openaiTool, function: { ...openaiTool.function, strict: false } }])).toEqual([]);
  });

  test("the adapters we support, and only those", () => {
    expect(unsupportedApiReason("openai-completions")).toBeNull();
    expect(unsupportedApiReason("anthropic-messages")).toBeNull();
    for (const api of ["google-generative-ai", "google-vertex", "bedrock-converse-stream"]) {
      expect(unsupportedApiReason(api)).toContain(api);
    }
    // A custom adapter id is refused too: nothing proves it preserves the
    // prefix, and a silently diverged check request is the failure mode this
    // design exists to prevent. Only a missing api is left to the request.
    expect(unsupportedApiReason("some-custom-adapter")).toContain("some-custom-adapter");
    expect(unsupportedApiReason(undefined)).toBeNull();
  });
});

describe("fail-closed messages name the contract", () => {
  const baseArgs = () => ({
    cfg: { ...DEFAULTS, guards: { ...DEFAULTS.guards } },
    signal: undefined,
    capTokens: 4096,
    charsPerToken: 2,
    reserveTokens: 16384,
    tokensBefore: 1000,
    log: Object.assign(() => {}, { path: "t" }),
  });

  const run = async (snapshot: any, model: any) => {
    __internals._testSetSnapshot(snapshot);
    __internals._testSetPhase({
      active: true,
      draft: "[Results]\n- x",
      capTokens: 4096,
      charsPerToken: 2,
      maxDraftReads: 3,
      guard: { rounds: 0, fails: 0, draftReads: 0, done: false, edits: 0, emptyRetries: 0 },
      failedOldTexts: new Map(),
    } as any);
    const ctx = {
      hasUI: false,
      ui: { notify: () => {} },
      sessionManager: { getBranch: () => [] },
      modelRegistry: { complete: async () => {
        throw new Error("the request must never be sent");
      } },
    };
    return await __internals.runCheckLoop({ ...baseArgs(), ctx, model } as any);
  };

  test("Google tool encoding is named, and the contract is stated", async () => {
    const promise = run(
      {
        messages: [{ role: "user", content: "hi" }],
        systemPrompt: "s",
        tools: [{ name: "vcc_add" }],
        toolsSource: "t",
        toolsRoundTrip: "mismatch",
        wireTools: [{ functionDeclarations: [{ name: "a" }] }],
        prefixTokens: 10,
        at: Date.now(),
      },
      { api: "google-generative-ai", id: "m", maxTokens: 4096 },
    );
    expect(promise).rejects.toThrow(/functionDeclarations/);
    expect(promise).rejects.toThrow(/openai-completions/);
  });

  test("a missing tools snapshot names the offending adapter", async () => {
    const promise = run(
      {
        messages: [{ role: "user", content: "hi" }],
        systemPrompt: "s",
        tools: undefined,
        toolsSource: "none",
        prefixTokens: 10,
        at: Date.now(),
      },
      { api: "bedrock-converse-stream", id: "m", maxTokens: 4096 },
    );
    expect(promise).rejects.toThrow(/bedrock-converse-stream/);
  });

  test("on a supported adapter an empty tools snapshot states the contract", async () => {
    const promise = run(
      {
        messages: [{ role: "user", content: "hi" }],
        systemPrompt: "s",
        tools: undefined,
        toolsSource: "none",
        prefixTokens: 10,
        at: Date.now(),
      },
      { api: "openai-completions", id: "m", maxTokens: 4096 },
    );
    expect(promise).rejects.toThrow(/openai-completions/);
  });
});
