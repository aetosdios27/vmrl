# VMRL CLI

Publish a SHA-256 digest of a real release file, or verify a local file against one explicitly selected on-chain receipt and an independently trusted publisher address.

## Reliable local presentation demo

From the repository root:

```bash
bun install
bun run demo
```

Install dependencies once while online. After that, startup, Solidity compilation, the sample build, blockchain transactions, and browser verification run locally; no faucet, wallet extension, external fonts, or public RPC is required. Bun and Git must be installed.

The launcher starts an in-memory Ganache EVM on `127.0.0.1:8545` (chain `31337`), compiles and deploys the actual `packages/contracts/src/VMRL.sol`, builds a small sample application from a separate clean Git checkout, and anchors it through the real CLI. It also creates a copy with exactly one appended byte. It checks all four verification outcomes before starting the dashboard at `http://127.0.0.1:3000` and opening your browser. Use `bun run demo --no-open` to skip opening the browser.

The dashboard's local-demo guide provides artifact downloads and two public publisher addresses. Verify the original with the trusted address, replace the file with the modified copy, then restore the original and use the untrusted address. Trust is never automatically filled from the receipt.

In another terminal, replay the CLI scenarios:

```bash
bun run demo:check
```

This expects original/trusted verification to exit `0`, changed bytes `4`, an untrusted publisher `5`, and a missing receipt `3`. Any unexpected outcome fails the command. The demo must remain running.

`Ctrl+C` stops the web server and blockchain. Restarting creates a fresh chain, receipt #0, and sample checkout. Generated files and the current session manifest live under ignored `.vmrl-demo/`; the separate web cache is `packages/web/.next-demo/`. Main-checkout changes do not block the demo, and existing `.env` files and wallet settings are not rewritten.

Both services bind only to loopback. Busy ports fail explicitly; override them with `VMRL_DEMO_RPC_PORT` and `VMRL_DEMO_WEB_PORT`. Ganache deliberately uses its portable JavaScript transport; its fallback/performance notice is informational, not a failed blockchain startup.

**These deterministic development wallets are publicly known. Never send real funds to them.** This demonstrates the real contract on a local EVM, not a public-testnet transaction or public consensus/finality.

## Install and configure

From `packages/cli`, run `bun install`. The entry point is `bun run index.ts`; `bun run index.ts --help` lists commands. Bun loads `.env` automatically. Never commit a private key.

| Environment variable | Default / purpose |
| --- | --- |
| `VMRL_RPC_URL` | `https://sepolia.base.org` |
| `VMRL_CHAIN_ID` | `84532` (Base Sepolia); checked against the RPC before reading or writing |
| `VMRL_CONTRACT_ADDRESS` | `0xe0C0B432380a07177372d10DF61BAFedAB9D8367` |
| `VMRL_PRIVATE_KEY` | Required only for `anchor`; funded publisher wallet on the selected chain |

Use all three network settings for a different deployment. The configured address must contain the unchanged VMRL contract, not an arbitrary contract or proxy. Receipt absence detection depends on this contract's `Receipt[] public receipts` array occupying storage slot 0. The CLI checks that contract code exists, then reads array length and the exact receipt at the same block; an RPC error or contract revert is not reported as a missing receipt. Code presence does not authenticate the deployment: choose the contract and RPC independently.

## Anchor a release artifact

Run inside the release's Git working tree (use the absolute CLI entry path if the release lives elsewhere):

```bash
bun run index.ts anchor --repo owner/project --tag v1.2.3 --artifact /path/to/release.tar.gz
```

All three options are required. The CLI streams the file through SHA-256, records Git `HEAD` as a left-zero-padded bytes32 SHA-1, and rejects staged or unstaged tracked changes. Untracked release files are allowed; they are not proof of a reproducible build. It checks the file for changes during hashing and rechecks Git afterward. Keep the release file and checkout unchanged for the operation. Git SHA-256 repositories are not supported.

The command prints the actual transaction hash, waits for successful mining (one confirmation), and extracts the receipt ID from `NewReceipt`. Save that ID. Known networks also get the actual transaction explorer URL; custom networks do not get a guessed link. A submitted transaction alone is not reported as anchored.

`--repo` and `--tag` are publisher-declared labels, not inferred or authenticated Git remotes/tags. The tag does not have to exist as a Git ref.

## Verify an explicitly selected receipt

Obtain the publisher's trusted address independently, not from the receipt being checked. Replace the example values with your artifact, receipt ID and trusted address:

```bash
bun run index.ts verify --repo owner/project --receipt 12 --artifact /path/to/release.tar.gz --trusted-signer 0xYourIndependentlyTrustedPublisherAddress
```

Optionally check the declared source revision:

```bash
bun run index.ts verify --repo owner/project --receipt 12 --artifact /path/to/release.tar.gz --trusted-signer 0xYourIndependentlyTrustedPublisherAddress --commit 0123456789abcdef0123456789abcdef01234567
```

`--commit` accepts a 40-hex Git SHA-1 (optional `0x`) or its left-zero-padded 32-byte form. Verification needs neither a private key nor a Git repository. `--trusted-signer` is mandatory: without an explicitly selected publisher the CLI cannot report overall verification. It reads `receipts(id)` directly, never the first receipt matching a commit.

Output separates chain/RPC status, repository and optional revision matches, file integrity, and publisher trust. Overall success means the local SHA-256 and requested metadata match the selected receipt signed by the supplied trusted address. If multiple checks fail, all results are printed; a metadata/digest mismatch takes precedence over publisher mismatch in the exit code.

| Exit code | Meaning |
| --- | --- |
| 0 | Successful anchor, fully matched verification, or help/version |
| 2 | Invalid options, configuration, artifact, or Git state |
| 3 | Selected receipt does not exist |
| 4 | Repository, requested revision, or SHA-256 mismatch |
| 5 | Untrusted publisher |
| 6 | RPC/network unavailable, chain mismatch, missing contract code, or other operation failure |
| 7 | Contract/transaction failure, reverted/replaced transaction, or missing expected mined event |

## Limits

SHA-256 is calculated over the exact file bytes, not a filename, Git revision, or synthetic placeholder. A matching digest detects different bytes relative to the receipt; a mismatch alone does not establish malicious tampering. Publisher trust is an explicit address comparison, not a claim that the signer is reputable or that the repository belongs to them. Blockchain receipts do not prove that a binary was built from the declared source, that a release is safe, or that it is reproducible. Reads trust the configured RPC; one mined confirmation is not a finality guarantee.
