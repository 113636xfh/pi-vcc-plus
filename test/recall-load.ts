/**
 * Checks that pi-vcc's own vcc_recall tool module can be imported (their code,
 * untouched). Prints OK/FAIL plus the reason.
 *
 * Usage: bun run test/recall-load.ts [vccPackageDir]
 */
import { loadVccRecallTool } from "../src/vcc";

try {
  const register = await loadVccRecallTool(process.argv[2] ?? null);
  console.log(`OK: registerRecallTool is a ${typeof register}`);
} catch (error) {
  console.log(`FAIL: ${String(error).slice(0, 400)}`);
}
