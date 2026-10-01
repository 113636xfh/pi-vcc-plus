/**
 * The live check view.
 *
 * The rendering bugs this file pins down were all found by rendering the
 * component and reading the output, not by reasoning about it:
 *   - counters were wiped every frame (the status line read "0 rounds"),
 *   - the double-count guard also dropped the call's *lines* on later frames,
 *   - `status()` read the call counts before they were computed, so they lagged
 *     a frame — and, combined with the guard, vanished entirely.
 */
import { describe, expect, test } from "bun:test";
import { mountCheckView } from "../src/check-ui";
import type { CheckViewEvent } from "../src/check-ui";

/** pi passes its real Theme in; the harness uses one with the same shape. */
const stubTheme = {
  fg: (_c: string, t: string) => t,
  bg: (_c: string, t: string) => t,
  bold: (t: string) => t,
};

interface Harness {
  view: ReturnType<typeof mountCheckView>;
  /** Everything last handed to setWidget as a string array. */
  lines: () => string[];
  /** The rendered component, for mouse tests. */
  render: (width?: number) => string[];
  click: (y: number) => void;
  disposed: () => boolean;
}

function harness(opts: { mode?: string; expanded?: boolean; draft?: string } = {}): Harness {
  let lastLines: string[] | undefined;
  let component: any;
  let disposed = false;
  const ui: any = {
    mode: opts.mode ?? "tui",
    theme: stubTheme,
    getToolsExpanded: () => opts.expanded === true,
    setWidget: (_key: string, content: any) => {
      if (content === undefined) {
        disposed = true;
        return;
      }
      if (typeof content === "function") component = content({ requestRender: () => {} }, stubTheme);
      else lastLines = content;
    },
  };
  const view = mountCheckView(ui, {
    draft: opts.draft ?? "[Results]\n- measured 3.5s",
    draftTokens: 1369,
    capTokens: 13107,
    tokensBefore: 185000,
    expanded: opts.expanded === true,
  });
  return {
    view,
    lines: () => lastLines ?? [],
    render: (width = 80) => (component ? component.render(width) : []),
    click: (y: number) => component?.handleMouse({ type: "click", button: "left", x: 2, y, width: 80, height: 40 }),
    disposed: () => disposed,
  };
}

const addCall = (section: string, lines: string[]) => ({
  type: "toolCall" as const,
  id: "1",
  name: "vcc_add",
  arguments: { section, lines },
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("live check view", () => {
  test("mounts a widget and disposes it", () => {
    const h = harness();
    expect(h.render().length).toBeGreaterThan(0);
    expect(h.disposed()).toBe(false);
    h.view.dispose();
    expect(h.disposed()).toBe(true);
    // Idempotent.
    h.view.dispose();
  });

  test("collapsed by default, click expands and collapses", async () => {
    const h = harness();
    await sleep(100);
    let text = h.render().join("\n");
    expect(text).toContain("[vcc_check]");
    expect(text).toContain("Compacting 185,000 tokens");
    expect(text).toContain("to expand");
    expect(text).not.toContain("measured 3.5s");

    h.click(2);
    await sleep(100);
    text = h.render().join("\n");
    expect(text).toContain("measured 3.5s");

    h.click(2);
    await sleep(100);
    expect(h.render().join("\n")).not.toContain("measured 3.5s");
  });

  test("honours the session's expanded setting at mount", () => {
    const h = harness({ expanded: true });
    expect(h.render().join("\n")).toContain("measured 3.5s");
  });

  test("streams tool calls and reports the final counts (no frame lag, nothing dropped)", async () => {
    const h = harness({ expanded: true });
    h.view.push({ type: "start" });
    // A half-streamed argument object first: it must not throw, and it must be
    // replaced (not duplicated) once the authoritative call arrives.
    h.view.push({ type: "toolcall_start", contentIndex: 0, name: "vcc_add" });
    h.view.push({ type: "toolcall_delta", contentIndex: 0, delta: '{"section":"Key Deci' });
    await sleep(100);
    expect(h.render().join("\n")).toContain("Key Deci");

    h.view.push({ type: "toolcall_delta", contentIndex: 0, delta: 'sions","lines":["- keep it"]}' });
    h.view.push({ type: "toolcall_end", contentIndex: 0, toolCall: addCall("Key Decisions", ["- keep it"]) });
    h.view.push({ type: "done" });
    await sleep(100);

    const text = h.render().join("\n");
    expect(text).toContain("+ vcc_add [Key Decisions] 1 line");
    expect(text).toContain("- keep it");
    // The half-parsed preview is gone, not left behind next to the real thing.
    expect(text).not.toContain("Key Deci\n");
    expect(text).toContain("checked in 1 round");
    expect(text).toContain("+1/-0 lines in 1 call");
    expect(text).toContain("Compacted from 185,000 tokens");
  });

  test("counts stay stable across repeated frames of the same calls", async () => {
    const h = harness({ expanded: true });
    h.view.push({ type: "start" });
    // Distinct contentIndex per call: that is what a real stream uses, and it
    // is what keeps the two calls from being one overwritten chunk.
    const sections = ["Results", "Key Decisions"];
    for (const [i, section] of sections.entries()) {
      h.view.push({ type: "toolcall_start", contentIndex: i, name: "vcc_add" });
      h.view.push({ type: "toolcall_end", contentIndex: i, toolCall: addCall(section, [`- from ${section}`]) });
      await sleep(100);
    }
    // Several frames later the counts must not have drifted or reset.
    await sleep(200);
    let text = h.render().join("\n");
    expect(text).toContain("+2/-0 lines in 2 calls");
    expect(text).toContain("checking draft");
    expect(text).toContain("- from Key Decisions");

    h.view.push({ type: "done" });
    await sleep(100);
    text = h.render().join("\n");
    expect(text).toContain("checked in 1 round");
    expect(text).toContain("+2/-0 lines in 2 calls");
  });

  test("thinking is counted but never rendered", async () => {
    const h = harness({ expanded: true });
    h.view.push({ type: "start" });
    h.view.push({ type: "thinking_delta", contentIndex: 0, delta: "SECRET-REASONING" });
    await sleep(100);
    const text = h.render().join("\n");
    expect(text).not.toContain("SECRET-REASONING");
    expect(text).toContain("thinking");
  });

  test("a failed round says so", async () => {
    const h = harness();
    h.view.push({ type: "start" });
    h.view.push({ type: "error" });
    await sleep(100);
    expect(h.render().join("\n")).toContain("check failed");
  });

  test("the expanded body is bounded, and additions keep the space", async () => {
    const longDraft = Array.from({ length: 400 }, (_, i) => `- draft line ${i}`).join("\n");
    const h = harness({ mode: "rpc", expanded: true, draft: longDraft });
    h.view.push({ type: "start" });
    for (let i = 0; i < 200; i++) {
      h.view.push({ type: "toolcall_start", contentIndex: i, name: "vcc_add" });
      h.view.push({ type: "toolcall_end", contentIndex: i, toolCall: addCall("Results", [`- m${i}`]) });
    }
    h.view.push({ type: "done" });
    await sleep(100);

    const lines = h.lines();
    // Bounded, whatever the model wrote.
    expect(lines.length).toBeLessThanOrEqual(32);
    // The draft is elided rather than dropped silently.
    expect(lines.join("\n")).toMatch(/more draft lines|elided/);
    // The newest additions survive the truncation.
    expect(lines.join("\n")).toContain("- m199");
    expect(lines.join("\n")).toContain("earlier additions");
  });

  test("no setWidget (print mode, no TUI) is inert and never throws", () => {
    const ui: any = { mode: "print", theme: stubTheme };
    const view = mountCheckView(ui, {
      draft: "x",
      draftTokens: 1,
      capTokens: 2,
      tokensBefore: 3,
      expanded: false,
    });
    expect(() => {
      view.push({ type: "start" });
      view.push({ type: "done" });
      view.dispose();
    }).not.toThrow();
  });
});
