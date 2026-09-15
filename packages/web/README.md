# VMRL browser explorer

The dashboard reads release receipts from the configured EVM RPC and verifies a selected local artifact using browser Web Crypto SHA-256. It does not upload artifact bytes or require a wallet.

## One-command local demo

Run `bun install` once from the repository root, then `bun run demo`. No wallet setup is needed. The launcher builds and anchors a real sample artifact on a local chain and opens `http://127.0.0.1:3000`.

The local-demo guide provides downloads for the original release and its one-byte-modified copy, plus public trusted/untrusted development addresses. Open receipt #0 and follow the on-page steps. Publisher policy remains an explicit user input; copying an address does not configure trust automatically. In another terminal, `bun run demo:check` replays the matching, modified, untrusted, and missing-receipt CLI scenarios.

Everything runs on loopback after dependencies are installed, including the Solidity compiler and system fonts. `Ctrl+C` stops both services; restarting rebuilds a fresh demo. The launcher supplies environment settings only to its children and uses `.next-demo` rather than the normal `.next` output. It does not rewrite `.env.local` or use a real signing key.

The artifact download route exists only when `VMRL_LOCAL_DEMO=1` and the launcher supplies its generated artifact directory; normal deployments return 404. Browser guide visibility uses `NEXT_PUBLIC_VMRL_LOCAL_DEMO=1`. Local chain status is labeled as development-chain inclusion, not public finality. Never send real funds to the public development wallets.

See `packages/cli/README.md` for port overrides and lifecycle details. For the normal public-testnet application, use the setup below instead.

## Run

Install workspace dependencies from the repository root with `bun install`, then run `bun run dev` in `packages/web`. Open http://localhost:3000.

Set these public environment variables in `packages/web/.env.local` before starting Next.js:

```dotenv
NEXT_PUBLIC_VMRL_RPC_URL=https://sepolia.base.org
NEXT_PUBLIC_VMRL_CONTRACT_ADDRESS=0xe0C0B432380a07177372d10DF61BAFedAB9D8367
NEXT_PUBLIC_VMRL_CHAIN_ID=84532
```

These are also the defaults. When `NEXT_PUBLIC_VMRL_START_BLOCK` is omitted, the browser verifies that the contract exists at the latest block, then discovers its deployment block with a binary search using historical `eth_getCode` (at most logarithmically many queries in the chain height). VMRL has no self-destruct path, so code presence is monotonic after deployment. The first history page starts there rather than requiring clicks through empty pre-deployment pages. If the RPC cannot serve historical code, discovery fails visibly: use an archive-capable RPC or set `NEXT_PUBLIC_VMRL_START_BLOCK` to the known deployment block. An explicit start block must be a nonnegative decimal number; `0` deliberately scans from genesis. Public environment variables are embedded in browser JavaScript; do not put secret RPC credentials here. Restart the dev server after changes; production builds require rebuilding.

For a local EVM node, use its browser-accessible RPC URL (for example `http://127.0.0.1:8545`), actual chain ID, deployed VMRL contract address, and deployment block. The RPC must permit browser requests (CORS). On a remote browser, localhost means the browser's machine. HTTPS pages require a compatible secure RPC endpoint. File hashing requires HTTPS or localhost. No BaseScan links are rendered for chain IDs other than Base Sepolia's 84532.

## Browse and verify

1. The first history page starts at the discovered deployment block or configured start block. **Load next history page** scans the next bounded range of at most 2,000 blocks; no rolling window hides older records. Repeat to reach the observed tip, then use **Check for newer receipts**. Empty pages are valid and do not mean the complete ledger is empty. Counts and search apply only to loaded pages. **Reload from start** rescans the configured history. RPC errors retain loaded records and the failed page can be retried without skipping it.
2. Events identify receipt IDs. Every event is hydrated using `receipts(uint256)`; indexed repository hashes are never displayed as repository names. The table and receipt dialog show real repository names, tags, declared revision, recorded artifact digest, signer, and receipt timestamps. The dialog includes the actual event transaction hash and, on Base Sepolia, a link to that transaction.
3. Choose **Verify artifact** for the exact receipt you want to check. Use the labeled file picker or drop exactly one file. SHA-256 is computed locally; the whole file is read into memory, so large artifacts may exceed browser memory. Choosing or clearing a file discards old results. Closing or switching receipts discards file and trust state and ignores unfinished hashing results.
4. Independently obtain the publisher address from a source you trust and enter it in **Trusted publisher address**. This is deliberately blank initially. Integrity and publisher trust are separate outcomes: matching bytes alone are not overall verification. Changing the address immediately updates the trust result.
5. **Copy CLI command** invokes `bun run packages/cli/index.ts verify` from the repository root and includes this RPC, contract, chain, repository, and explicit receipt ID. Replace `<artifact-path>` and `<trusted-signer-address>` yourself. It never automatically treats the receipt signer as trusted. Clipboard failures expose the command for manual selection.

Chain status uses the RPC's actual `safe` and `finalized` block tags. Unsupported or failing tags produce a visible warning and retry control; elapsed time and block age never imply finality. Status is a snapshot at the last history request, not a live monitor, and reflects the configured RPC's chain view.

A successful artifact check means the file digest matches this receipt and its signer matches your supplied policy. A receipt records a publisher claim: it does not prove source-to-build correspondence or software safety. Chain finality is separate from those checks.
