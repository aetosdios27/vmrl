# VMRL

VMRL anchors release artifacts on an EVM chain. A publisher hashes a real release
file (SHA-256) and posts a **receipt** containing the repository label, tag,
Git `HEAD`, artifact digest, timestamp, and signer address. Anyone can later
verify a local file against one explicitly selected receipt and an independently
trusted publisher address.

Receipts record a publisher's claim; they do not prove that a binary was built
from the declared source, that it is reproducible, or that it is safe.

## Repository layout

| Path | Description |
| --- | --- |
| `packages/contracts` | `VMRL.sol` — the on-chain receipt ledger (Foundry layout) |
| `packages/cli` | Bun/TypeScript CLI for anchoring and verifying artifacts |
| `packages/web` | Next.js browser explorer and local artifact verifier |
| `scripts/demo.ts` | One-command local demo (chain + contract + sample release + web) |

## Requirements

Bun and Git. Dependencies are installed once while online:

```bash
bun install
```

## One-command local demo

From the repository root:

```bash
bun run demo
```

The launcher starts an in-memory Ganache EVM on `127.0.0.1:8545` (chain
`31337`), compiles and deploys the real `packages/contracts/src/VMRL.sol`,
builds a small sample application from a separate clean Git checkout, and
anchors it through the real CLI. It also creates a copy that differs by exactly
one appended byte, checks all verification outcomes, then opens the dashboard at
`http://127.0.0.1:3000`.

Use `bun run demo --no-open` to skip opening the browser. In another terminal,
replay the CLI scenarios while the demo runs:

```bash
bun run demo:check
```

This expects original/trusted verification to exit `0`, changed bytes `4`, an
untrusted publisher `5`, and a missing receipt `3`. `Ctrl+C` stops both
services; restarting creates a fresh chain, receipt, and sample checkout.

Everything runs on loopback after dependencies are installed. Generated files
live under the ignored `.vmrl-demo/`. Override busy ports with
`VMRL_DEMO_RPC_PORT` and `VMRL_DEMO_WEB_PORT`.

**The deterministic development wallets are publicly known. Never send real
funds to them.**

## CLI

The entry point is `packages/cli/index.ts`; run `bun run packages/cli/index.ts --help`.
Bun loads `.env` automatically. Never commit a private key.

| Environment variable | Default / purpose |
| --- | --- |
| `VMRL_RPC_URL` | `https://sepolia.base.org` |
| `VMRL_CHAIN_ID` | `84532` (Base Sepolia); checked against the RPC |
| `VMRL_CONTRACT_ADDRESS` | `0xe0C0B432380a07177372d10DF61BAFedAB9D8367` |
| `VMRL_PRIVATE_KEY` | Required only for `anchor` |

### Anchor a release

Run inside the release's Git working tree:

```bash
bun run packages/cli/index.ts anchor --repo owner/project --tag v1.2.3 --artifact /path/to/release.tar.gz
```

All options are required. The CLI streams the file through SHA-256, records Git
`HEAD`, and rejects staged or unstaged tracked changes. The transaction must
mine successfully and emit the expected `NewReceipt` event before it is reported
as anchored.

### Verify a receipt

Obtain the trusted publisher address independently, not from the receipt:

```bash
bun run packages/cli/index.ts verify --repo owner/project --receipt 12 \
  --artifact /path/to/release.tar.gz \
  --trusted-signer 0xYourIndependentlyTrustedPublisherAddress
```

Add `--commit <sha>` to also check the declared source revision. Verification
needs no private key or Git repository.

List receipts, or revoke one you published:

```bash
bun run packages/cli/index.ts list --repo owner/project
bun run packages/cli/index.ts revoke --receipt 12
```

`anchor`, `verify`, `list`, and `revoke` accept `--json` for scripting. `anchor`
also accepts `--verify-tag` to require `--tag` to resolve to `HEAD`, and can sign
from an encrypted keystore with `VMRL_KEYSTORE_FILE` + `VMRL_KEYSTORE_PASSWORD`
instead of `VMRL_PRIVATE_KEY`. `verify` fails on revoked receipts.

| Exit code | Meaning |
| --- | --- |
| 0 | Successful anchor, fully matched verification, or help/version |
| 2 | Invalid options, configuration, artifact, or Git state |
| 3 | Selected receipt does not exist |
| 4 | Repository, requested revision, or SHA-256 mismatch |
| 5 | Untrusted publisher |
| 6 | RPC/network unavailable, chain mismatch, missing contract code |
| 7 | Contract/transaction failure or missing expected mined event |
| 8 | Receipt revoked by its signer |

## Web explorer

Install dependencies from the root, then run `bun run dev` in `packages/web`
and open http://localhost:3000. Configure via public variables in
`packages/web/.env.local`:

```dotenv
NEXT_PUBLIC_VMRL_RPC_URL=https://sepolia.base.org
NEXT_PUBLIC_VMRL_CONTRACT_ADDRESS=0xe0C0B432380a07177372d10DF61BAFedAB9D8367
NEXT_PUBLIC_VMRL_CHAIN_ID=84532
```

The dashboard reads receipts from the configured RPC and hashes a selected
local file in-browser using Web Crypto. It never uploads artifact bytes and
requires no wallet. Publisher policy is an explicit user input and is never
auto-filled from the receipt.

## Contracts

`packages/contracts/src/VMRL.sol` stores a public `Receipt[] receipts` array
(storage slot 0) and a `repoId` hash index. It exposes `postReceipt`,
`getRepoReceipts`, `verifyCommit`, plus `receiptCount`, paged getters,
signer-only revocation, and EIP-712 relayed `postReceiptWithSig`. It emits
`NewReceipt`.

With Foundry installed:

```bash
forge build
forge test
```

## Development

```bash
bun test             # contract + CLI suites (compile with solc, run on local Ganache)
bun run typecheck    # CLI and demo script
bun run lint         # web ESLint
```

CI runs all three plus a production `next build` and a Foundry compile. See
`.github/workflows/ci.yml`.

## Verification model

- The digest is SHA-256 over the exact file bytes, not a filename or Git revision.
- Publisher trust is an explicit address comparison, not a reputation claim.
- Reads trust the configured RPC; one mined confirmation is not a finality guarantee.
- A matching receipt does not establish source-to-build correspondence or safety.

See `packages/cli/README.md` and `packages/web/README.md` for full details.
