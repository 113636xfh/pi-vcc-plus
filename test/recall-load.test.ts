/**
 * Verifies that pi-vcc's own vcc_recall tool module can be imported and returns
 * a registration function (their code, untouched).
 *
 * Point it at a pi-vcc checkout with PI_VCC_PLUS_VCC_PATH (or leave it unset to
 * use the default resolution chain).
 */
import { describe, expect, test } from "bun:test";
import { loadVccRecallTool, resolveVccDir } from "../src/vcc";

describe("upstream vcc_recall tool", () => {
  test("resolves the pi-vcc package directory", () => {
    const dir = resolveVccDir(process.env.PI_VCC_PLUS_VCC_PATH ?? null);
    console.log(`resolved pi-vcc dir: ${dir}`);
    expect(dir).toBeTruthy();
  });

  test("imports their recall module and exports registerRecallTool", async () => {
    const register = await loadVccRecallTool(process.env.PI_VCC_PLUS_VCC_PATH ?? null);
    console.log(`registerRecallTool: ${typeof register}`);
    expect(typeof register).toBe("function");
  });
});
