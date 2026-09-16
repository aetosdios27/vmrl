# VMRL contracts

`src/VMRL.sol` is the on-chain receipt ledger: publishers anchor a
`(repoId, tag, commitHash, artifactHash)` tuple and anyone can read it back.

## Layout

| Path | Purpose |
| --- | --- |
| `src/VMRL.sol` | Ledger contract |
| `test/VMRL.test.ts` | Bun test suite that compiles with `solc` and exercises the real contract on Ganache |
| `script/Deploy.s.sol` | Foundry deployment script |
| `deployments.json` | Known deployments per chain |

## Interface

- `postReceipt(repoId, tag, commitHash, artifactHash)` — stores a receipt from `msg.sender` and returns its ID.
- `postReceiptWithSig(..., signer, deadline, signature)` — EIP-712 relayed receipt, so a CI key can authorize without holding gas. The signer's `nonces(signer)` must match and `deadline` must be in the future.
- `revokeReceipt(id)` — permanent revocation, callable only by the original signer.
- `receiptCount()` — explicit receipt count (the `receipts` array stays at storage slot 0 for the original deployment).
- `receipts(id)` — full receipt struct.
- `getRepoReceipts(repoId)`, `getRepoReceiptCount(repoId)`, `getRepoReceiptsPaged(repoId, offset, limit)` — per-repository reads. Prefer the paged variant for large repositories.
- `getReceiptsPaged(offset, limit)` — paged view of the whole ledger.
- `verifyCommit(repoId, commitHash)` — returns `(bool, Receipt)` and ignores revoked receipts.
- `revoked(id)`, `nonces(address)`, `domainSeparator()` — supporting state.

`Receipt[] public receipts` remains the first storage variable, so the ABI and
storage layout are unchanged from the original deployment.

## Build and test

The test suite runs under Bun and compiles the contract with the `solc` npm
package, so no Foundry install is required:

```bash
bun test packages/contracts/test/VMRL.test.ts
```

With Foundry installed:

```bash
forge build
forge fmt
```

## Deploy

```bash
PRIVATE_KEY=0x... forge script script/Deploy.s.sol:DeployVMRL \
  --rpc-url https://sepolia.base.org --broadcast
```

Record the resulting address in `deployments.json`, then point the CLI and web
app at it with `VMRL_CONTRACT_ADDRESS` / `NEXT_PUBLIC_VMRL_CONTRACT_ADDRESS`.

## Verify the source

```bash
forge verify-contract <address> src/VMRL.sol:VMRL \
  --chain 84532 --etherscan-api-key "$ETHERSCAN_API_KEY"
```

## Known deployments

| Chain | Network | Address |
| --- | --- | --- |
| 84532 | Base Sepolia | `0xe0C0B432380a07177372d10DF61BAFedAB9D8367` |

The original Base Sepolia deployment predates `receiptCount()`, revocation, and
EIP-712 relay support. The CLI falls back to storage slot 0 for the count and
treats receipts as non-revocable against that deployment.
