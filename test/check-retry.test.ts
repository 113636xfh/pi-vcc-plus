/**
 * Retrying the check request on transport failures.
 *
 * The failure this exists for: opencode-go returned a bare "Connection error."
 * mid-check, the loop failed closed, and the whole compaction was lost — the
 * session's context thrown away over a flaky socket. pi-ai resolves rather than
 * rejects on API errors, so nothing above this layer ever saw a throw to retry.
 * And unlike the Anthropic path, that provider sits behind an OpenAI-compatible
 * endpoint with no SDK-level retry underneath it, so there was nothing
 * resending the request.
 */
import { describe, expect, test } from "bun:test";
import { retryBackoffMs, transientCheckFailure } from "../src/engine";

/** pi-ai resolves with the AssistantMessage itself on API errors. */
const err = (message: string, stopReason = "error") => ({ stopReason, errorMessage: message });

describe("transientCheckFailure", () => {
  test.each([
    ["Connection error."],
    ["fetch failed"],
    ["socket hang up"],
    ["read ECONNRESET"],
    ["connect ETIMEDOUT 1.2.3.4:443"],
    ["getaddrinfo ENOTFOUND api.example.com"],
    ["terminated"],
    ["Premature close"],
    ["other side closed"],
    ["Request timed out"],
    ["429 Too Many Requests"],
    ["503 Service Unavailable"],
    ["502 Bad Gateway"],
    ["504 Gateway Timeout"],
    ["500 Internal Server Error"],
    ["529 Overloaded"],
    ["rate limited"],
  ])("retries %j", (message) => {
    expect(transientCheckFailure(err(message))).toBeTruthy();
  });

  test.each([
    ["400 MissingSessionID"],
    ["400 Bad Request: invalid api key"],
    ["401 Unauthorized"],
    ["403 Forbidden"],
    ["404 Not Found"],
    ["413 Payload Too Large"],
    ["422 Unprocessable Entity"],
    ["prompt is too long: 300000 tokens > 262144 maximum context length"],
    ["This model's maximum context length is 262144 tokens"],
  ])("does not retry %j", (message) => {
    expect(transientCheckFailure(err(message))).toBeNull();
  });

  test("a permanent status wins even when the body mentions a timeout", () => {
    // Otherwise a 400 that says "retry after timeout" would burn three
    // backoffs and then report a connection problem instead of the real cause.
    expect(transientCheckFailure(err("400 Bad Request: invalid_request_error: timeout value not allowed"))).toBeNull();
  });

  test("an unrecognised message fails closed rather than guessing", () => {
    // Wrong in this direction costs a retry; wrong in the other direction
    // silently compacts with a broken draft.
    expect(transientCheckFailure(err("boom"))).toBeNull();
    expect(transientCheckFailure(err("something went sideways"))).toBeNull();
  });

  test("an abort is never retried", () => {
    expect(transientCheckFailure({ stopReason: "aborted", errorMessage: "Connection error." })).toBeNull();
  });

  test("a successful response is not a failure at all", () => {
    expect(transientCheckFailure({ stopReason: "stop", content: [] })).toBeNull();
    expect(transientCheckFailure({ stopReason: "toolUse", content: [] })).toBeNull();
  });
});

describe("retryBackoffMs", () => {
  /** Jitter band is 0.7x..1.3x of the nominal delay. */
  const withinBand = (attempt: number, base: number) => {
    const nominal = Math.min(15000, base * 2 ** attempt);
    for (let i = 0; i < 20; i++) {
      const ms = retryBackoffMs(attempt, base, 15000);
      expect(ms).toBeGreaterThanOrEqual(Math.round(nominal * 0.7) - 1);
      expect(ms).toBeLessThanOrEqual(Math.round(nominal * 1.3) + 1);
    }
  };

  test("doubles per attempt inside the jitter band", () => {
    withinBand(0, 1000);
    withinBand(1, 1000);
    withinBand(2, 1000);
  });

  test("stays under the cap however many attempts elapse", () => {
    for (let i = 0; i < 12; i++) {
      expect(retryBackoffMs(i, 1000, 15000)).toBeLessThanOrEqual(15000 * 1.3 + 1);
    }
  });

  test("jitters, so parallel sessions do not resend in lockstep", () => {
    const seen = new Set(Array.from({ length: 24 }, () => retryBackoffMs(2, 1000, 15000)));
    expect(seen.size).toBeGreaterThan(1);
  });

  test("is monotonic across the first attempts", () => {
    expect(retryBackoffMs(0, 1000, 15000)).toBeLessThan(retryBackoffMs(3, 1000, 15000));
  });
});
