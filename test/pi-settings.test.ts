/**
 * Settings precedence for images.blockImages must follow pi's own rule
 * (docs/settings.md): project settings override global.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentDir } from "../src/config";
import { isBlockImagesEnabled } from "../src/pi-settings";

function writeSettings(dir: string, value: boolean) {
  const path = join(dir, ".pi", "settings.json");
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(path, JSON.stringify({ images: { blockImages: value } }));
}

function globalValue(): boolean {
  try {
    const parsed = JSON.parse(readFileSync(join(agentDir(), "settings.json"), "utf8"));
    return typeof parsed?.images?.blockImages === "boolean" ? parsed.images.blockImages : false;
  } catch {
    return false;
  }
}

const scratch = mkdtempSync(join(tmpdir(), "vcc-plus-settings-"));
const projectTrue = join(scratch, "proj-true");
const projectFalse = join(scratch, "proj-false");
const projectNone = join(scratch, "proj-none");
writeSettings(projectTrue, true);
writeSettings(projectFalse, false);

test("project blockImages:true wins over global (even when global is false)", () => {
  expect(isBlockImagesEnabled(projectTrue)).toBe(true);
});

test("project blockImages:false wins over global", () => {
  expect(isBlockImagesEnabled(projectFalse)).toBe(false);
});

test("no project settings -> falls back to the global value", () => {
  expect(isBlockImagesEnabled(projectNone)).toBe(globalValue());
});

test("no cwd at all -> global value", () => {
  expect(isBlockImagesEnabled(undefined)).toBe(globalValue());
});

test("malformed project settings -> falls back, never throws", () => {
  const broken = join(scratch, "proj-broken");
  mkdirSync(join(broken, ".pi"), { recursive: true });
  writeFileSync(join(broken, ".pi", "settings.json"), "{ not json");
  expect(isBlockImagesEnabled(broken)).toBe(globalValue());
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});
