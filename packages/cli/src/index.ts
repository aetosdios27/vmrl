#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { Command } from "commander";
import { Cause, Effect, Exit, Schedule } from "effect";
import { ethers } from "ethers";
import simpleGit from "simple-git";

const ABI = [
  "function postReceipt(string, string, bytes32, bytes32) external returns (uint256)",
  "function receipts(uint256) view returns (string repoId, string tag, bytes32 commitHash, bytes32 artifactHash, uint64 timestamp, address signer)",
  "function receiptCount() view returns (uint256)",
  "function revoked(uint256) view returns (bool)",
  "function revokeReceipt(uint256) external",
  "event NewReceipt(string indexed repoId, bytes32 indexed commitHash, address indexed signer, uint256 receiptId)",
];
const EXPLORERS: Record<string, string> = {
  "84532": "https://sepolia.basescan.org",
  "8453": "https://basescan.org",
  "1": "https://etherscan.io",
  "11155111": "https://sepolia.etherscan.io",
};
const EXIT = { invalid: 2, missing: 3, mismatch: 4, untrusted: 5, unavailable: 6, transaction: 7, revoked: 8 };
const RETRY = Schedule.exponential("200 millis").pipe(Schedule.jittered, Schedule.intersect(Schedule.recurs(3)));

class CliError extends Error {
  constructor(readonly exitCode: number, message: string) {
    super(message);
  }
}

interface ArtifactOptions { repo: string; artifact: string }
interface AnchorOptions extends ArtifactOptions { tag: string; verifyTag?: boolean; json?: boolean }
interface VerifyOptions extends ArtifactOptions { receipt: string; trustedSigner: string; commit?: string; json?: boolean }
interface ListOptions { repo?: string; offset?: string; limit?: string; json?: boolean }

interface ReceiptRecord {
  repoId: string;
  tag: string;
  commitHash: string;
  artifactHash: string;
  timestamp: bigint;
  signer: string;
}

function invalid(message: string): never {
  throw new CliError(EXIT.invalid, `Invalid input: ${message}`);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface Connection {
  provider: ethers.JsonRpcProvider;
  chainId: bigint;
  contractAddress: string;
}

// Unwrap the original failure value so callers can keep classifying ethers errors precisely
// (Effect.runPromise would reject with a FiberFailure wrapper instead).
async function settle<A>(effect: Effect.Effect<A, unknown>): Promise<A> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  const failure = Cause.failureOption(exit.cause);
  if (failure._tag === "Some") throw failure.value;
  throw Cause.squash(exit.cause);
}

// Reads are retried with exponential backoff and bounded, so a flaky RPC does not abort verification.
function read<A>(thunk: () => Promise<A>): Promise<A> {
  return settle(
    Effect.tryPromise({ try: thunk, catch: (error) => error }).pipe(
      Effect.retry({ schedule: RETRY }),
      Effect.timeout("30 seconds"),
    ),
  );
}

function isMissingFunction(error: unknown): boolean {
  // `receiptCount()` and `revoked()` are plain views, so a CALL_EXCEPTION means the
  // configured contract predates them (e.g. the original deployment).
  return ethers.isError(error, "CALL_EXCEPTION");
}

function validateArtifactOptions(options: ArtifactOptions) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repo)) invalid("--repo must be owner/repo");
  if (!options.artifact.trim()) invalid("--artifact must name a file");
}

function uint256(value: string, label: string): bigint {
  if (!/^[0-9]+$/.test(value)) invalid(`${label} must be a nonnegative decimal integer`);
  const parsed = BigInt(value);
  if (parsed > ethers.MaxUint256) invalid(`${label} exceeds uint256`);
  return parsed;
}

function commitBytes32(value: string): string {
  const hex = value.replace(/^0x/i, "");
  if (/^[a-fA-F0-9]{40}$/.test(hex)) return ethers.zeroPadValue(`0x${hex.toLowerCase()}`, 32);
  if (/^0{24}[a-fA-F0-9]{40}$/.test(hex)) return `0x${hex.toLowerCase()}`;
  return invalid("commit must be a 40-hex Git SHA-1 or its left-zero-padded bytes32 value");
}

function address(value: string, label: string): string {
  try {
    const normalized = ethers.getAddress(value);
    if (normalized === ethers.ZeroAddress) invalid(`${label} cannot be the zero address`);
    return normalized;
  } catch {
    return invalid(`${label} must be a valid nonzero Ethereum address`);
  }
}

async function digestArtifact(path: string): Promise<string> {
  try {
    const file = await open(path, "r");
    try {
      const before = await file.stat({ bigint: true });
      if (!before.isFile()) invalid("artifact must be a regular file");
      const hash = createHash("sha256");
      for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk);
      const after = await file.stat({ bigint: true });
      if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
        invalid("artifact changed while hashing; retry with an immutable release file");
      }
      return `0x${hash.digest("hex")}`;
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    return invalid(`cannot read artifact ${path}: ${message(error)}`);
  }
}

function connection(): Connection {
  const rpc = process.env.VMRL_RPC_URL ?? "https://sepolia.base.org";
  try {
    const url = new URL(rpc);
    if (url.protocol !== "http:" && url.protocol !== "https:") invalid("VMRL_RPC_URL must use HTTP(S)");
  } catch {
    invalid("VMRL_RPC_URL must be a valid HTTP(S) URL");
  }
  const chainId = uint256(process.env.VMRL_CHAIN_ID ?? "84532", "VMRL_CHAIN_ID");
  if (chainId === 0n) invalid("VMRL_CHAIN_ID must be positive");
  const contractAddress = address(process.env.VMRL_CONTRACT_ADDRESS ?? "0xe0C0B432380a07177372d10DF61BAFedAB9D8367", "VMRL_CONTRACT_ADDRESS");
  const provider = new ethers.JsonRpcProvider(rpc);
  return { provider, chainId, contractAddress };
}

async function checkChain(config: Connection): Promise<number> {
  const network = await read(() => config.provider.getNetwork());
  if (network.chainId !== config.chainId) {
    throw new CliError(EXIT.unavailable, `Chain unavailable: configured ${config.chainId}, RPC returned ${network.chainId}`);
  }
  const block = await read(() => config.provider.getBlockNumber());
  if (await read(() => config.provider.getCode(config.contractAddress, block)) === "0x") {
    throw new CliError(EXIT.unavailable, "Chain unavailable: no contract code at configured address");
  }
  return block;
}

// `receiptCount()` is explicit on current deployments; slot 0 is the legacy fallback for the original one.
async function receiptCountAt(config: Connection, contract: ethers.Contract, block: number): Promise<bigint> {
  try {
    return BigInt(await contract.getFunction("receiptCount").staticCall({ blockTag: block }));
  } catch (error) {
    if (!isMissingFunction(error)) throw error;
    return BigInt(await read(() => config.provider.getStorage(config.contractAddress, 0, block)));
  }
}

async function isRevoked(contract: ethers.Contract, receiptId: bigint): Promise<boolean> {
  try {
    return Boolean(await contract.getFunction("revoked").staticCall(receiptId));
  } catch (error) {
    if (!isMissingFunction(error)) throw error;
    return false;
  }
}

function printChain(config: Connection, block: number, json: boolean) {
  if (json) return;
  console.log(`Chain: ${config.chainId} (RPC chain ID checked; block ${block})`);
  console.log(`Contract: ${config.contractAddress}`);
}

function transactionEvidence(hash: string, chainId: bigint): string | null {
  const explorer = EXPLORERS[chainId.toString()];
  return explorer ? `${explorer}/tx/${hash}` : null;
}

async function signingWallet(): Promise<ethers.BaseWallet> {
  const key = process.env.VMRL_PRIVATE_KEY;
  if (key) {
    try { return new ethers.Wallet(key); } catch { return invalid("VMRL_PRIVATE_KEY is invalid"); }
  }
  const file = process.env.VMRL_KEYSTORE_FILE;
  if (file) {
    if (process.env.VMRL_KEYSTORE_PASSWORD === undefined) invalid("VMRL_KEYSTORE_PASSWORD is required when VMRL_KEYSTORE_FILE is set");
    try {
      const json = await Bun.file(file).text();
      return await ethers.Wallet.fromEncryptedJson(json, process.env.VMRL_KEYSTORE_PASSWORD);
    } catch (error) {
      if (error instanceof CliError) throw error;
      return invalid(`cannot decrypt keystore ${file}: ${message(error)}`);
    }
  }
  return invalid("anchor requires VMRL_PRIVATE_KEY or VMRL_KEYSTORE_FILE");
}

async function anchor(options: AnchorOptions) {
  validateArtifactOptions(options);
  if (!options.tag.trim()) invalid("--tag cannot be empty");
  const json = options.json === true;
  const wallet = await signingWallet();
  const git = simpleGit();
  let commit: string;
  try {
    if (!await git.checkIsRepo()) invalid("anchor must run in a Git working tree");
    commit = (await git.revparse(["HEAD"])).trim();
    if ((await git.raw(["status", "--porcelain", "--untracked-files=no", "--ignore-submodules=none"])).trim()) {
      invalid("tracked working tree is dirty; commit or discard tracked changes before anchoring");
    }
    if (options.verifyTag) {
      let resolved: string;
      try {
        resolved = (await git.raw(["rev-list", "-n", "1", options.tag])).trim();
      } catch {
        return invalid(`--verify-tag: tag ${options.tag} does not resolve to a commit`);
      }
      if (resolved !== commit) invalid(`--verify-tag: tag ${options.tag} does not point at HEAD`);
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    return invalid(`cannot inspect Git working tree: ${message(error)}`);
  }
  const declaredCommit = commitBytes32(commit);
  const digest = await digestArtifact(options.artifact);
  // Recheck after hashing so a changed checkout is not silently labeled with the old HEAD.
  if ((await git.revparse(["HEAD"])).trim() !== commit ||
      (await git.raw(["status", "--porcelain", "--untracked-files=no", "--ignore-submodules=none"])).trim()) {
    invalid("Git working tree changed while hashing the artifact");
  }
  const config = connection();
  try {
    const block = await checkChain(config);
    printChain(config, block, json);
    if (!json) {
      console.log(`Repository: ${options.repo}\nTag: ${options.tag}\nDeclared commit: ${declaredCommit}`);
      console.log(`Artifact: ${options.artifact}\nSHA-256: ${digest}\nPublisher: ${wallet.address}`);
    }
    const contract = new ethers.Contract(config.contractAddress, ABI, wallet.connect(config.provider));
    const tx = await contract.getFunction("postReceipt").send(options.repo, options.tag, declaredCommit, digest);
    if (!json) {
      console.log("Submitted; waiting for a successful mined receipt...");
      console.log(`Transaction: ${tx.hash}`);
      const link = transactionEvidence(tx.hash, config.chainId);
      if (link) console.log(`Explorer: ${link}`);
    }
    const mined = await settle(
      Effect.tryPromise({ try: () => tx.wait(1), catch: (error) => error }).pipe(Effect.timeout("180 seconds")),
    );
    if (!mined || mined.status !== 1) throw new CliError(EXIT.transaction, "Transaction did not mine successfully");
    const event = mined.logs
      .filter((log) => log.address.toLowerCase() === config.contractAddress.toLowerCase())
      .map((log) => contract.interface.parseLog(log))
      .find((log) => log?.name === "NewReceipt" &&
        String(log.args.commitHash).toLowerCase() === declaredCommit &&
        String(log.args.signer).toLowerCase() === wallet.address.toLowerCase());
    if (!event) throw new CliError(EXIT.transaction, "Transaction mined, but expected NewReceipt event was not found");
    const result = {
      status: "anchored",
      transactionHash: tx.hash,
      blockNumber: mined.blockNumber,
      receiptId: event.args.receiptId.toString(),
      repo: options.repo,
      tag: options.tag,
      commit: declaredCommit,
      artifact: options.artifact,
      sha256: digest,
      publisher: wallet.address,
      explorer: transactionEvidence(tx.hash, config.chainId),
    };
    if (json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`Anchored: receipt ${result.receiptId} in block ${mined.blockNumber}`);
      console.log(`Transaction: ${mined.hash}`);
      const link = transactionEvidence(mined.hash, config.chainId);
      if (link) console.log(`Explorer: ${link}`);
      console.log("This records publisher-declared metadata and a file digest, not proof of a source-to-build relationship or software safety.");
    }
  } finally {
    config.provider.destroy();
  }
}

async function verify(options: VerifyOptions) {
  validateArtifactOptions(options);
  const json = options.json === true;
  const receiptId = uint256(options.receipt, "--receipt");
  const trustedSigner = address(options.trustedSigner, "--trusted-signer");
  const expectedCommit = options.commit === undefined ? undefined : commitBytes32(options.commit);
  const digest = await digestArtifact(options.artifact);
  const config = connection();
  try {
    const block = await checkChain(config);
    printChain(config, block, json);
    const contract = new ethers.Contract(config.contractAddress, ABI, config.provider);
    const count = await receiptCountAt(config, contract, block);
    if (receiptId >= count) throw new CliError(EXIT.missing, `No receipt: ID ${receiptId} does not exist at block ${block}`);
    const receipt = await read(() => contract.getFunction("receipts").staticCall(receiptId, { blockTag: block })) as unknown as ReceiptRecord;
    const revoked = await isRevoked(contract, receiptId);
    const repoMatches = receipt.repoId === options.repo;
    const commitMatches = expectedCommit === undefined || String(receipt.commitHash).toLowerCase() === expectedCommit;
    const digestMatches = String(receipt.artifactHash).toLowerCase() === digest;
    const publisherTrusted = String(receipt.signer).toLowerCase() === trustedSigner.toLowerCase();
    const result = {
      status: repoMatches && commitMatches && digestMatches && publisherTrusted && !revoked ? "verified" : "rejected",
      receiptId: receiptId.toString(),
      repository: receipt.repoId,
      tag: receipt.tag,
      commitHash: receipt.commitHash,
      timestamp: receipt.timestamp.toString(),
      artifact: options.artifact,
      localSha256: digest,
      recordedSha256: receipt.artifactHash,
      repositoryMatch: repoMatches,
      commitChecked: expectedCommit !== undefined,
      commitMatch: commitMatches,
      digestMatch: digestMatches,
      publisher: receipt.signer,
      trustedSigner,
      publisherTrusted,
      revoked,
      chainStatus: "read from configured RPC; not an independent consensus or finality proof",
    };
    if (json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`Receipt ID: ${receiptId}\nRepository: ${receipt.repoId}\nTag: ${receipt.tag}`);
      console.log(`Declared commit: ${receipt.commitHash}\nTimestamp (Unix seconds): ${receipt.timestamp}`);
      console.log(`Artifact: ${options.artifact}\nLocal SHA-256: ${digest}\nRecorded SHA-256: ${receipt.artifactHash}`);
      console.log(`Repository match: ${repoMatches ? "MATCH" : "MISMATCH"}`);
      console.log(`Declared revision: ${expectedCommit === undefined ? "NOT CHECKED (supply --commit)" : commitMatches ? "MATCH" : "MISMATCH"}`);
      console.log(`Artifact integrity: ${digestMatches ? "MATCH" : "DIGEST MISMATCH"}`);
      console.log(`Receipt publisher: ${receipt.signer}\nExpected trusted signer: ${trustedSigner}`);
      console.log(`Publisher trust: ${publisherTrusted ? "MATCH (explicit trusted signer)" : "UNTRUSTED PUBLISHER"}`);
      console.log(`Revocation: ${revoked ? "REVOKED BY SIGNER" : "not revoked"}`);
      console.log("Chain status: receipt read from configured RPC; this is not an independent consensus or finality proof.");
      console.log("A matching receipt does not prove the artifact was built from the declared source or that the software is safe.");
    }
    if (!repoMatches || !commitMatches || !digestMatches) {
      throw new CliError(EXIT.mismatch, "NOT VERIFIED: repository, declared revision, or artifact digest mismatch");
    }
    if (revoked) throw new CliError(EXIT.revoked, "NOT VERIFIED: receipt was revoked by its signer");
    if (!publisherTrusted) throw new CliError(EXIT.untrusted, "NOT VERIFIED: untrusted publisher");
    if (!json) console.log("VERIFIED: artifact digest and requested metadata match the selected receipt from your explicitly trusted publisher.");
  } finally {
    config.provider.destroy();
  }
}

async function list(options: ListOptions) {
  const json = options.json === true;
  if (options.repo !== undefined && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repo)) invalid("--repo must be owner/repo");
  const offset = options.offset === undefined ? 0n : uint256(options.offset, "--offset");
  const limit = options.limit === undefined ? 20n : uint256(options.limit, "--limit");
  if (limit === 0n || limit > 200n) invalid("--limit must be between 1 and 200");
  const config = connection();
  try {
    const block = await checkChain(config);
    printChain(config, block, json);
    const contract = new ethers.Contract(config.contractAddress, ABI, config.provider);
    const count = await receiptCountAt(config, contract, block);
    const end = offset + limit < count ? offset + limit : count;
    const records: Array<Record<string, unknown>> = [];
    for (let id = offset; id < end; id += 1n) {
      const receipt = await read(() => contract.getFunction("receipts").staticCall(id, { blockTag: block })) as unknown as ReceiptRecord;
      if (options.repo !== undefined && receipt.repoId !== options.repo) continue;
      records.push({
        id: id.toString(),
        repoId: receipt.repoId,
        tag: receipt.tag,
        commitHash: receipt.commitHash,
        artifactHash: receipt.artifactHash,
        timestamp: Number(receipt.timestamp),
        signer: receipt.signer,
        revoked: await isRevoked(contract, id),
      });
    }
    const result = { status: "listed", total: count.toString(), offset: offset.toString(), limit: limit.toString(), repo: options.repo ?? null, receipts: records };
    if (json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`Total receipts: ${count}. Showing IDs ${offset}–${end > offset ? end - 1n : offset}.`);
      for (const record of records) {
        console.log(`#${record.id} ${record.repoId} ${record.tag} ${record.signer}${record.revoked ? " [revoked]" : ""}\n   commit ${record.commitHash}\n   digest ${record.artifactHash}`);
      }
      if (records.length === 0) console.log(options.repo ? "No receipts for this repository in the scanned range." : "No receipts in the scanned range.");
    }
  } finally {
    config.provider.destroy();
  }
}

async function revoke(options: { receipt: string; json?: boolean }) {
  const json = options.json === true;
  const receiptId = uint256(options.receipt, "--receipt");
  const wallet = await signingWallet();
  const config = connection();
  try {
    const block = await checkChain(config);
    printChain(config, block, json);
    const contract = new ethers.Contract(config.contractAddress, ABI, wallet.connect(config.provider));
    const tx = await contract.getFunction("revokeReceipt").send(receiptId);
    if (!json) {
      console.log(`Submitted revocation for receipt ${receiptId}; waiting for a successful mined receipt...`);
      console.log(`Transaction: ${tx.hash}`);
    }
    const mined = await settle(
      Effect.tryPromise({ try: () => tx.wait(1), catch: (error) => error }).pipe(Effect.timeout("180 seconds")),
    );
    if (!mined || mined.status !== 1) throw new CliError(EXIT.transaction, "Transaction did not mine successfully");
    const result = { status: "revoked", receiptId: receiptId.toString(), transactionHash: tx.hash, blockNumber: mined.blockNumber, signer: wallet.address, explorer: transactionEvidence(tx.hash, config.chainId) };
    if (json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`Revoked receipt ${receiptId} in block ${mined.blockNumber}`);
      console.log(`Transaction: ${mined.hash}`);
      const link = transactionEvidence(mined.hash, config.chainId);
      if (link) console.log(`Explorer: ${link}`);
    }
  } finally {
    config.provider.destroy();
  }
}

async function run(action: () => Promise<void>) {
  try {
    await action();
  } catch (error) {
    if (error instanceof CliError) {
      console.error(error.message);
      process.exitCode = error.exitCode;
    } else if (ethers.isError(error, "TRANSACTION_REPLACED") || ethers.isError(error, "CALL_EXCEPTION") || ethers.isError(error, "ACTION_REJECTED") || ethers.isError(error, "INSUFFICIENT_FUNDS")) {
      console.error(`Contract/transaction failure (not evidence of a missing receipt): ${message(error)}`);
      process.exitCode = EXIT.transaction;
    } else {
      console.error(`RPC or operation unavailable; no verification conclusion: ${message(error)}`);
      process.exitCode = EXIT.unavailable;
    }
  }
}

const program = new Command().name("vmrl").description("Publish and verify SHA-256 release artifact receipts").version("1.1.0");
program.exitOverride();
program.command("anchor")
  .description("Hash a release file and publish its receipt with clean Git HEAD metadata")
  .requiredOption("--repo <owner/repo>", "Repository identity declared by publisher")
  .requiredOption("--tag <tag>", "Release label declared by publisher")
  .requiredOption("--artifact <path>", "Release file to SHA-256 hash")
  .option("--verify-tag", "Require --tag to resolve to the current HEAD commit")
  .option("--json", "Emit a machine-readable JSON result on stdout")
  .action((options: AnchorOptions) => run(() => anchor(options)));
program.command("verify")
  .description("Read one receipt and compare a file and explicitly trusted publisher (no wallet or Git required)")
  .requiredOption("--repo <owner/repo>", "Expected repository identity")
  .requiredOption("--receipt <id>", "Exact nonnegative receipt ID")
  .requiredOption("--artifact <path>", "Local file to SHA-256 hash")
  .requiredOption("--trusted-signer <address>", "Publisher address obtained independently")
  .option("--commit <sha>", "Expected Git SHA-1 or left-zero-padded bytes32")
  .option("--json", "Emit a machine-readable JSON result on stdout")
  .action((options: VerifyOptions) => run(() => verify(options)));
program.command("list")
  .description("List anchored receipts from the configured contract")
  .option("--repo <owner/repo>", "Only show receipts for this repository")
  .option("--offset <id>", "First receipt ID to read (default 0)")
  .option("--limit <count>", "Maximum receipts to read (default 20, max 200)")
  .option("--json", "Emit a machine-readable JSON result on stdout")
  .action((options: ListOptions) => run(() => list(options)));
program.command("revoke")
  .description("Permanently revoke a receipt (must be signed by the original publisher key)")
  .requiredOption("--receipt <id>", "Receipt ID to revoke")
  .option("--json", "Emit a machine-readable JSON result on stdout")
  .action((options: { receipt: string; json?: boolean }) => run(() => revoke(options)));
try {
  await program.parseAsync();
} catch (error) {
  process.exitCode = error instanceof Error && "exitCode" in error && error.exitCode === 0 ? 0 : EXIT.invalid;
}
