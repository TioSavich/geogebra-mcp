// End-to-end smoke test that exercises the driver directly (no MCP transport).
// Run with: npm run smoke
//
// Verifies:
//   1. Browser/applet boot
//   2. evalCommand round-trip
//   3. CAS
//   4. PNG export
//   5. .ggb save and reload
//
// Exits non-zero on any failure.

import { GeoGebraDriver } from "../src/geogebra.js";
import { writeFile } from "node:fs/promises";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok  — ${msg}`);
}

async function main() {
  console.log("Booting headless GeoGebra…");
  const driver = new GeoGebraDriver({ app: "suite" });
  await driver.start();
  console.log(`GeoGebra version: ${await driver.getVersion()}`);

  // 1. evalCommand
  const okCmd = await driver.runCommand("A = (1, 2)");
  assert(okCmd, "evalCommand A=(1,2) accepted");
  const xA = await driver.getXcoord("A");
  assert(Math.abs(xA - 1) < 1e-9, `A.x === 1 (got ${xA})`);

  const labels = await driver.runCommandGetLabels("Circle(A, 3)");
  assert(labels.length > 0, `Circle returned labels (${labels.join(",")})`);

  // 2. Function plot
  await driver.runCommand("f(x) = sin(x) + x/4");
  const objs = await driver.getAllObjectNames();
  assert(objs.includes("f"), `objects contain f (${objs.join(",")})`);

  // 3. CAS
  const casOut = await driver.cas("Solve(x^2 - 5x + 6 = 0, x)");
  assert(casOut.length > 0 && casOut !== "?", `CAS returned real result: ${casOut}`);
  assert(casOut.includes("2") && casOut.includes("3"), `CAS solution contains 2 and 3: ${casOut}`);
  console.log(`    CAS: ${casOut}`);

  // 4. PNG export
  const png = await driver.exportPNG(1, false, 72);
  assert(png.length > 1000, `PNG base64 length > 1000 (got ${png.length})`);

  // 5. .ggb round trip
  const ggb = await driver.getBase64();
  assert(ggb.length > 100, `.ggb base64 non-empty (${ggb.length} chars)`);
  await writeFile("test-output/smoke.ggb", Buffer.from(ggb, "base64")).catch(async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir("test-output", { recursive: true });
    await writeFile("test-output/smoke.ggb", Buffer.from(ggb, "base64"));
  });

  await driver.newConstruction();
  const empty = await driver.getAllObjectNames();
  assert(empty.length === 0, `cleared (${empty.length} objects)`);

  const loaded = await driver.setBase64(ggb);
  assert(loaded, "reloaded .ggb");
  const after = await driver.getAllObjectNames();
  assert(after.includes("A") && after.includes("f"), `reload restored A and f (${after.join(",")})`);

  await driver.stop();
  console.log("\nAll smoke checks passed.");
}

main().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
