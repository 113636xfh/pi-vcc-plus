/**
 * Cold start: /compact right after /reload (or in a fresh process, or in a
 * project where the extension never saw a request) has no in-memory snapshot.
 * Before, that failed closed ("send one message first") even for a session with
 * plenty of context. Now the snapshot is rebuilt from the session itself —
 * messages from pi's own session projection, system prompt from ctx, tools from
 * pi's active tool registry — and the missing wire details are logged.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __internals } from "../src/engine";

const { rebuildSnapshotFromSession, restoreSnapshot, setToolProvider, persistSnapshot, _testSetSnapshot, _getSnapshot } =
  __internals;

const scratch = mkdtempSync(join(tmpdir(), "vcc-plus-cold-"));
const tools = [
  { name: "vcc_delete", description: "delete lines", parameters: { type: "object" } },
  { name: "vcc_add", description: "add lines", parameters: { type: "object" } },
  { name: "read", description: "read a file", parameters: { type: "object" } },
];

/** A ctx shaped like pi's: session projection + system prompt + session id. */
const ctxWith = (overrides: Record<string, unknown> = {}) => ({
  cwd: join(scratch, "p"),
  getSystemPrompt: () => "SYSTEM PROMPT",
  sessionManager: {
    getSessionId: () => "session-1",
    buildSessionProjection: () => ({
      messages: [
        { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 2 },
      ],
    }),
  },
  ...overrides,
});

beforeAll(() => {
  setToolProvider(() => tools);
});

afterAll(() => {
  setToolProvider(() => []);
  _testSetSnapshot(null);
  rmSync(scratch, { recursive: true, force: true });
});

test("rebuilds a snapshot from the session when none exists", () => {
  _testSetSnapshot(null);
  expect(rebuildSnapshotFromSession(ctxWith())).toBe(true);
  const s = _getSnapshot()!;
  expect(s.messages.length).toBe(2);
  expect(s.systemPrompt).toBe("SYSTEM PROMPT");
  expect(s.tools?.length).toBe(3);
  expect(s.toolsSource).toBe("rebuilt from the session (cold start)");
  expect(s.toolsRoundTrip).toBe("unknown");
  expect(s.prefixTokens).toBeGreaterThan(0);
  // visible evidence: the rebuilt snapshot is persisted for the next reload
  const file = join(scratch, "p", ".pi", "vcc-plus", "last-snapshot.json");
  expect(existsSync(file)).toBe(true);
  expect(JSON.parse(readFileSync(file, "utf8")).sessionId).toBe("session-1");
});

test("keeps a real snapshot instead of rebuilding over it", () => {
  _testSetSnapshot({ ..._getSnapshot()!, toolsSource: "before_provider_request.payload" });
  expect(rebuildSnapshotFromSession(ctxWith())).toBe(false);
  expect(_getSnapshot()!.toolsSource).toBe("before_provider_request.payload");
});

test("refuses to rebuild when there is nothing to rebuild from", () => {
  _testSetSnapshot(null);
  expect(rebuildSnapshotFromSession({ cwd: scratch })).toBe(false); // no sessionManager
  expect(
    rebuildSnapshotFromSession(
      ctxWith({ sessionManager: { getSessionId: () => "s", buildSessionProjection: () => ({ messages: [] }) } }),
    ),
  ).toBe(false); // empty session
  setToolProvider(() => []);
  expect(rebuildSnapshotFromSession(ctxWith())).toBe(false); // no tools → cannot patch
  setToolProvider(() => tools);
  expect(_getSnapshot()).toBeNull();
});

test("restore accepts the same session and rejects another one", () => {
  _testSetSnapshot({ ..._getSnapshot()!, toolsSource: "x" });
  persistSnapshot(join(scratch, "p"), "session-1");
  _testSetSnapshot(null);
  expect(restoreSnapshot({ cwd: join(scratch, "p"), sessionManager: { getSessionId: () => "session-2" } })).toBe(false);
  expect(_getSnapshot()).toBeNull();
  expect(restoreSnapshot({ cwd: join(scratch, "p"), sessionManager: { getSessionId: () => "session-1" } })).toBe(true);
  expect(_getSnapshot()!.toolsSource).toBe("persisted (restored after reload)");
});

test("restore falls back to a rebuild when nothing is persisted", () => {
  _testSetSnapshot(null);
  const empty = join(scratch, "empty");
  expect(restoreSnapshot({ cwd: empty, sessionManager: { getSessionId: () => "session-1" } })).toBe(false);
  expect(
    rebuildSnapshotFromSession(
      ctxWith({ cwd: empty, sessionManager: { getSessionId: () => "session-1", buildSessionProjection: () => ({ messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] }) } }),
    ),
  ).toBe(true);
  expect(_getSnapshot()!.messages.length).toBe(1);
});
