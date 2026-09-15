#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { Command } from "commander";
import { ethers } from "ethers";
import simpleGit from "simple-git";

const ABI = [
  "function postReceipt(string, string, bytes32, bytes32) external",
  "function receipts(uint256) view returns (string repoId, string tag, bytes32 commitHash, bytes32 artifactHash, uint64 timestamp, address signer)",
  "event NewReceipt(string indexed repoId, bytes32 indexed commitHash, address indexed signer, uint256 receiptId)",
];
const EXPLORERS: Record<string, string> = {
  "84532": "https://sepolia.basescan.org",
  "8453": "https://basescan.org",
  "1": "https://etherscan.io",
  "11155111": "https://sepolia.etherscan.io",
};
const EXIT = { invalid: 2, missing: 3, mismatch: 4, untrusted: 5, unavailable: 6, transaction: 7 };

class CliError extends Error {
  constructor(readonly exitCode: number, message: string) {
    super(message);
  }
}

interface ArtifactOptions { repo: string; artifact: string }
interface AnchorOptions extends ArtifactOptions { tag: string }
interface VerifyOptions extends ArtifactOptions { receipt: string; trustedSigner: string; commit?: string }

function invalid(message: string): never {
  throw new CliError(EXIT.invalid, `Invalid input: ${message}`);
}

interface Connection {
  provider: ethers.JsonRpcProvider;
  chainId: bigint;
  contractAddress: string;
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
  const network = await config.provider.getNetwork();
  if (network.chainId !== config.chainId) {
    throw new CliError(EXIT.unavailable, `Chain unavailable: configured ${config.chainId}, RPC returned ${network.chainId}`);
  }
  const block = await config.provider.getBlockNumber();
  if (await config.provider.getCode(config.contractAddress, block) === "0x") {
    throw new CliError(EXIT.unavailable, "Chain unavailable: no contract code at configured address");
  }
  console.log(`Chain: ${network.chainId} (RPC chain ID checked; block ${block})`);
  console.log(`Contract: ${config.contractAddress}`);
  return block;
}

function transactionEvidence(hash: string, chainId: bigint) {
  console.log(`Transaction: ${hash}`);
  const explorer = EXPLORERS[chainId.toString()];
  if (explorer) console.log(`Explorer: ${explorer}/tx/${hash}`);
}

async function anchor(options: AnchorOptions) {
  validateArtifactOptions(options);
  if (!options.tag.trim()) invalid("--tag cannot be empty");
  const key = process.env.VMRL_PRIVATE_KEY;
  if (!key) invalid("anchor requires VMRL_PRIVATE_KEY");
  let wallet: ethers.Wallet;
  try { wallet = new ethers.Wallet(key); } catch { return invalid("VMRL_PRIVATE_KEY is invalid"); }
  const git = simpleGit();
  let commit: string;
  try {
    if (!await git.checkIsRepo()) invalid("anchor must run in a Git working tree");
    commit = (await git.revparse(["HEAD"])).trim();
    if ((await git.raw(["status", "--porcelain", "--untracked-files=no", "--ignore-submodules=none"])).trim()) {
      invalid("tracked working tree is dirty; commit or discard tracked changes before anchoring");
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
    await checkChain(config);
    console.log(`Repository: ${options.repo}\nTag: ${options.tag}\nDeclared commit: ${declaredCommit}`);
    console.log(`Artifact: ${options.artifact}\nSHA-256: ${digest}\nPublisher: ${wallet.address}`);
    const contract = new ethers.Contract(config.contractAddress, ABI, wallet.connect(config.provider));
    const tx = await contract.getFunction("postReceipt").send(options.repo, options.tag, declaredCommit, digest);
    console.log("Submitted; waiting for a successful mined receipt...");
    transactionEvidence(tx.hash, config.chainId);
    const mined = await tx.wait(1);
    if (!mined || mined.status !== 1) throw new CliError(EXIT.transaction, "Transaction did not mine successfully");
    const event = mined.logs
      .filter((log) => log.address.toLowerCase() === config.contractAddress.toLowerCase())
      .map((log) => contract.interface.parseLog(log))
      .find((log) => log?.name === "NewReceipt" &&
        String(log.args.commitHash).toLowerCase() === declaredCommit &&
        String(log.args.signer).toLowerCase() === wallet.address.toLowerCase());
    if (!event) throw new CliError(EXIT.transaction, "Transaction mined, but expected NewReceipt event was not found");
    console.log(`Anchored: receipt ${event.args.receiptId.toString()} in block ${mined.blockNumber}`);
    transactionEvidence(mined.hash, config.chainId);
    console.log("This records publisher-declared metadata and a file digest, not proof of a source-to-build relationship or software safety.");
  } finally {
    config.provider.destroy();
  }
}

async function verify(options: VerifyOptions) {
  validateArtifactOptions(options);
  const receiptId = uint256(options.receipt, "--receipt");
  const trustedSigner = address(options.trustedSigner, "--trusted-signer");
  const expectedCommit = options.commit === undefined ? undefined : commitBytes32(options.commit);
  const digest = await digestArtifact(options.artifact);
  const config = connection();
  try {
    const block = await checkChain(config);
    // VMRL.sol declares Receipt[] public receipts as its first storage variable.
    // Read the length at the same block as the getter: an RPC/revert error is not evidence of absence.
    const count = BigInt(await config.provider.getStorage(config.contractAddress, 0, block));
    if (receiptId >= count) throw new CliError(EXIT.missing, `No receipt: ID ${receiptId} does not exist at block ${block}`);
    const contract = new ethers.Contract(config.contractAddress, ABI, config.provider);
    const receipt = await contract.getFunction("receipts").staticCall(receiptId, { blockTag: block });
    const repoMatches = receipt.repoId === options.repo;
    const commitMatches = expectedCommit === undefined || String(receipt.commitHash).toLowerCase() === expectedCommit;
    const digestMatches = String(receipt.artifactHash).toLowerCase() === digest;
    const publisherTrusted = String(receipt.signer).toLowerCase() === trustedSigner.toLowerCase();
    console.log(`Receipt ID: ${receiptId}\nRepository: ${receipt.repoId}\nTag: ${receipt.tag}`);
    console.log(`Declared commit: ${receipt.commitHash}\nTimestamp (Unix seconds): ${receipt.timestamp}`);
    console.log(`Artifact: ${options.artifact}\nLocal SHA-256: ${digest}\nRecorded SHA-256: ${receipt.artifactHash}`);
    console.log(`Repository match: ${repoMatches ? "MATCH" : "MISMATCH"}`);
    console.log(`Declared revision: ${expectedCommit === undefined ? "NOT CHECKED (supply --commit)" : commitMatches ? "MATCH" : "MISMATCH"}`);
    console.log(`Artifact integrity: ${digestMatches ? "MATCH" : "DIGEST MISMATCH"}`);
    console.log(`Receipt publisher: ${receipt.signer}\nExpected trusted signer: ${trustedSigner}`);
    console.log(`Publisher trust: ${publisherTrusted ? "MATCH (explicit trusted signer)" : "UNTRUSTED PUBLISHER"}`);
    console.log("Chain status: receipt read from configured RPC; this is not an independent consensus or finality proof.");
    console.log("A matching receipt does not prove the artifact was built from the declared source or that the software is safe.");
    if (!repoMatches || !commitMatches || !digestMatches) {
      throw new CliError(EXIT.mismatch, "NOT VERIFIED: repository, declared revision, or artifact digest mismatch");
    }
    if (!publisherTrusted) throw new CliError(EXIT.untrusted, "NOT VERIFIED: untrusted publisher");
    console.log("VERIFIED: artifact digest and requested metadata match the selected receipt from your explicitly trusted publisher.");
  } finally {
    config.provider.destroy();
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

const program = new Command().name("vmrl").description("Publish and verify SHA-256 release artifact receipts").version("1.0.0");
program.exitOverride();
program.command("anchor")
  .description("Hash a release file and publish its receipt with clean Git HEAD metadata")
  .requiredOption("--repo <owner/repo>", "Repository identity declared by publisher")
  .requiredOption("--tag <tag>", "Release label declared by publisher")
  .requiredOption("--artifact <path>", "Release file to SHA-256 hash")
  .action((options: AnchorOptions) => run(() => anchor(options)));
program.command("verify")
  .description("Read one receipt and compare a file and explicitly trusted publisher (no wallet or Git required)")
  .requiredOption("--repo <owner/repo>", "Expected repository identity")
  .requiredOption("--receipt <id>", "Exact nonnegative receipt ID")
  .requiredOption("--artifact <path>", "Local file to SHA-256 hash")
  .requiredOption("--trusted-signer <address>", "Publisher address obtained independently")
  .option("--commit <sha>", "Expected Git SHA-1 or left-zero-padded bytes32")
  .action((options: VerifyOptions) => run(() => verify(options)));
try {
  await program.parseAsync();
} catch (error) {
  process.exitCode = error instanceof Error && "exitCode" in error && error.exitCode === 0 ? 0 : EXIT.invalid;
}
