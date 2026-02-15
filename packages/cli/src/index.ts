#!/usr/bin/env node

import { Command } from "commander";
import { ethers } from "ethers";
import simpleGit from "simple-git";
import chalk from "chalk";

// --- CONFIGURATION ---
const RPC_URL = "http://127.0.0.1:8545";
// MAKE SURE THIS MATCHES YOUR DEPLOYED ADDRESS FROM THE PREVIOUS STEP
const CONTRACT_ADDRESS = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

// The ABI
const ABI = [
  "function postReceipt(string, string, bytes32, bytes32) external",
  "function verifyCommit(string, bytes32) external view returns (bool, tuple(string repoId, string tag, bytes32 commitHash, bytes32 artifactHash, uint64 timestamp, address signer))"
];

const git = simpleGit();
const program = new Command();

program
  .name("vmrl")
  .description("Code Release Receipts on a Public Ledger")
  .version("1.0.0");

// Helper: Convert Git SHA (20 bytes) to Bytes32 (32 bytes)
function toBytes32(text: string) {
  return ethers.zeroPadValue("0x" + text, 32);
}

// --- COMMAND: ANCHOR ---
program
  .command("anchor")
  .description("Publish a receipt")
  .option("-t, --tag <tag>", "Release tag", "latest")
  .action(async (options) => {
    try {
      console.log(chalk.blue("⚓ VMRL: Anchoring..."));

      // Check if git repo
      const isRepo = await git.checkIsRepo();
      if (!isRepo) throw new Error("Not a git repository!");

      const commitHash = await git.revparse(["HEAD"]);
      const repoId = "vmrl-demo/core"; // Hardcoded for demo simplicity

      console.log(chalk.gray(`   Repo:   ${repoId}`));
      console.log(chalk.gray(`   Commit: ${commitHash.slice(0, 7)}...`));

      // Connect
      const provider = new ethers.JsonRpcProvider(RPC_URL);
      const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
      const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet);

      console.log(chalk.yellow("⏳ Posting to Ledger..."));

      const artifactHash = ethers.id("fake-build-artifact");

      // FIX: Cast contract to 'any' to bypass TypeScript checks
      const tx = await (contract as any).postReceipt(
        repoId,
        options.tag,
        toBytes32(commitHash),
        artifactHash
      );

      console.log(chalk.green("✅ Success! Transaction Hash:"));
      console.log(chalk.white(tx.hash));

    } catch (error: any) {
      console.error(chalk.red("❌ Error:"), error.message || error);
    }
  });

// --- COMMAND: VERIFY ---
program
  .command("verify")
  .description("Verify local commit against ledger")
  .action(async () => {
    try {
      console.log(chalk.blue("🔍 VMRL: Verifying Integrity..."));

      const commitHash = await git.revparse(["HEAD"]);
      const repoId = "vmrl-demo/core";

      const provider = new ethers.JsonRpcProvider(RPC_URL);
      const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, provider);

      console.log(chalk.gray(`   Checking: ${commitHash.slice(0, 7)}...`));

      // FIX: Cast contract to 'any' here too
      // The result is [isValid, receiptStruct]
      const result = await (contract as any).verifyCommit(repoId, toBytes32(commitHash));

      const isValid = result[0];
      const receipt = result[1];

      if (isValid) {
        // Convert BigInt timestamp to readable date
        const timestamp = Number(receipt[4]);
        const date = new Date(timestamp * 1000).toLocaleString();

        console.log(chalk.greenBright("\n✅ VERIFIED: Match Found on Ledger."));
        console.log(chalk.gray(`   Signer:    ${receipt[5]}`));
        console.log(chalk.gray(`   Timestamp: ${date}`));
        console.log(chalk.gray(`   Tag:       ${receipt[1]}`));
      } else {
        console.log(chalk.redBright("\n❌ TAMPER DETECTED / UNVERIFIED"));
        console.log(chalk.red("   This commit hash does not exist on the public ledger."));
      }

    } catch (error: any) {
      console.error(chalk.red("❌ Error:"), error.message || error);
    }
  });

program.parse();
