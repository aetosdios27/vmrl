import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("verification without an explicit publisher policy fails as invalid input", async () => {
  const process = Bun.spawn([
    Bun.which("bun")!,
    fileURLToPath(new URL("../index.ts", import.meta.url)),
    "verify", "--repo", "owner/project", "--receipt", "0", "--artifact", "unused-artifact.bin",
  ], { stdout: "pipe", stderr: "pipe" });
  const [, , exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  expect(exitCode).toBe(2);
});
