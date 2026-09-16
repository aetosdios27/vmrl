import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ganache from "ganache";
import { ContractFactory, JsonRpcProvider, Wallet } from "ethers";
import solc from "solc";

const cli = fileURLToPath(new URL("../index.ts", import.meta.url));
const contractSource = fileURLToPath(new URL("../../contracts/src/VMRL.sol", import.meta.url));
const CHAIN_ID = 31337;

// Minimal pre-receiptCount() contract, matching the original Base Sepolia deployment shape.
const legacySource = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract LegacyVMRL {
    struct Receipt { string repoId; string tag; bytes32 commitHash; bytes32 artifactHash; uint64 timestamp; address signer; }
    Receipt[] public receipts;
    event NewReceipt(string indexed repoId, bytes32 indexed commitHash, address indexed signer, uint256 receiptId);
    function postReceipt(string calldata _repoId, string calldata _tag, bytes32 _commitHash, bytes32 _artifactHash) external {
        uint256 newId = receipts.length;
        receipts.push(Receipt(_repoId, _tag, _commitHash, _artifactHash, uint64(block.timestamp), msg.sender));
        emit NewReceipt(_repoId, _commitHash, msg.sender, newId);
    }
}`;

const compiled = JSON.parse(
  solc.compile(
    JSON.stringify({
      language: "Solidity",
      sources: {
        "VMRL.sol": { content: readFileSync(contractSource, "utf8") },
        "LegacyVMRL.sol": { content: legacySource },
      },
      settings: {
        evmVersion: "shanghai",
        outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
      },
    }),
  ),
);
const artifact = compiled.contracts["VMRL.sol"].VMRL;
const legacyArtifact = compiled.contracts["LegacyVMRL.sol"].LegacyVMRL;

let server: { close: () => Promise<void> };
let provider: JsonRpcProvider;
let deployer: Wallet;
let environment: Record<string, string>;
let publisher: string;
let workspace: string;
let original: string;
let modified: string;

async function git(args: string[], cwd: string) {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await child.exited;
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${await new Response(child.stderr).text()}`);
}

async function cliRun(args: string[], overrides: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([Bun.which("bun")!, cli, ...args], {
    cwd: workspace,
    env: { ...process.env, ...environment, ...overrides },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

beforeAll(async () => {
  const instance = ganache.server({
    chain: { chainId: CHAIN_ID, hardfork: "shanghai" },
    wallet: { deterministic: true, totalAccounts: 2, defaultBalance: 1000 },
    logging: { quiet: true },
  });
  await new Promise<void>((resolve, reject) =>
    instance.listen(0, "127.0.0.1", (error: Error | null) => (error ? reject(error) : resolve())),
  );
  const { port } = instance.address() as { port: number };
  provider = new JsonRpcProvider(`http://127.0.0.1:${port}`, undefined, { batchMaxCount: 1, cacheTimeout: 0 });
  const secrets = Object.values(instance.provider.getInitialAccounts()).map(
    (account) => (account as { secretKey: string }).secretKey,
  );
  const wallet = new Wallet(secrets[0]!, provider);
  deployer = wallet;
  const deployed = await new ContractFactory(artifact.abi, `0x${artifact.evm.bytecode.object}`, wallet).deploy();
  await deployed.waitForDeployment();
  server = instance as unknown as { close: () => Promise<void> };
  environment = {
    VMRL_RPC_URL: `http://127.0.0.1:${port}`,
    VMRL_CHAIN_ID: String(CHAIN_ID),
    VMRL_CONTRACT_ADDRESS: await deployed.getAddress(),
    VMRL_PRIVATE_KEY: secrets[0]!,
  };
  publisher = wallet.address;

  workspace = await mkdtemp(join(tmpdir(), "vmrl-cli-"));
  original = join(workspace, "release.bin");
  modified = join(workspace, "release-modified.bin");
  writeFileSync(original, "vmrl-test-release\n");
  writeFileSync(modified, "vmrl-test-release\nmodified\n");
  await git(["init", "--quiet"], workspace);
  await git(["add", "release.bin"], workspace);
  await git(
    ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "release"],
    workspace,
  );
  // Seed receipt #0 so verification tests have a stable target.
  const seeded = await cliRun(["anchor", "--repo", "acme/app", "--tag", "v1", "--artifact", original, "--json"]);
  if (seeded.code !== 0) throw new Error(`seeding anchor failed: ${seeded.stderr}`);
});

afterAll(async () => {
  provider?.destroy();
  await server?.close();
});

test("anchor --json reports a mined receipt", async () => {
  const { code, stdout } = await cliRun(["anchor", "--repo", "acme/second", "--tag", "v2", "--artifact", original, "--json"]);
  expect(code).toBe(0);
  const result = JSON.parse(stdout);
  expect(result.status).toBe("anchored");
  expect(result.receiptId).toBe("1");
  expect(result.repo).toBe("acme/second");
});

test("verify --json passes for the trusted publisher and original bytes", async () => {
  const { code, stdout } = await cliRun([
    "verify", "--repo", "acme/app", "--receipt", "0", "--artifact", original,
    "--trusted-signer", publisher, "--json",
  ]);
  expect(code).toBe(0);
  const result = JSON.parse(stdout);
  expect(result.status).toBe("verified");
  expect(result.digestMatch).toBe(true);
  expect(result.publisherTrusted).toBe(true);
  expect(result.revoked).toBe(false);
});

test("verify exits 4 for modified bytes and still emits JSON", async () => {
  const { code, stdout } = await cliRun([
    "verify", "--repo", "acme/app", "--receipt", "0", "--artifact", modified,
    "--trusted-signer", publisher, "--json",
  ]);
  expect(code).toBe(4);
  expect(JSON.parse(stdout).digestMatch).toBe(false);
});

test("verify exits 5 for an untrusted publisher", async () => {
  const { code } = await cliRun([
    "verify", "--repo", "acme/app", "--receipt", "0", "--artifact", original,
    "--trusted-signer", "0x000000000000000000000000000000000000dEaD",
  ]);
  expect(code).toBe(5);
});

test("verify exits 3 for a missing receipt", async () => {
  const { code } = await cliRun([
    "verify", "--repo", "acme/app", "--receipt", "9999", "--artifact", original,
    "--trusted-signer", publisher,
  ]);
  expect(code).toBe(3);
});

test("verify exits 2 for an invalid commit and an invalid address", async () => {
  const badCommit = await cliRun([
    "verify", "--repo", "acme/app", "--receipt", "0", "--artifact", original,
    "--trusted-signer", publisher, "--commit", "not-a-sha",
  ]);
  expect(badCommit.code).toBe(2);
  const badAddress = await cliRun([
    "verify", "--repo", "acme/app", "--receipt", "0", "--artifact", original,
    "--trusted-signer", "not-an-address",
  ]);
  expect(badAddress.code).toBe(2);
});

test("list --json enumerates anchored receipts", async () => {
  const { code, stdout } = await cliRun(["list", "--json"]);
  expect(code).toBe(0);
  const result = JSON.parse(stdout);
  expect(result.status).toBe("listed");
  expect(Number(result.total)).toBeGreaterThanOrEqual(2);
  expect(result.receipts.some((receipt: { repoId: string }) => receipt.repoId === "acme/app")).toBe(true);
});

test("revoke --json then verify exits 8", async () => {
  const revoked = await cliRun(["revoke", "--receipt", "1", "--json"]);
  expect(revoked.code).toBe(0);
  expect(JSON.parse(revoked.stdout).status).toBe("revoked");
  const { code, stdout } = await cliRun([
    "verify", "--repo", "acme/second", "--receipt", "1", "--artifact", original,
    "--trusted-signer", publisher, "--json",
  ]);
  expect(code).toBe(8);
  expect(JSON.parse(stdout).revoked).toBe(true);
});

test("verify falls back to storage slot 0 on a legacy contract", async () => {
  const legacy = await new ContractFactory(
    legacyArtifact.abi,
    `0x${legacyArtifact.evm.bytecode.object}`,
    deployer,
  ).deploy();
  await legacy.waitForDeployment();
  const digest = `0x${createHash("sha256").update(readFileSync(original)).digest("hex")}`;
  await (
    await legacy
      .getFunction("postReceipt")("legacy/app", "v1", `0x${"11".repeat(32)}`, digest)
  ).wait();
  const { code, stdout } = await cliRun(
    ["verify", "--repo", "legacy/app", "--receipt", "0", "--artifact", original, "--trusted-signer", publisher, "--json"],
    { VMRL_CONTRACT_ADDRESS: await legacy.getAddress() },
  );
  expect(code).toBe(0);
  expect(JSON.parse(stdout).revoked).toBe(false);
  expect(JSON.parse(stdout).digestMatch).toBe(true);
});
