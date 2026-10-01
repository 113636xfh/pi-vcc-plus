/**
 * debugTrace: the full check phase, on screen and in a file.
 *
 * The gap this fills: `check-ui` used to add up `thinking_delta` lengths and
 * throw the text away, and the JSONL log kept counters rather than content. So
 * "what was the model actually reasoning about" had no answer anywhere — which
 * is exactly the question that mattered when a check round came back with 153
 * output tokens and no reasoning at all.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTracer } from "../src/log";
import { mountCheckView } from "../src/check-ui";
import type { CheckViewEvent } from "../src/check-ui";

const stubTheme = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t };

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Restore VCC_PLUS_LOG_DIR; assigning `undefined` stores the string "undefined". */
function restoreLogDir(prev: string | undefined): void {
  if (prev === undefined) delete process.env.VCC_PLUS_LOG_DIR;
  else process.env.VCC_PLUS_LOG_DIR = prev;
}

/** createTracer writes into the shared log dir; redirect it for the test. */
function tracerHere(enabled: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "vcc-trace-"));
  dirs.push(dir);
  const prev = process.env.VCC_PLUS_LOG_DIR;
  process.env.VCC_PLUS_LOG_DIR = dir;
  const tracer = createTracer("test-session", enabled);
  restoreLogDir(prev);
  return { tracer, dir };
}

describe("createTracer", () => {
  test("records thinking, tool calls and receipts in order", () => {
    const { tracer, dir } = tracerHere(true);
    tracer.note("model: test/model");
    tracer.round(1);
    tracer.thinking("I should look at ");
    tracer.thinking("the Files section first.");
    tracer.toolCall("vcc_add", '{"section":"Files And Changes","lines":["- a.ts"]}');
    tracer.toolResult("vcc_add", "Δ +1 -0 lines", false);
    tracer.toolCall("vcc_delete", '{"lines":[42]}');
    tracer.toolResult("vcc_delete", "vcc_delete no longer exists", true);
    tracer.close();

    const out = readFileSync(join(dir, "test-session.trace.md"), "utf8");
    expect(out).toContain("model: test/model");
    expect(out).toContain("## round 1");
    // The two thinking deltas must land as one block, not two fragments.
    expect(out).toContain("I should look at the Files section first.");
    expect(out).toContain('"section":"Files And Changes"');
    expect(out).toContain("Δ +1 -0 lines");
    expect(out).toContain("vcc_delete no longer exists");
    expect(out).toContain("**error**");
    // Thinking must be flushed before the call it led to, not batched at close.
    expect(out.indexOf("thinking")).toBeLessThan(out.indexOf("tool call"));
  });

  test("disabled tracer writes nothing and reports no path", () => {
    const { tracer, dir } = tracerHere(false);
    tracer.round(1);
    tracer.thinking("should not appear");
    tracer.close();
    expect(tracer.path).toBe("");
    expect(existsSync(join(dir, "test-session.trace.md"))).toBe(false);
  });
  test("a failing write never throws", () => {
    // The log dir cannot be created (a file blocks that path): compaction must
    // still finish, and no stray file may be written elsewhere.
    const dir = mkdtempSync(join(tmpdir(), "vcc-trace-"));
    dirs.push(dir);
    writeFileSync(join(dir, "blocker"), "x");
    const prev = process.env.VCC_PLUS_LOG_DIR;
    process.env.VCC_PLUS_LOG_DIR = join(dir, "blocker", "sub");
    const tracer = createTracer("x", true);
    expect(() => {
      tracer.round(1);
      tracer.thinking("y".repeat(10));
      tracer.toolCall("t", "{}");
      tracer.close();
    }).not.toThrow();
    restoreLogDir(prev);
  });
});

interface VHarness {
  lines: () => string[];
  push: (e: CheckViewEvent) => void;
  setExpanded: (v: boolean) => void;
}

function viewHarness(opts: { verbose?: boolean; expanded?: boolean } = {}): VHarness {
  let expanded = opts.expanded !== false;
  let last: string[] = [];
  const ui: any = {
    mode: "rpc",
    theme: stubTheme,
    getToolsExpanded: () => expanded,
    setWidget: (_k: string, content: any) => {
      // rpc/print mode hands over a pre-rendered string[]; tui mode hands over
      // the component function. The stub theme is identity, so lines are the
      // rendered text either way.
      if (Array.isArray(content)) last = content;
      else if (typeof content === "string") last = content.split("\n");
      else if (content && typeof content.render === "function") last = String(content.render?.() ?? "").split("\n");
    },
  };
  const view = mountCheckView(ui, {
    draft: "[Session Goal]\n- mechanical line",
    draftTokens: 100,
    capTokens: 2000,
    tokensBefore: 5000,
    expanded: true,
    verbose: opts.verbose,
  });
  return {
    lines: () => last,
    push: (e) => view.push(e),
    setExpanded: (v) => {
      expanded = v;
    },
  };
}

const thinking = (delta: string, i = 0): CheckViewEvent => ({ type: "thinking_delta", delta, contentIndex: i });

describe("debug view (verbose)", () => {
  test("renders the whole thinking stream, not a tail", () => {
    const h = viewHarness({ verbose: true });
    // 40 lines, each far past any per-line preview cap.
    for (let i = 0; i < 40; i++) h.push(thinking(`line ${i} ${"x".repeat(300)}\n`, i));
    h.push({ type: "done" });
    const out = h.lines().join("\n");
    expect(out).toContain("thinking (");
    expect(out).toContain("line 0 ");
    expect(out).toContain("line 39 ");
    // The 24-line preview budget must not apply to an expanded debug view.
    expect(out.split("\n").length).toBeGreaterThan(24);
  });

  test("shows tool arguments in full, including a replace rewrite", () => {
    const h = viewHarness({ verbose: true });
    h.push({ type: "toolcall_start", name: "vcc_add", contentIndex: 0 });
    h.push({
      type: "toolcall_end",
      contentIndex: 0,
      toolCall: { name: "vcc_add", arguments: { section: "Results", replace: true, lines: ["- a", "- b", "- c", "- d", "- e", "- f", "- g", "- h"] } },
    });
    h.push({ type: "done" });
    const out = h.lines().join("\n");
    expect(out).toContain("(replace)");
    expect(out).toContain("- h");
    expect(out).not.toContain("more lines");
  });

  test("an unrecognized tool shows its raw arguments instead of name()", () => {
    const h = viewHarness({ verbose: true });
    h.push({ type: "toolcall_start", name: "vcc_recall", contentIndex: 0 });
    h.push({ type: "toolcall_end", contentIndex: 0, toolCall: { name: "vcc_recall", arguments: { query: "redis cache decision" } } });
    h.push({ type: "done" });
    expect(h.lines().join("\n")).toContain("redis cache decision");
  });

  test("default view stays a bounded preview and hides thinking", () => {
    const h = viewHarness({ verbose: false });
    for (let i = 0; i < 40; i++) h.push(thinking(`secret reasoning ${i}\n`, i));
    h.push({ type: "done" });
    const out = h.lines().join("\n");
    expect(out).not.toContain("secret reasoning");
    expect(out.split("\n").length).toBeLessThanOrEqual(28);
  });

  test("the status line says a trace is being written", () => {
    const dir = mkdtempSync(join(tmpdir(), "vcc-trace-"));
    dirs.push(dir);
    const prev = process.env.VCC_PLUS_LOG_DIR;
    process.env.VCC_PLUS_LOG_DIR = dir;
    const on = createTracer("status-probe", true);
    const off = createTracer("status-probe", false);
    restoreLogDir(prev);
    on.close();
    // The view and the engine both gate on trace.path, so a disabled tracer has
    // to report no path at all — otherwise the box claims a trace that is
    // never written.
    expect(off.path).toBe("");
    expect(on.path.endsWith("status-probe.trace.md")).toBe(true);
  });
});
