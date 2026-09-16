import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ganache from "ganache";
import {
  Contract,
  ContractFactory,
  JsonRpcProvider,
  Wallet,
  zeroPadValue,
} from "ethers";
import solc from "solc";

const source = readFileSync(new URL("../src/VMRL.sol", import.meta.url), "utf8");
const compiled = JSON.parse(
  solc.compile(
    JSON.stringify({
      language: "Solidity",
      sources: { "VMRL.sol": { content: source } },
      settings: {
        evmVersion: "shanghai",
        outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
      },
    }),
  ),
);
const errors = compiled.errors?.filter(
  (entry: { severity: string }) => entry.severity === "error",
);
if (errors?.length) throw new Error(JSON.stringify(errors));
const artifact = compiled.contracts["VMRL.sol"].VMRL;
const ABI = artifact.abi;
const BYTECODE = `0x${artifact.evm.bytecode.object}`;

const CHAIN_ID = 31337;
const DOMAIN = { name: "VMRL", version: "1" };
const TYPES = {
  PostReceipt: [
    { name: "repoId", type: "string" },
    { name: "tag", type: "string" },
    { name: "commitHash", type: "bytes32" },
    { name: "artifactHash", type: "bytes32" },
    { name: "signer", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

const bytes32 = (seed: number) =>
  zeroPadValue(`0x${seed.toString(16).padStart(2, "0")}`, 32);

let server: { close: () => Promise<void> };
let provider: JsonRpcProvider;
let contract: Contract;
let signer: Wallet;
let other: Wallet;

async function revertName(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
  } catch (error) {
    return (error as { revert?: { name?: string } }).revert?.name;
  }
  return undefined;
}

async function receiptIdFrom(tx: {
  wait: () => Promise<{ logs: Array<{ address: string; topics: readonly string[]; data: string }> }>;
}): Promise<bigint> {
  const receipt = await tx.wait();
  const parsed = receipt.logs
    .filter(
      (log) => log.address.toLowerCase() === (contract.target as string).toLowerCase(),
    )
    .map((log) => contract.interface.parseLog(log as never))
    .find((entry) => entry?.name === "NewReceipt");
  return parsed!.args.receiptId as bigint;
}

beforeAll(async () => {
  const instance = ganache.server({
    chain: { chainId: CHAIN_ID, hardfork: "shanghai" },
    wallet: { deterministic: true, totalAccounts: 3, defaultBalance: 1000 },
    logging: { quiet: true },
  });
  await new Promise<void>((resolve, reject) =>
    instance.listen(0, "127.0.0.1", (error: Error | null) =>
      error ? reject(error) : resolve(),
    ),
  );
  const { port } = instance.address() as { port: number };
  provider = new JsonRpcProvider(`http://127.0.0.1:${port}`, undefined, {
    batchMaxCount: 1,
    cacheTimeout: 0,
  });
  const secrets = Object.values(instance.provider.getInitialAccounts()).map(
    (account) => (account as { secretKey: string }).secretKey,
  );
  signer = new Wallet(secrets[0]!, provider);
  other = new Wallet(secrets[1]!, provider);
  contract = await new ContractFactory(ABI, BYTECODE, signer).deploy();
  await contract.waitForDeployment();
  server = instance as unknown as { close: () => Promise<void> };
});

afterAll(async () => {
  provider?.destroy();
  await server?.close();
});

describe("postReceipt", () => {
  test("stores, indexes, counts, and emits a receipt", async () => {
    const repo = "acme/one";
    const tx = await contract.getFunction("postReceipt")(
      repo,
      "v1.0.0",
      bytes32(0x11),
      bytes32(0xaa),
    );
    const id = await receiptIdFrom(tx);
    expect(id).toBe(0n);
    expect(await contract.receiptCount()).toBe(1n);
    expect(await contract.getRepoReceiptCount(repo)).toBe(1n);

    const [repoId, tag, commitHash, artifactHash, timestamp, signerAddress] =
      await contract.receipts(0);
    expect(repoId).toBe(repo);
    expect(tag).toBe("v1.0.0");
    expect(commitHash).toBe(bytes32(0x11));
    expect(artifactHash).toBe(bytes32(0xaa));
    expect(timestamp).toBeGreaterThan(0n);
    expect(signerAddress).toBe(signer.address);
  });

  test("rejects a duplicate receipt from the same signer", async () => {
    const repo = "acme/two";
    await (
      await contract
        .getFunction("postReceipt")(repo, "v1", bytes32(0x22), bytes32(0xbb))
    ).wait();
    const name = await revertName(() =>
      contract
        .getFunction("postReceipt")
        .staticCall(repo, "v1", bytes32(0x22), bytes32(0xbb)),
    );
    expect(name).toBe("DuplicateReceipt");
  });

  test("rejects an empty artifact hash", async () => {
    const name = await revertName(() =>
      contract
        .getFunction("postReceipt")
        .staticCall("acme/three", "v1", bytes32(0x33), zeroPadValue("0x", 32)),
    );
    expect(name).toBe("EmptyArtifactHash");
  });
});

describe("paged reads", () => {
  test("paginate repo receipts and the whole ledger", async () => {
    const repo = "acme/paged";
    for (let index = 0; index < 5; index += 1) {
      await (
        await contract
          .getFunction("postReceipt")(
            repo,
            `v${index}`,
            bytes32(0x40 + index),
            bytes32(0xc0 + index),
          )
      ).wait();
    }
    const [page, total] = await contract.getFunction("getRepoReceiptsPaged")(
      repo,
      1n,
      2n,
    );
    expect(total).toBe(5n);
    expect(page.length).toBe(2);
    expect(page[0].tag).toBe("v1");
    expect(page[1].tag).toBe("v2");

    const [empty, stillTotal] = await contract.getFunction("getRepoReceiptsPaged")(
      repo,
      99n,
      2n,
    );
    expect(stillTotal).toBe(5n);
    expect(empty.length).toBe(0);

    const [globalPage, globalTotal] = await contract.getFunction("getReceiptsPaged")(
      0n,
      2n,
    );
    expect(globalPage.length).toBe(2);
    expect(globalTotal).toBe(await contract.receiptCount());
  });
});

describe("revocation", () => {
  test("only the signer can revoke and revoked receipts fail verifyCommit", async () => {
    const repo = "acme/revoke";
    const id = await receiptIdFrom(
      await contract
        .getFunction("postReceipt")(repo, "v1", bytes32(0x55), bytes32(0xdd)),
    );

    expect(
      await revertName(() =>
        contract.connect(other).getFunction("revokeReceipt").staticCall(id),
      ),
    ).toBe("NotSigner");

    const [foundBefore] = await contract.verifyCommit(repo, bytes32(0x55));
    expect(foundBefore).toBe(true);

    await (await contract.getFunction("revokeReceipt")(id)).wait();
    expect(await contract.revoked(id)).toBe(true);

    const [foundAfter] = await contract.verifyCommit(repo, bytes32(0x55));
    expect(foundAfter).toBe(false);

    expect(
      await revertName(() => contract.getFunction("revokeReceipt").staticCall(id)),
    ).toBe("AlreadyRevoked");
  });
});

describe("postReceiptWithSig (EIP-712)", () => {
  test("relays a signed receipt, increments the nonce, and blocks replay", async () => {
    const repo = "acme/signed";
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const nonce = (await contract.nonces(signer.address)) as bigint;
    const value = {
      repoId: repo,
      tag: "v9",
      commitHash: bytes32(0x66),
      artifactHash: bytes32(0xee),
      signer: signer.address,
      nonce,
      deadline,
    };
    const signature = await signer.signTypedData(
      { ...DOMAIN, chainId: CHAIN_ID, verifyingContract: await contract.getAddress() },
      TYPES,
      value,
    );

    // A different account submits (and pays gas) on the signer's behalf.
    const id = await receiptIdFrom(
      await contract
        .connect(other)
        .getFunction("postReceiptWithSig")(
          repo,
          "v9",
          value.commitHash,
          value.artifactHash,
          signer.address,
          deadline,
          signature,
        ),
    );
    expect(await contract.nonces(signer.address)).toBe(nonce + 1n);
    const [repoId, , , , , recordedSigner] = await contract.receipts(id);
    expect(repoId).toBe(repo);
    expect(recordedSigner).toBe(signer.address);

    expect(
      await revertName(() =>
        contract
          .connect(other)
          .getFunction("postReceiptWithSig")
          .staticCall(
            repo,
            "v9",
            value.commitHash,
            value.artifactHash,
            signer.address,
            deadline,
            signature,
          ),
      ),
    ).toBe("InvalidSignature");
  });

  test("rejects an expired deadline", async () => {
    const name = await revertName(() =>
      contract
        .getFunction("postReceiptWithSig")
        .staticCall(
          "acme/expired",
          "v1",
          bytes32(0x77),
          bytes32(0xff),
          signer.address,
          0n,
          new Uint8Array(65),
        ),
    );
    expect(name).toBe("DeadlineExpired");
  });
});
