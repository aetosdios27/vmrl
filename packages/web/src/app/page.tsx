"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPublicClient, http, isAddress, parseAbiItem } from "viem";
import { StaleGuard, checkRevocation, overallVerdict, revocationDisplay, type RevocationStatus, type RevocationReader } from "./revocation";

const CONTRACT_ADDRESS = process.env.NEXT_PUBLIC_VMRL_CONTRACT_ADDRESS || "0xe0C0B432380a07177372d10DF61BAFedAB9D8367";
const CHAIN_ID = Number(process.env.NEXT_PUBLIC_VMRL_CHAIN_ID || "84532");
const RPC_URL = process.env.NEXT_PUBLIC_VMRL_RPC_URL || "https://sepolia.base.org";
const START_BLOCK_TEXT = process.env.NEXT_PUBLIC_VMRL_START_BLOCK;
const LOCAL_DEMO = process.env.NEXT_PUBLIC_VMRL_LOCAL_DEMO === "1";
const LOG_RANGE = BigInt(2000);
const MAX_HASH_BYTES = 256 * 1024 * 1024;
const rpcClient = createPublicClient({ transport: http(RPC_URL, { retryCount: 3, retryDelay: 300 }) });
const eventAbi = parseAbiItem("event NewReceipt(string indexed repoId, bytes32 indexed commitHash, address indexed signer, uint256 receiptId)");
const receiptAbi = [parseAbiItem("function receipts(uint256) view returns (string repoId, string tag, bytes32 commitHash, bytes32 artifactHash, uint64 timestamp, address signer)")];
type Receipt = {
  repoId: string; tag: string; commitHash: string; artifactHash: string;
  timestamp: bigint; signer: string; id: string; blockNumber: bigint; transactionHash: string;
};
type Heads = { latest: bigint; safe: bigint | null; finalized: bigint | null };

function chainStatus(blockNumber: bigint, heads: Heads) {
  if (LOCAL_DEMO) return "Included on local development chain";
  if (heads.finalized !== null && blockNumber <= heads.finalized) return "Finalized (RPC)";
  if (heads.safe !== null && blockNumber <= heads.safe) return "Safe (RPC)";
  return "Included · finality not established";
}

function timeAgo(timestamp: bigint, now: number): string {
  const s = Math.max(0, Math.floor(now / 1000) - Number(timestamp));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

// Quote on-chain strings as data, never shell syntax.
function shellQuote(value: string) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

function hashInWorker(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./hash.worker.ts", import.meta.url));
    const timer = setTimeout(() => { worker.terminate(); reject(new Error("Hashing worker timed out.")); }, 120000);
    worker.onmessage = (event: MessageEvent<{ ok: boolean; hex?: string; error?: string }>) => {
      clearTimeout(timer);
      worker.terminate();
      if (event.data.ok && event.data.hex) resolve(event.data.hex);
      else reject(new Error(event.data.error ?? "Hashing worker failed."));
    };
    worker.onerror = () => { clearTimeout(timer); worker.terminate(); reject(new Error("Hashing worker failed to start.")); };
    worker.postMessage(file);
  });
}

// Prefer a worker so hashing never blocks rendering; fall back to the main thread.
async function hashFile(file: File): Promise<string> {
  if (file.size > MAX_HASH_BYTES) {
    throw new Error(`Artifact exceeds the ${Math.floor(MAX_HASH_BYTES / (1024 * 1024))} MB in-browser limit. Verify it with the CLI instead.`);
  }
  if (typeof Worker !== "undefined") {
    try { return await hashInWorker(file); } catch { /* fall back below */ }
  }
  const bytes = await file.arrayBuffer();
  const hash = await window.crypto.subtle.digest("SHA-256", bytes);
  return "0x" + Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}

function ReceiptModal({ receipt, heads, onClose }: { receipt: Receipt; heads: Heads; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const generation = useRef({ value: 0 });
  const [file, setFile] = useState<File | null>(null);
  const [digest, setDigest] = useState("");
  const [hashing, setHashing] = useState(false);
  const [error, setError] = useState("");
  const [trustedSigner, setTrustedSigner] = useState("");
  const [copyStatus, setCopyStatus] = useState("");
  const [revocation, setRevocation] = useState<RevocationStatus | null>(null);
  const staleGuard = useRef<StaleGuard>(new StaleGuard());

  useEffect(() => {
    const element = dialog.current!;
    const token = generation.current;
    element.showModal();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      token.value++;
      element.close();
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  const chooseFile = async (selected: File | null) => {
    const token = generation.current;
    const current = ++token.value;
    setFile(selected);
    setDigest("");
    setError("");
    setHashing(false);
    if (!selected) return;
    setHashing(true);
    try {
      if (!window.crypto?.subtle) throw new Error("Web Crypto is unavailable. Open this page over HTTPS or localhost.");
      const computed = await hashFile(selected);
      if (current !== token.value) return;
      setDigest(computed);
    } catch (cause) {
      if (current === token.value) setError(`Could not hash artifact: ${errorMessage(cause)}`);
    } finally {
      if (current === token.value) setHashing(false);
    }
  };

  useEffect(() => {
    const guard = staleGuard.current;
    const token = guard.begin();
    setRevocation(null);
    void checkRevocation(rpcClient as unknown as RevocationReader, CHAIN_ID, CONTRACT_ADDRESS, BigInt(receipt.id)).then(status => {
      if (guard.isCurrent(token)) setRevocation(status);
    });
    return () => { guard.begin(); };
  }, [receipt.id]);

  const policy = trustedSigner.trim();
  const validPolicy = isAddress(policy);
  const integrityMatches = digest !== "" && digest === receipt.artifactHash.toLowerCase();
  const signerMatches = validPolicy && policy.toLowerCase() === receipt.signer.toLowerCase();
  const revocationDisplayState = revocationDisplay(revocation);
  const revokedReceipt = revocation?.kind === "revoked";
  const verdict = overallVerdict(integrityMatches, signerMatches, revocation);
  const verdictText = revokedReceipt
    ? "REVOKED — NOT VERIFIED"
    : verdict
      ? "Verified against this receipt and your publisher policy, with revocation checked on-chain."
      : revocation?.kind === "unknown"
        ? "Revocation status could not be determined from the RPC; without a revocation result the artifact is NOT VERIFIED."
        : revocation?.kind === "legacy"
          ? integrityMatches && signerMatches
            ? "Verified against this receipt and your publisher policy. This registered legacy deployment has no revocation support."
            : "Artifact not verified against integrity, publisher policy, and the legacy no-revocation status."
          : "Artifact not verified against integrity and publisher policy, and revocation status.";
  const command = `VMRL_RPC_URL=${shellQuote(RPC_URL)} VMRL_CONTRACT_ADDRESS=${shellQuote(CONTRACT_ADDRESS)} VMRL_CHAIN_ID=${CHAIN_ID} bun run packages/cli/index.ts verify --repo ${shellQuote(receipt.repoId)} --receipt ${receipt.id} --artifact '<artifact-path>' --trusted-signer '<trusted-signer-address>'`;

  return (
    <dialog ref={dialog} className="receipt-dialog" aria-labelledby="receipt-title" onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="modal-content">
        <header className="modal-header">
          <div><p className="eyebrow">Receipt #{receipt.id}</p><h2 id="receipt-title">{receipt.repoId}</h2><p>{receipt.tag}</p></div>
          <button type="button" onClick={onClose} aria-label="Close receipt">Close</button>
        </header>
        <section className="verification" aria-labelledby="verify-title">
          <h3 id="verify-title">Verify a release artifact</h3>
          <p>Your file stays on this device. SHA-256 is computed locally with Web Crypto; no upload. The entire file is read into browser memory.</p>
          <div className="drop-zone" onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }} onDrop={event => {
            event.preventDefault();
            if (event.dataTransfer.files.length !== 1) {
              void chooseFile(null);
              setError("Drop exactly one artifact file.");
              return;
            }
            void chooseFile(event.dataTransfer.files[0]);
          }}>
            <label htmlFor="artifact-file">Choose an artifact or drop one file here</label>
            <input id="artifact-file" type="file" onChange={event => { void chooseFile(event.target.files?.[0] ?? null); event.target.value = ""; }} />
            {file && <p>{file.name} · {file.size.toLocaleString()} bytes <button type="button" onClick={() => void chooseFile(null)}>Clear file</button></p>}
          </div>
          <label htmlFor="trusted-signer">Trusted publisher address (your independent policy)</label>
          <input id="trusted-signer" className="text-input" value={trustedSigner} onChange={event => setTrustedSigner(event.target.value)} spellCheck={false} autoComplete="off" placeholder="0x… — obtain from a trusted source" aria-describedby="trust-help" aria-invalid={policy !== "" && !validPolicy} />
          <p id="trust-help">Enter an address you already trust. The receipt signer is not automatically trusted.</p>
          <div aria-live="polite" aria-atomic="true" className="outcomes">
            <dl className="receipt-fields">
              <div><dt>Recorded SHA-256</dt><dd><code>{receipt.artifactHash}</code></dd></div>
              <div><dt>Computed SHA-256</dt><dd><code>{hashing ? "Hashing locally…" : digest || "Select an artifact"}</code></dd></div>
              <div><dt>Artifact integrity</dt><dd className={digest ? integrityMatches ? "success" : "failure" : ""}>{hashing ? "Checking…" : !digest ? "Not checked" : integrityMatches ? "MATCH — file digest equals this receipt" : "MISMATCH — file differs from this receipt"}</dd></div>
              <div><dt>Publisher trust</dt><dd className={policy ? signerMatches ? "success" : "failure" : ""}>{!policy ? "NOT CONFIGURED — no trusted publisher supplied" : !validPolicy ? "INVALID POLICY — enter a valid Ethereum address" : signerMatches ? "TRUSTED — signer matches your supplied address" : "UNTRUSTED — signer does not match your supplied address"}</dd></div>
              <div><dt>Revocation status — on-chain, independent of integrity and publisher trust</dt><dd className={revocationDisplayState.tone === "success" ? "success" : revocationDisplayState.tone === "failure" ? "failure" : ""}>{revocationDisplayState.text}</dd></div>
            </dl>
            <p className={verdict ? "success" : revokedReceipt ? "failure" : ""}>{verdictText}</p>
          </div>
          {error && <p role="alert" className="failure">{error}</p>}
          <p className="boundary">A receipt records a publisher’s claim. It does not prove the artifact was built from the declared source, or that the software is safe.</p>
        </section>
        <dl className="receipt-fields">
          <div><dt>Declared revision (bytes32)</dt><dd><code>{receipt.commitHash}</code></dd></div>
          <div><dt>Recorded artifact SHA-256</dt><dd><code>{receipt.artifactHash}</code></dd></div>
          <div><dt>Receipt signer</dt><dd><code>{receipt.signer}</code></dd></div>
          <div><dt>Anchored at</dt><dd><time dateTime={new Date(Number(receipt.timestamp) * 1000).toISOString()}>{new Date(Number(receipt.timestamp) * 1000).toUTCString()}</time></dd></div>
          <div><dt>Chain status — independent of artifact verification</dt><dd>{chainStatus(receipt.blockNumber, heads)} · block {receipt.blockNumber.toString()}</dd></div>
          <div><dt>Anchor transaction</dt><dd><code>{receipt.transactionHash}</code></dd></div>
        </dl>
        <div className="modal-actions">
          {CHAIN_ID === 84532 && <a href={`https://sepolia.basescan.org/tx/${receipt.transactionHash}`} target="_blank" rel="noreferrer">View transaction on BaseScan</a>}
          <button type="button" onClick={async () => {
            try { await navigator.clipboard.writeText(command); setCopyStatus("Command copied. Replace both artifact and trusted signer placeholders."); }
            catch (cause) { setCopyStatus(`Clipboard failed: ${errorMessage(cause)}. Select the command below manually.`); }
          }}>Copy CLI command</button>
        </div>
        <p>Run this command from the repository root after replacing both placeholders.</p>
        <pre className="command"><code>{command}</code></pre>
        <p role="status">{copyStatus}</p>
      </div>
    </dialog>
  );
}

function DemoGuide() {
  const [copyStatus, setCopyStatus] = useState("");
  const publishers = [
    { label: "Trusted demo publisher", address: process.env.NEXT_PUBLIC_VMRL_DEMO_PUBLISHER },
    { label: "Untrusted demo publisher", address: process.env.NEXT_PUBLIC_VMRL_DEMO_OTHER_PUBLISHER },
  ];
  return (
    <section className="demo-guide" aria-labelledby="demo-title">
      <p className="eyebrow">Local demonstration · no real funds</p>
      <h2 id="demo-title">Try the complete verification flow</h2>
      <p>The real VMRL contract runs on a local EVM. These public development identities are deliberately separate from the receipt you verify. Never send real funds to them.</p>
      <ol>
        <li>Download the <a href="/api/demo/artifact?variant=original" download>original release</a> and <a href="/api/demo/artifact?variant=modified" download>one-byte-modified release</a>.</li>
        <li>Open receipt #0 below. Choose the original release and enter the trusted demo publisher: both checks pass.</li>
        <li>Choose the modified release: integrity fails. Restore the original and enter the untrusted address: publisher trust fails.</li>
      </ol>
      <div className="demo-publishers">
        {publishers.map(publisher => (
          <div key={publisher.label}>
            <strong>{publisher.label}</strong>
            <code>{publisher.address}</code>
            <button type="button" onClick={async () => {
              try {
                if (!publisher.address) throw new Error("Restart the demo launcher to configure public test identities.");
                await navigator.clipboard.writeText(publisher.address);
                setCopyStatus(`${publisher.label} copied. Paste it into the verification form yourself.`);
              } catch {
                setCopyStatus("Clipboard unavailable. Select and copy the address above manually.");
              }
            }}>Copy {publisher.label.toLowerCase()}</button>
          </div>
        ))}
      </div>
      <p role="status">{copyStatus}</p>
      <p>Terminal demonstration: <code>bun run demo:check</code>. Restart <code>bun run demo</code> for a fresh chain. Local inclusion is not public-chain finality.</p>
    </section>
  );
}

export default function Home() {
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [heads, setHeads] = useState<Heads>({ latest: BigInt(0), safe: null, finalized: null });
  const [nextBlock, setNextBlock] = useState<bigint | null>(null);
  const [scanned, setScanned] = useState<{ from: bigint; to: bigint } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [headWarning, setHeadWarning] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Receipt | null>(null);
  const [direction, setDirection] = useState<"asc" | "desc">("desc");
  const [now, setNow] = useState(0);
  const busy = useRef(false);
  const alive = useRef(true);
  const requestedFrom = useRef<bigint | null>(null);

  const loadPage = useCallback(async (from: bigint | null) => {
    if (busy.current) return;
    busy.current = true;
    setLoading(true);
    requestedFrom.current = from;
    setError("");
    try {
      if (!isAddress(CONTRACT_ADDRESS)) throw new Error("NEXT_PUBLIC_VMRL_CONTRACT_ADDRESS must be a valid address.");
      if (!Number.isSafeInteger(CHAIN_ID) || CHAIN_ID < 1) throw new Error("NEXT_PUBLIC_VMRL_CHAIN_ID must be a positive integer.");
      if (START_BLOCK_TEXT !== undefined && !/^\d+$/.test(START_BLOCK_TEXT)) throw new Error("NEXT_PUBLIC_VMRL_START_BLOCK must be a nonnegative decimal block number.");
      const actualChain = await rpcClient.getChainId();
      if (actualChain !== CHAIN_ID) throw new Error(`RPC chain ${actualChain} does not match configured chain ${CHAIN_ID}.`);
      const latest = await rpcClient.getBlockNumber({ cacheTime: 0 });
      const [safe, finalized] = await Promise.allSettled([
        rpcClient.getBlock({ blockTag: "safe" }), rpcClient.getBlock({ blockTag: "finalized" }),
      ]);
      if (!alive.current) return;
      setHeads({ latest, safe: safe.status === "fulfilled" ? safe.value.number : null, finalized: finalized.status === "fulfilled" ? finalized.value.number : null });
      setHeadWarning([safe.status === "rejected" ? `Safe tag unavailable: ${errorMessage(safe.reason)}` : "", finalized.status === "rejected" ? `Finalized tag unavailable: ${errorMessage(finalized.reason)}` : ""].filter(Boolean).join("\n"));
      let start = from;
      if (start === null) {
        const latestCode = await rpcClient.getCode({ address: CONTRACT_ADDRESS, blockNumber: latest });
        if (!latestCode || latestCode === "0x") throw new Error("No contract code at the configured address on this chain.");
        if (START_BLOCK_TEXT !== undefined) {
          start = BigInt(START_BLOCK_TEXT);
        } else {
          // VMRL has no self-destruct path: code presence is monotonic after deployment.
          let low = BigInt(0);
          let high = latest;
          try {
            while (low < high) {
              const middle = low + (high - low) / BigInt(2);
              const code = await rpcClient.getCode({ address: CONTRACT_ADDRESS, blockNumber: middle });
              if (code && code !== "0x") high = middle;
              else low = middle + BigInt(1);
              if (!alive.current) return;
            }
          } catch (cause) {
            throw new Error(`Deployment discovery needs historical eth_getCode. Set NEXT_PUBLIC_VMRL_START_BLOCK to the known deployment block or use an archive-capable RPC. ${errorMessage(cause)}`);
          }
          start = low;
        }
      }
      if (start > latest) {
        setNextBlock(start);
        if (from === null) throw new Error(`Start block ${start} is ahead of latest block ${latest}. Check configuration or retry once the chain advances.`);
        return;
      }
      const end = start + LOG_RANGE - BigInt(1) < latest ? start + LOG_RANGE - BigInt(1) : latest;
      const logs = await rpcClient.getLogs({ address: CONTRACT_ADDRESS, event: eventAbi, fromBlock: start, toBlock: end, strict: true });
      const page: Receipt[] = [];
      const entries = logs.map(log => {
        if (log.blockNumber === null || log.transactionHash === null) throw new Error("RPC returned a pending event for a historical range.");
        return { id: log.args.receiptId as bigint, blockNumber: log.blockNumber, transactionHash: log.transactionHash };
      });
      const build = (record: readonly unknown[], entry: (typeof entries)[number]): Receipt => {
        const [repoId, tag, commitHash, artifactHash, timestamp, signer] = record as [string, string, `0x${string}`, `0x${string}`, bigint, string];
        return { repoId, tag, commitHash, artifactHash, timestamp, signer, id: entry.id.toString(), blockNumber: entry.blockNumber, transactionHash: entry.transactionHash };
      };
      // Public chains hydrate in one Multicall3 eth_call; the local demo has no Multicall3 and reads in bounded batches.
      let hydrated = false;
      if (!LOCAL_DEMO && entries.length > 0) {
        try {
          const results = await rpcClient.multicall({ contracts: entries.map(entry => ({ address: CONTRACT_ADDRESS, abi: receiptAbi, functionName: "receipts" as const, args: [entry.id] })), allowFailure: false });
          results.forEach((record, index) => page.push(build(record as readonly unknown[], entries[index]!)));
          hydrated = true;
        } catch {
          // Fall back to bounded individual reads below.
        }
      }
      if (!hydrated) {
        for (let offset = 0; offset < entries.length; offset += 8) {
          const batch = await Promise.all(entries.slice(offset, offset + 8).map(async entry => build(await rpcClient.readContract({ address: CONTRACT_ADDRESS, abi: receiptAbi, functionName: "receipts", args: [entry.id] }) as readonly unknown[], entry)));
          page.push(...batch);
          if (!alive.current) return;
        }
      }
      if (!alive.current) return;
      setReceipts(previous => {
        const merged = new Map((from === null ? [] : previous).map(receipt => [receipt.id, receipt]));
        for (const receipt of page) merged.set(receipt.id, receipt);
        return [...merged.values()];
      });
      setScanned(previous => ({ from: from === null || !previous ? start : previous.from, to: end }));
      setNextBlock(end + BigInt(1));
    } catch (cause) {
      if (alive.current) setError(errorMessage(cause));
    } finally {
      busy.current = false;
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void loadPage(null);
    return () => { alive.current = false; };
  }, [loadPage]);

  useEffect(() => {
    const update = () => setNow(Date.now());
    update();
    const timer = setInterval(update, 30000);
    return () => clearInterval(timer);
  }, []);

  const query = search.trim().toLowerCase();
  const displayed = receipts.filter(receipt => [receipt.repoId, receipt.tag, receipt.commitHash, receipt.artifactHash, receipt.signer, receipt.id].some(value => value.toLowerCase().includes(query))).sort((a, b) => {
    const order = BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0;
    return direction === "asc" ? order : -order;
  });
  const caughtUp = nextBlock !== null && nextBlock > heads.latest;

  return (
    <main className="page" suppressHydrationWarning>
      <header className="topbar"><span className="logo">VMRL</span><a href="https://github.com/aetosdios27/vmrl" target="_blank" rel="noreferrer">GitHub</a><span className="network">{LOCAL_DEMO ? "Local EVM demo" : CHAIN_ID === 84532 ? "Base Sepolia" : `Chain ${CHAIN_ID}`} · latest block {heads.latest.toString()}</span></header>
      <section className="hero"><p className="eyebrow">Verification · Merkle · Receipt · Ledger</p><h1>VMRL <span>EXPLORER</span></h1><p>On-chain release receipts. Local artifact integrity. Your publisher trust policy.</p></section>
      {LOCAL_DEMO && <DemoGuide />}
      <section className="stats" aria-label="Loaded history statistics">
        <div><strong>{receipts.length}</strong><span>Loaded receipts</span></div>
        <div><strong>{new Set(receipts.map(receipt => receipt.repoId)).size}</strong><span>Loaded repositories</span></div>
        <div><strong>{new Set(receipts.map(receipt => receipt.signer)).size}</strong><span>Loaded signers</span></div>
      </section>
      <section className="panel" aria-labelledby="history-title">
        <div className="panel-header"><h2 id="history-title">Release history</h2><label className="search-label">Search loaded receipts<input type="search" className="text-input" value={search} onChange={event => setSearch(event.target.value)} placeholder="Repository, tag, digest, signer, ID" /></label></div>
        <div className="history-controls">
          <p>{scanned ? `Scanned blocks ${scanned.from}–${scanned.to}. ` : START_BLOCK_TEXT !== undefined ? `Starting at block ${START_BLOCK_TEXT}. ` : "Discovering the contract deployment block. "}Each page scans at most {LOG_RANGE.toString()} blocks. Counts and search cover loaded history only.</p>
          <div className="button-row">
            <button type="button" disabled={loading} onClick={() => void loadPage(error ? requestedFrom.current : nextBlock)}>{loading ? "Loading history…" : error ? "Retry page" : caughtUp ? "Check for newer receipts" : "Load next history page"}</button>
            <button type="button" disabled={loading} onClick={() => { setSelected(null); void loadPage(null); }}>Reload from start</button>
          </div>
          <p>Without NEXT_PUBLIC_VMRL_START_BLOCK, the deployment block is discovered with bounded historical code queries. Configure the known deployment block to bypass discovery.</p>
          {error && <p role="alert" className="failure">RPC / configuration error: {error}. Previously loaded records remain visible; the failed page was not skipped.</p>}
          {headWarning && <div className="warning" role="status"><p>{headWarning}</p><button type="button" disabled={loading} onClick={() => void loadPage(nextBlock)}>Retry chain status</button><p>Finality is unknown when tags are unavailable; block age is never used to infer it.</p></div>}
          <p role="status">{loading ? "Fetching receipts from the configured RPC…" : caughtUp && !error ? "History loaded through the last observed tip. Refresh to check for new receipts." : "History is partial until all pages are loaded."}</p>
        </div>
        <div className="table-wrap"><table><thead><tr><th scope="col" aria-sort={direction === "asc" ? "ascending" : "descending"}><button type="button" onClick={() => setDirection(direction === "asc" ? "desc" : "asc")}>ID {direction === "asc" ? "↑" : "↓"}</button></th><th scope="col">Repository / tag</th><th scope="col">Declared revision</th><th scope="col">Signer</th><th scope="col">Chain status</th><th scope="col">Anchored</th><th scope="col">Action</th></tr></thead>
          <tbody>{displayed.map(receipt => <tr key={receipt.id}><td className="receipt-id">#{receipt.id}</td><td><strong>{receipt.repoId}</strong><span className="subline">{receipt.tag}</span></td><td><code title={receipt.commitHash}>{receipt.commitHash.slice(0, 12)}…</code></td><td><code title={receipt.signer}>{receipt.signer.slice(0, 8)}…{receipt.signer.slice(-4)}</code></td><td><span className="status-pill">{chainStatus(receipt.blockNumber, heads)}</span></td><td><time title={new Date(Number(receipt.timestamp) * 1000).toUTCString()}>{timeAgo(receipt.timestamp, now)}</time><span className="subline">Block {receipt.blockNumber.toString()}</span></td><td><button type="button" onClick={() => setSelected(receipt)} aria-label={`Verify receipt ${receipt.id} for ${receipt.repoId} ${receipt.tag}`}>Verify artifact</button></td></tr>)}</tbody>
        </table></div>
        {!loading && displayed.length === 0 && <p className="empty">{error ? "Receipts could not be loaded. Retry the failed page above." : search ? "No matching receipts in loaded history." : "No receipts in the blocks loaded so far. Continue loading historical pages."}</p>}
      </section>
      <footer><p>Chain ID {CHAIN_ID} · Contract <code>{CONTRACT_ADDRESS}</code></p><p>Integrity and publisher trust are separate from chain finality. Blockchain receipts do not prove source-to-build correspondence or software safety.</p></footer>
      {selected && <ReceiptModal key={`${selected.id}:${selected.artifactHash}`} receipt={selected} heads={heads} onClose={() => setSelected(null)} />}
    </main>
  );
}
