"use client";

import {
  useState, useEffect, useCallback, useRef, useMemo,
  createContext, useContext
} from "react";
import { createPublicClient, http, parseAbiItem } from "viem";
import { baseSepolia } from "viem/chains";

const CONTRACT_ADDRESS = "0xe0C0B432380a07177372d10DF61BAFedAB9D8367";
const LOG_RANGE = BigInt(10000);

const rpcClient = createPublicClient({
  chain: baseSepolia,
  transport: http("https://sepolia.base.org"),
});

const eventAbi = parseAbiItem(
  "event NewReceipt(string indexed repoId, bytes32 indexed commitHash, address indexed signer, uint256 receiptId)"
);

type Receipt = {
  repoId: string | undefined;
  commitHash: string | undefined;
  signer: string | undefined;
  id: string;
  blockNumber: bigint;
};
type SortKey = "id" | "repoId" | "blockNumber";
type SortDir = "asc" | "desc";
type Toast = { id: number; message: string; type: "new" | "copy" };

// ── CONFIRMATION STATUS ────────────────────────────────────────────────────────
// Base Sepolia ~2s/block. Four semantic tiers — not an always-100% progress bar.
function getConfStatus(blockNumber: bigint, latest: bigint) {
  const blocks = Number(latest - blockNumber);
  const secs = blocks * 2;
  if (blocks < 1)  return { label: "Pending",    color: "#f5a623", blocks, secs };
  if (blocks < 6)  return { label: "Confirming", color: "#00d4ff", blocks, secs };
  if (blocks < 50) return { label: "Confirmed",  color: "#00ff9d", blocks, secs };
                   return { label: "Finalized",  color: "#a78bfa", blocks, secs };
}

function timeAgo(block: bigint, latest: bigint): string {
  const s = Number(latest - block) * 2;
  if (s < 5)    return "just now";
  if (s < 60)   return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400)return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function short(s: string | undefined, a = 8, b = 6) {
  if (!s) return "—";
  if (s.length <= a + b + 3) return s;
  return `${s.slice(0, a)}…${s.slice(-b)}`;
}

function addrHue(addr: string | undefined): number {
  if (!addr) return 180;
  let h = 0;
  for (let i = 2; i < Math.min(addr.length, 10); i++) h = (h * 31 + addr.charCodeAt(i)) % 360;
  return h;
}

// ── TOAST ─────────────────────────────────────────────────────────────────────
const ToastCtx = createContext<(msg: string, type?: Toast["type"]) => void>(() => {});
function useToast() { return useContext(ToastCtx); }

function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);
  const push = useCallback((message: string, type: Toast["type"] = "copy") => {
    const id = ++nextId.current;
    // Always defer so we never call setState during a parent render
    setTimeout(() => {
      setToasts(p => [...p, { id, message, type }]);
      setTimeout(() => setToasts(p => p.filter(t => t.id !== id)), 3200);
    }, 0);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-stack">
        {toasts.map(t => (
          <div key={t.id} className={`toast toast-${t.type}`}>
            <span className="ti">{t.type === "new" ? "⬡" : "✓"}</span>
            {t.message}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ── CANVAS ────────────────────────────────────────────────────────────────────
function NetworkCanvas() {
  const ref = useRef<HTMLCanvasElement>(null);
  const mouse = useRef({ x: -999, y: -999 });
  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext("2d")!;
    let raf: number;
    const resize = () => { canvas.width = window.innerWidth; canvas.height = window.innerHeight; };
    resize();
    window.addEventListener("resize", resize);
    const onMouse = (e: MouseEvent) => { mouse.current = { x: e.clientX, y: e.clientY }; };
    window.addEventListener("mousemove", onMouse);
    const nodes = Array.from({ length: 58 }, () => ({
      x: Math.random() * window.innerWidth, y: Math.random() * window.innerHeight,
      vx: (Math.random() - 0.5) * 0.22, vy: (Math.random() - 0.5) * 0.22,
      r: Math.random() * 1.3 + 0.4, pulse: Math.random() * Math.PI * 2,
      spd: 0.014 + Math.random() * 0.01,
    }));
    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const { x: mx, y: my } = mouse.current;
      nodes.forEach(n => {
        n.pulse += n.spd;
        const dx = n.x - mx, dy = n.y - my, d2 = dx*dx + dy*dy;
        if (d2 < 12000) { const f = (1-d2/12000)*0.35; n.vx += (dx/Math.sqrt(d2))*f; n.vy += (dy/Math.sqrt(d2))*f; }
        n.vx *= 0.988; n.vy *= 0.988; n.x += n.vx; n.y += n.vy;
        if (n.x<0||n.x>canvas.width) n.vx*=-1;
        if (n.y<0||n.y>canvas.height) n.vy*=-1;
      });
      for (let i=0;i<nodes.length;i++) for (let j=i+1;j<nodes.length;j++) {
        const dx=nodes[i].x-nodes[j].x, dy=nodes[i].y-nodes[j].y, d=Math.sqrt(dx*dx+dy*dy);
        if (d<155) { ctx.strokeStyle=`rgba(0,195,255,${(1-d/155)*0.15})`; ctx.lineWidth=0.5; ctx.beginPath(); ctx.moveTo(nodes[i].x,nodes[i].y); ctx.lineTo(nodes[j].x,nodes[j].y); ctx.stroke(); }
      }
      if (mx>0) { const g=ctx.createRadialGradient(mx,my,0,mx,my,130); g.addColorStop(0,"rgba(0,170,255,0.05)"); g.addColorStop(1,"rgba(0,0,0,0)"); ctx.fillStyle=g; ctx.fillRect(0,0,canvas.width,canvas.height); }
      nodes.forEach(n => { const gl=0.5+0.5*Math.sin(n.pulse); ctx.beginPath(); ctx.arc(n.x,n.y,n.r+gl,0,Math.PI*2); ctx.fillStyle=`rgba(0,190,255,${0.3+gl*0.45})`; ctx.fill(); });
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => { cancelAnimationFrame(raf); window.removeEventListener("resize",resize); window.removeEventListener("mousemove",onMouse); };
  }, []);
  return <canvas ref={ref} style={{ position:"fixed",inset:0,zIndex:0,pointerEvents:"none",opacity:0.45 }} />;
}

function Glitch({ children }: { children: string }) {
  return <span className="glitch" data-text={children}>{children}</span>;
}

function useTypewriter(text: string, speed = 26) {
  const [out, setOut] = useState("");
  useEffect(() => {
    setOut(""); let i = 0;
    const t = setInterval(() => { setOut(text.slice(0,++i)); if (i>=text.length) clearInterval(t); }, speed);
    return () => clearInterval(t);
  }, [text, speed]);
  return out;
}

function Counter({ to }: { to: number }) {
  const [val, setVal] = useState(0);
  const prev = useRef(0);
  useEffect(() => {
    const from = prev.current; prev.current = to; let s = 0; const steps = 22;
    const t = setInterval(() => { s++; setVal(Math.round(from+((to-from)*s)/steps)); if (s>=steps) { setVal(to); clearInterval(t); } }, 36);
    return () => clearInterval(t);
  }, [to]);
  return <>{val}</>;
}

function TiltCard({ children, className }: { children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const onMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const el = ref.current!;
    const { left, top, width, height } = el.getBoundingClientRect();
    el.style.transform = `perspective(600px) rotateX(${((e.clientY-top)/height-0.5)*-9}deg) rotateY(${((e.clientX-left)/width-0.5)*9}deg) scale(1.02)`;
    el.style.setProperty("--mx", `${((e.clientX-left)/width*100).toFixed(1)}%`);
    el.style.setProperty("--my", `${((e.clientY-top)/height*100).toFixed(1)}%`);
  }, []);
  const onLeave = useCallback(() => { if (ref.current) ref.current.style.transform = ""; }, []);
  return <div ref={ref} className={`tilt ${className??""}`} onMouseMove={onMove} onMouseLeave={onLeave}>{children}</div>;
}

function CopyBtn({ text, size = 28 }: { text: string; size?: number }) {
  const toast = useToast();
  const [done, setDone] = useState(false);
  const onClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(text).then(() => {
      setDone(true); toast("Copied to clipboard", "copy");
      setTimeout(() => setDone(false), 1800);
    });
  }, [text, toast]);
  const sz = size <= 28 ? 13 : 15;
  return (
    <button className={`cpbtn ${done?"cpbtn-done":""}`} onClick={onClick} style={{ width:size, height:size }} title="Copy">
      {done
        ? <svg width={sz} height={sz} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
        : <svg width={sz} height={sz} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
      }
    </button>
  );
}

function SignerAvatar({ addr, size = 22 }: { addr: string | undefined; size?: number }) {
  const hue = addrHue(addr);
  return (
    <span className="sig-av" style={{ "--hue":hue,"--sz":`${size}px`,"--fz":`${Math.round(size*0.36)}px` } as React.CSSProperties} title={addr}>
      {addr ? addr.slice(2,4).toUpperCase() : "??"}
    </span>
  );
}

function SortTh({ label, sortKey, current, dir, onClick, right }: {
  label: string; sortKey: SortKey; current: SortKey; dir: SortDir; onClick: (k: SortKey) => void; right?: boolean;
}) {
  const active = current === sortKey;
  return (
    <th className={`sortable ${active?"sort-on":""} ${right?"th-r":""}`} onClick={() => onClick(sortKey)}>
      <span className={`th-in ${right?"th-in-r":""}`}>
        {label}<span className="sort-arr">{active?(dir==="asc"?"↑":"↓"):"⇅"}</span>
      </span>
    </th>
  );
}

// ── RECEIPT MODAL ─────────────────────────────────────────────────────────────
function ReceiptModal({ r, latest, onClose }: { r: Receipt; latest: bigint; onClose: () => void }) {
  const toast = useToast();
  const conf = getConfStatus(r.blockNumber, latest);

  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", fn);
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", fn); document.body.style.overflow = ""; };
  }, [onClose]);

  const copyCmd = useCallback(() => {
    navigator.clipboard.writeText(`vmrl verify --repo ${r.repoId} --commit ${r.commitHash}`);
    toast("Verify command copied", "copy");
  }, [r, toast]);

  return (
    <div className="m-overlay" onClick={onClose}>
      <div className="m-card" onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="m-head">
          <div className="m-head-info">
            <div className="m-eyebrow"><span className="m-eyebrow-hex">⬡</span> Receipt #{r.id}</div>
            <div className="m-repo-name">{r.repoId ?? "—"}</div>
          </div>

          {/* Status — the meaningful version */}
          <div className="m-status-block" style={{ "--cc": conf.color } as React.CSSProperties}>
            <div className="m-status-badge">
              <span className="m-status-dot" />
              {conf.label}
            </div>
            <div className="m-status-meta">
              {conf.blocks} block{conf.blocks !== 1 ? "s" : ""} ·{" "}
              {conf.secs < 60 ? `${conf.secs}s` : `${Math.floor(conf.secs/60)}m`} since anchor
            </div>
          </div>

          <button className="m-close" onClick={onClose} title="Close (Esc)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M18 6 6 18M6 6l12 12"/>
            </svg>
          </button>
        </div>

        {/* Accent line */}
        <div className="m-accent" style={{ "--cc": conf.color } as React.CSSProperties} />

        {/* Fields */}
        <div className="m-body">

          {/* Commit hash — full width, most important */}
          <div className="m-field m-field-span">
            <div className="m-label">Commit Hash</div>
            <div className="m-val m-val-feature">
              <span className="m-mono m-val-text">{r.commitHash ?? "—"}</span>
              <CopyBtn text={r.commitHash ?? ""} size={34} />
            </div>
          </div>

          {/* Signer — full width */}
          <div className="m-field m-field-span">
            <div className="m-label">Signer Address</div>
            <div className="m-val">
              <SignerAvatar addr={r.signer} size={30} />
              <span className="m-mono m-val-text">{r.signer ?? "—"}</span>
              <CopyBtn text={r.signer ?? ""} size={34} />
            </div>
          </div>

          {/* Block + Age side by side */}
          <div className="m-field">
            <div className="m-label">Block Number</div>
            <div className="m-val">
              <span className="m-block-val">#{r.blockNumber.toString()}</span>
              <CopyBtn text={r.blockNumber.toString()} size={30} />
            </div>
          </div>

          <div className="m-field">
            <div className="m-label">Anchored</div>
            <div className="m-val">
              <span className="m-age-val">{timeAgo(r.blockNumber, latest)}</span>
            </div>
          </div>

        </div>

        {/* Actions */}
        <div className="m-actions">
          <button className="m-btn m-btn-primary"
            onClick={() => window.open(`https://sepolia.basescan.org/block/${r.blockNumber}`, "_blank")}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
              <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
            </svg>
            View on BaseScan
          </button>
          <button className="m-btn"
            onClick={() => window.open(`https://sepolia.basescan.org/address/${r.signer}`, "_blank")}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
              <circle cx="12" cy="7" r="4"/>
            </svg>
            Signer
          </button>
          <button className="m-btn m-btn-cli" onClick={copyCmd}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>
            </svg>
            Copy CLI Command
          </button>
        </div>

      </div>
    </div>
  );
}

// ── CONF PILL (table) ─────────────────────────────────────────────────────────
function ConfPill({ blockNumber, latest }: { blockNumber: bigint; latest: bigint }) {
  const c = getConfStatus(blockNumber, latest);
  return (
    <span className="conf-pill" style={{ "--cc": c.color } as React.CSSProperties}>
      <span className="conf-dot" />{c.label}
    </span>
  );
}

// ── APP ───────────────────────────────────────────────────────────────────────
function AppContent() {
  const [receipts, setReceipts]   = useState<Receipt[]>([]);
  const [loading, setLoading]     = useState(true);
  const [latest, setLatest]       = useState<bigint>(BigInt(0));
  const [search, setSearch]       = useState("");
  const [sortKey, setSortKey]     = useState<SortKey>("id");
  const [sortDir, setSortDir]     = useState<SortDir>("desc");
  const [selected, setSelected]   = useState<Receipt | null>(null);
  const [newIds, setNewIds]       = useState<Set<string>>(new Set());
  const [filterTab, setFilterTab] = useState<"all"|"recent">("all");
  const [pageReady, setPageReady] = useState(false);
  const [shake, setShake]         = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const typed = useTypewriter("Immutable proof-of-release for every commit · Zero code exposure · Base Sepolia L2", 24);

  useEffect(() => { setTimeout(() => setPageReady(true), 80); }, []);

  const doFetch = useCallback(async () => {
    try {
      const lb = await rpcClient.getBlockNumber();
      setLatest(lb);
      const from = lb > LOG_RANGE ? lb - LOG_RANGE : BigInt(0);
      const logs = await rpcClient.getLogs({ address: CONTRACT_ADDRESS, event: eventAbi, fromBlock: from, toBlock: lb });
      const fmt: Receipt[] = logs.map(l => ({
        repoId: l.args.repoId,
        commitHash: l.args.commitHash as string|undefined,
        signer: l.args.signer,
        id: l.args.receiptId?.toString() ?? "—",
        blockNumber: l.blockNumber ?? BigInt(0),
      })).reverse();
      setReceipts(prev => {
        const prevSet = new Set(prev.map(r => r.id));
        const fresh = fmt.filter(r => !prevSet.has(r.id));
        if (fresh.length > 0) {
          setNewIds(new Set(fresh.map(r => r.id)));
          setTimeout(() => toast(`${fresh.length} new anchor${fresh.length>1?"s":""} detected`, "new"), 0);
          setTimeout(() => setNewIds(new Set()), 3000);
        }
        return fmt;
      });
    } catch(e) { console.error(e); }
    finally { setLoading(false); }
  }, [toast]);

  useEffect(() => { doFetch(); const t = setInterval(doFetch, 5000); return () => clearInterval(t); }, [doFetch]);

  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if (e.key==="/" && document.activeElement!==searchRef.current) { e.preventDefault(); searchRef.current?.focus(); }
      if (e.key==="Escape" && !selected) { setSearch(""); searchRef.current?.blur(); }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [selected]);

  const handleSort = useCallback((k: SortKey) => {
    setSortDir(prev => sortKey===k ? (prev==="asc"?"desc":"asc") : "desc");
    setSortKey(k);
  }, [sortKey]);

  const displayed = useMemo(() => {
    let data = [...receipts];
    if (filterTab==="recent") data = data.filter(r => Number(latest-r.blockNumber)*2 < 3600);
    const q = search.toLowerCase().trim();
    if (q) data = data.filter(r =>
      r.repoId?.toLowerCase().includes(q) || r.commitHash?.toLowerCase().includes(q) ||
      r.signer?.toLowerCase().includes(q) || r.id.includes(q)
    );
    data.sort((a, b) => {
      let av: number|string, bv: number|string;
      if (sortKey==="id") { av=parseInt(a.id)||0; bv=parseInt(b.id)||0; }
      else if (sortKey==="blockNumber") { av=Number(a.blockNumber); bv=Number(b.blockNumber); }
      else { av=a.repoId??""; bv=b.repoId??""; }
      return sortDir==="asc"?(av>bv?1:-1):(av<bv?1:-1);
    });
    return data;
  }, [receipts, search, sortKey, sortDir, filterTab, latest]);

  useEffect(() => {
    if (search && displayed.length===0) { setShake(true); setTimeout(()=>setShake(false),500); }
  }, [search, displayed.length]);

  const signers = useMemo(() => new Set(receipts.map(r=>r.signer)).size, [receipts]);
  const repos   = useMemo(() => new Set(receipts.map(r=>r.repoId)).size, [receipts]);
  const recent  = useMemo(() => receipts.filter(r=>Number(latest-r.blockNumber)*2<3600).length, [receipts,latest]);

  return (
    <div className={`page ${pageReady?"ready":""}`}>
      <NetworkCanvas />
      <div className="inner">

        {/* TOPBAR */}
        <header className="topbar reveal" style={{"--d":"0ms"} as React.CSSProperties}>
          <div className="t-logo">
            <div className="hex-logo">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5">
                <polygon points="12 2 22 7 22 17 12 22 2 17 2 7"/>
              </svg>
            </div>
            VMRL
          </div>
          <nav className="t-nav">
            <a className="t-nav-link" href="https://github.com/aetosdios27/vmrl" target="_blank" rel="noreferrer">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/></svg>
              GitHub
            </a>
          </nav>
          <div className="t-right">
            <div className="blk-chip">
              <span className="blk-lbl">BLOCK</span>
              <span className="blk-val">{latest>0?`#${latest.toString()}`:"—"}</span>
            </div>
            <div className="net-badge"><span className="nd"/>Base Sepolia</div>
          </div>
        </header>

        {/* HERO */}
        <section className="hero">
          <div className="hero-eye reveal" style={{"--d":"80ms"} as React.CSSProperties}>
            <span className="eye-line"/><span>Verification · Merkle · Receipt · Ledger</span><span className="eye-line"/>
          </div>
          <h1 className="hero-title reveal" style={{"--d":"150ms"} as React.CSSProperties}>
            <Glitch>VMRL</Glitch> <span className="hero-grad">EXPLORER</span>
          </h1>
          <p className="hero-sub reveal" style={{"--d":"220ms"} as React.CSSProperties}>
            {typed}<span className="cur"/>
          </p>
          <div className="hero-pills reveal" style={{"--d":"310ms"} as React.CSSProperties}>
            {[
              {icon:"⬡",v:receipts.length,l:"anchors"},
              {icon:"◈",v:repos,l:"repos"},
              {icon:"◉",v:signers,l:"signers"},
              {icon:"◎",v:"~2s",l:"finality"},
            ].map((p,i)=>(
              <div key={i} className="hero-pill">
                <span className="pill-icon">{p.icon}</span>
                <span className="pill-val">{p.v}</span>
                <span className="pill-lbl">{p.l}</span>
              </div>
            ))}
          </div>
        </section>

        {/* STATS */}
        <div className="stats reveal" style={{"--d":"370ms"} as React.CSSProperties}>
          {[
            {n:receipts.length,l:"Total Anchors", tag:"on-chain",c:"cyan"},
            {n:repos,          l:"Repositories",  tag:"unique",  c:"amber"},
            {n:signers,        l:"Signers",        tag:"devs",    c:"green"},
            {n:recent,         l:"Last Hour",      tag:"recent",  c:"purple"},
          ].map((s,i)=>(
            <TiltCard key={i} className={`sc sc-${s.c}`}>
              <div className="sc-shine"/>
              <div className="sc-tag">{s.tag}</div>
              <div className="sc-num"><Counter to={s.n}/></div>
              <div className="sc-lbl">{s.l}</div>
            </TiltCard>
          ))}
        </div>

        {/* PANEL */}
        <div className="panel reveal" style={{"--d":"440ms"} as React.CSSProperties}>

          <div className="ph">
            <div className="tabs">
              {(["all","recent"] as const).map(tab=>(
                <button key={tab} className={`tab ${filterTab===tab?"tab-on":""}`} onClick={()=>setFilterTab(tab)}>
                  {tab==="all"?`All  ${receipts.length}`:`Last Hour  ${recent}`}
                </button>
              ))}
            </div>
            <div className="ph-right">
              <div className={`s-wrap ${shake?"shake":""}`}>
                <span className="s-pfx">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
                  </svg>
                </span>
                <input ref={searchRef} className="s-in" placeholder='Search repo, hash, signer… ( / )' value={search} onChange={e=>setSearch(e.target.value)}/>
                {search && <button className="s-clear" onClick={()=>setSearch("")}>✕</button>}
                {search && <span className="s-count">{displayed.length}</span>}
              </div>
              <div className="live-p"><span className="lring"/>Live</div>
            </div>
          </div>

          <div className="tw">
            {loading ? (
              <div className="spin-c">
                <div className="spin-orbit"><div className="spin-r1"/><div className="spin-r2"/><div className="spin-core"/></div>
                <div className="spin-lbl">Scanning the ledger</div>
                <div className="spin-sub">{CONTRACT_ADDRESS.slice(0,22)}…</div>
              </div>
            ) : displayed.length===0 ? (
              <div className="empty">
                <div className="e-icon">⬡</div>
                <div className="e-title">{search?"NO RESULTS":"NO ANCHORS YET"}</div>
                <div className="e-body">{search?<>Nothing for <code className="e-code">"{search}"</code></>:"No receipts in the last 10,000 blocks."}</div>
                {!search && <div className="term">vmrl anchor --repo &lt;id&gt;</div>}
              </div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <SortTh label="ID"         sortKey="id"          current={sortKey} dir={sortDir} onClick={handleSort}/>
                    <SortTh label="Repository" sortKey="repoId"      current={sortKey} dir={sortDir} onClick={handleSort}/>
                    <th>Commit</th>
                    <th>Signer</th>
                    <th>Status</th>
                    <SortTh label="Block" sortKey="blockNumber" current={sortKey} dir={sortDir} onClick={handleSort} right/>
                  </tr>
                </thead>
                <tbody>
                  {displayed.map((r,i) => (
                    <tr
                      key={r.id}
                      className={`row ${newIds.has(r.id)?"row-new":""}`}
                      style={{ animationDelay:`${i*20}ms` }}
                      onClick={() => setSelected(r)}
                      title="Click to view full receipt"
                    >
                      <td><span className="t-id">{r.id}</span></td>
                      <td>
                        <div className="t-repo">
                          <span className="repo-hex">⬡</span>
                          <span className="repo-name">{r.repoId ?? "—"}</span>
                        </div>
                      </td>
                      <td>
                        <code className="t-hash">{short(r.commitHash, 8, 6)}</code>
                      </td>
                      <td>
                        <div className="cell-grp">
                          <SignerAvatar addr={r.signer}/>
                          <code className="t-sig">{short(r.signer, 6, 4)}</code>
                        </div>
                      </td>
                      <td>
                        {latest>0 && <ConfPill blockNumber={r.blockNumber} latest={latest}/>}
                      </td>
                      <td>
                        <div className="t-r-cell">
                          <div className="t-blk-age">
                            <span className="t-blk">#{r.blockNumber.toString()}</span>
                            <span className="t-age">{latest>0?timeAgo(r.blockNumber,latest):"—"}</span>
                          </div>
                          <button className="details-btn" onClick={e=>{e.stopPropagation();setSelected(r);}}>
                            Details
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                              <path d="m9 18 6-6-6-6"/>
                            </svg>
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {!loading && displayed.length>0 && (
            <div className="pf">
              <code className="pf-cmd"><span className="pf-dol">$</span> vmrl verify --repo &lt;id&gt; --commit &lt;hash&gt;</code>
              <div className="pf-r">
                <span className="pf-rec">{displayed.length} / {receipts.length} records</span>
                <a className="pf-link" href="https://github.com/aetosdios27/vmrl" target="_blank" rel="noreferrer">github.com/aetosdios27/vmrl ↗</a>
              </div>
            </div>
          )}
        </div>

        <footer className="site-foot reveal" style={{"--d":"520ms"} as React.CSSProperties}>
          <div className="foot-l">
            <span className="foot-logo">VMRL</span>
            <span className="foot-sep">·</span><span>Base Sepolia</span>
            <span className="foot-sep">·</span><span>Chain ID 84532</span>
          </div>
          <span className="foot-addr">{CONTRACT_ADDRESS.slice(0,14)}…{CONTRACT_ADDRESS.slice(-12)}</span>
        </footer>

      </div>
      {selected && <ReceiptModal r={selected} latest={latest} onClose={()=>setSelected(null)}/>}
    </div>
  );
}

export default function Home() {
  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Bebas+Neue&family=DM+Sans:wght@400;500;600;700&display=swap');
        *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
        :root{
          --bg:#020508;--s1:#050d15;--s2:#081420;
          --b1:#0e2035;--b2:#162d48;--b3:#1e3d5c;
          --cyan:#00d4ff;--cyan2:#66e8ff;
          --amber:#f5a623;--amber2:#ffc55a;
          --green:#00ff9d;--green2:#66ffbe;
          --purple:#c084fc;--red:#ff4d6d;
          --txt:#c8dff0;--txt2:#e8f4ff;
          --mut:#4a7090;--dim:#2a4a65;
          --mono:'IBM Plex Mono',monospace;
          --disp:'Bebas Neue',sans-serif;
          --sans:'DM Sans',sans-serif;
          --ease:cubic-bezier(0.4,0,0.2,1);
          --spring:cubic-bezier(0.34,1.56,0.64,1);
        }
        html,body{background:var(--bg);color:var(--txt);min-height:100vh;font-family:var(--mono);overflow-x:hidden;}
        ::-webkit-scrollbar{width:4px;height:4px;}
        ::-webkit-scrollbar-track{background:var(--bg);}
        ::-webkit-scrollbar-thumb{background:var(--b2);border-radius:2px;}

        .page{position:relative;min-height:100vh;background:radial-gradient(ellipse 110% 50% at 50% -5%,rgba(0,130,255,.09) 0%,transparent 65%),radial-gradient(ellipse 55% 40% at 95% 95%,rgba(245,166,35,.05) 0%,transparent 55%),var(--bg);}
        .page::before{content:'';position:fixed;inset:0;z-index:0;pointer-events:none;background:repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(0,0,0,.025) 2px,rgba(0,0,0,.025) 4px);}
        .inner{position:relative;z-index:1;max-width:1200px;margin:0 auto;padding:0 1.5rem 4rem;}

        .reveal{opacity:0;transform:translateY(12px);transition:opacity .5s var(--ease),transform .5s var(--ease);transition-delay:var(--d,0ms);}
        .ready .reveal{opacity:1;transform:none;}

        /* TOPBAR */
        .topbar{display:flex;align-items:center;justify-content:space-between;padding:1.1rem 0;border-bottom:1px solid var(--b1);margin-bottom:3rem;gap:1rem;flex-wrap:wrap;}
        .t-logo{display:flex;align-items:center;gap:.6rem;font-family:var(--disp);font-size:1.6rem;letter-spacing:.18em;color:#fff;cursor:default;}
        .hex-logo{width:32px;height:32px;background:linear-gradient(135deg,var(--cyan),var(--amber));clip-path:polygon(50% 0%,100% 25%,100% 75%,50% 100%,0% 75%,0% 25%);display:flex;align-items:center;justify-content:center;color:#000;transition:transform .35s var(--spring);}
        .t-logo:hover .hex-logo{transform:rotate(30deg) scale(1.1);}
        .t-nav{display:flex;gap:.4rem;}
        .t-nav-link{display:flex;align-items:center;gap:.4rem;padding:.35rem .8rem;background:rgba(255,255,255,.04);border:1px solid var(--b2);border-radius:7px;font-size:.72rem;color:var(--mut);text-decoration:none;letter-spacing:.04em;transition:all .18s;font-family:var(--sans);}
        .t-nav-link:hover{color:var(--txt2);border-color:var(--b3);background:rgba(255,255,255,.07);}
        .t-right{display:flex;align-items:center;gap:1rem;}
        .blk-chip{display:flex;flex-direction:column;align-items:flex-end;gap:1px;}
        .blk-lbl{font-size:.52rem;letter-spacing:.2em;text-transform:uppercase;color:var(--mut);}
        .blk-val{font-size:.78rem;color:var(--txt2);letter-spacing:.04em;font-weight:500;}
        .net-badge{display:flex;align-items:center;gap:.45rem;padding:.32rem .8rem;background:rgba(0,210,255,.07);border:1px solid rgba(0,210,255,.18);border-radius:100px;font-size:.65rem;color:var(--cyan);letter-spacing:.1em;text-transform:uppercase;}
        .nd{width:5px;height:5px;border-radius:50%;background:var(--green);box-shadow:0 0 7px var(--green);animation:breathe 2.2s ease-in-out infinite;}
        @keyframes breathe{0%,100%{opacity:1;transform:scale(1);}50%{opacity:.3;transform:scale(.65);}}

        /* HERO */
        .hero{text-align:center;margin-bottom:2.5rem;}
        .hero-eye{display:inline-flex;align-items:center;gap:.8rem;font-size:.65rem;letter-spacing:.22em;text-transform:uppercase;color:var(--amber);margin-bottom:1.1rem;opacity:.75;}
        .eye-line{display:block;width:28px;height:1px;background:var(--amber);opacity:.4;}
        .hero-title{font-family:var(--disp);font-size:clamp(3.8rem,10.5vw,8rem);line-height:.92;letter-spacing:.05em;color:#fff;margin-bottom:1rem;}
        .glitch{position:relative;display:inline-block;}
        .glitch::before,.glitch::after{content:attr(data-text);position:absolute;inset:0;}
        .glitch::before{color:var(--cyan);clip-path:polygon(0 0,100% 0,100% 35%,0 35%);transform:translate(-2px,-1px);opacity:0;animation:g1 8s infinite 3s;}
        .glitch::after{color:var(--amber);clip-path:polygon(0 65%,100% 65%,100% 100%,0 100%);transform:translate(2px,1px);opacity:0;animation:g2 8s infinite 3.1s;}
        @keyframes g1{0%,86%,100%{opacity:0;}87%{opacity:1;transform:translate(-5px,-1px) skewX(-3deg);}88.5%{opacity:0;}90%{opacity:.7;transform:translate(2px,0);}91%{opacity:0;}}
        @keyframes g2{0%,86%,100%{opacity:0;}87%{opacity:.9;transform:translate(5px,1px) skewX(3deg);}89%{opacity:0;}90.5%{opacity:.5;transform:translate(-2px,0);}91.5%{opacity:0;}}
        .hero-grad{background:linear-gradient(100deg,var(--cyan) 0%,var(--amber) 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;}
        .hero-sub{font-size:.75rem;color:var(--mut);letter-spacing:.04em;min-height:1.5em;margin-bottom:1.5rem;}
        .cur{display:inline-block;width:7px;height:.85em;background:var(--cyan);margin-left:1px;vertical-align:middle;animation:cur-blink 1s step-end infinite;}
        @keyframes cur-blink{0%,100%{opacity:1;}50%{opacity:0;}}
        .hero-pills{display:flex;align-items:center;justify-content:center;gap:.55rem;flex-wrap:wrap;}
        .hero-pill{display:flex;align-items:center;gap:.4rem;padding:.32rem .85rem;background:rgba(255,255,255,.04);border:1px solid var(--b1);border-radius:100px;font-size:.68rem;transition:all .2s;font-family:var(--sans);}
        .hero-pill:hover{border-color:var(--b2);background:rgba(255,255,255,.07);}
        .pill-icon{color:var(--cyan);}
        .pill-val{color:var(--txt2);font-weight:600;font-family:var(--mono);}
        .pill-lbl{color:var(--mut);}

        /* STATS */
        .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:1rem;margin-bottom:1.5rem;}
        .tilt{transform-style:preserve-3d;transition:transform .18s var(--ease);will-change:transform;}
        .sc{background:var(--s1);border:1px solid var(--b1);border-radius:14px;padding:1.5rem 1.4rem;cursor:default;overflow:hidden;position:relative;}
        .sc::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;border-radius:14px 14px 0 0;}
        .sc-cyan::before{background:linear-gradient(90deg,var(--cyan),transparent);}
        .sc-amber::before{background:linear-gradient(90deg,var(--amber),transparent);}
        .sc-green::before{background:linear-gradient(90deg,var(--green),transparent);}
        .sc-purple::before{background:linear-gradient(90deg,var(--purple),transparent);}
        .sc-shine{position:absolute;inset:0;background:radial-gradient(circle at var(--mx,50%) var(--my,50%),rgba(255,255,255,.05) 0%,transparent 60%);opacity:0;transition:opacity .2s;pointer-events:none;}
        .tilt:hover .sc-shine{opacity:1;}
        .sc-tag{font-size:.56rem;letter-spacing:.18em;text-transform:uppercase;color:var(--mut);margin-bottom:.5rem;display:block;}
        .sc-num{font-family:var(--disp);font-size:2.8rem;line-height:1;letter-spacing:.02em;margin-bottom:.3rem;}
        .sc-cyan .sc-num{color:var(--cyan2);}
        .sc-amber .sc-num{color:var(--amber2);}
        .sc-green .sc-num{color:var(--green2);}
        .sc-purple .sc-num{color:var(--purple);}
        .sc-lbl{font-family:var(--sans);font-size:.78rem;font-weight:500;color:var(--mut);}

        /* PANEL */
        .panel{background:var(--s1);border:1px solid var(--b1);border-radius:16px;overflow:hidden;}
        .ph{display:flex;align-items:center;justify-content:space-between;padding:.8rem 1.25rem;border-bottom:1px solid var(--b1);background:rgba(0,0,0,.22);gap:.75rem;flex-wrap:wrap;}
        .tabs{display:flex;background:rgba(0,0,0,.35);border:1px solid var(--b1);border-radius:9px;padding:3px;gap:2px;}
        .tab{padding:.38rem 1rem;border-radius:7px;font-family:var(--mono);font-size:.72rem;letter-spacing:.04em;cursor:pointer;background:none;border:none;color:var(--mut);transition:all .18s;white-space:nowrap;}
        .tab:hover{color:var(--txt);}
        .tab-on{background:var(--b2);color:var(--txt2);font-weight:500;}
        .ph-right{display:flex;align-items:center;gap:.75rem;}

        /* SEARCH */
        .s-wrap{position:relative;display:flex;align-items:center;}
        .shake{animation:shake .45s;}
        @keyframes shake{0%,100%{transform:translateX(0);}20%{transform:translateX(-5px);}40%{transform:translateX(5px);}60%{transform:translateX(-3px);}80%{transform:translateX(3px);}}
        .s-pfx{position:absolute;left:.75rem;color:var(--mut);display:flex;align-items:center;pointer-events:none;z-index:1;transition:color .2s;}
        .s-wrap:focus-within .s-pfx{color:var(--cyan);}
        .s-in{background:rgba(255,255,255,.04);border:1px solid var(--b2);border-radius:9px;padding:.48rem 4.5rem .48rem 2.25rem;font-family:var(--mono);font-size:.75rem;color:var(--txt);width:300px;outline:none;transition:border-color .2s,box-shadow .2s,background .2s;}
        .s-in::placeholder{color:var(--mut);}
        .s-in:focus{border-color:rgba(0,210,255,.4);background:rgba(0,210,255,.03);box-shadow:0 0 0 3px rgba(0,210,255,.07);}
        .s-clear{position:absolute;right:2.6rem;background:none;border:none;color:var(--mut);cursor:pointer;font-size:.75rem;padding:.2rem .3rem;transition:color .15s,transform .15s;}
        .s-clear:hover{color:var(--red);transform:scale(1.2);}
        .s-count{position:absolute;right:.65rem;font-size:.65rem;color:var(--cyan);font-weight:500;pointer-events:none;}
        .live-p{display:flex;align-items:center;gap:.45rem;font-size:.65rem;color:var(--green);letter-spacing:.12em;text-transform:uppercase;white-space:nowrap;font-weight:500;}
        .lring{width:7px;height:7px;border-radius:50%;background:var(--green);box-shadow:0 0 0 0 rgba(0,255,157,.4);animation:lping 2s ease-out infinite;}
        @keyframes lping{0%{box-shadow:0 0 0 0 rgba(0,255,157,.4);}70%{box-shadow:0 0 0 8px rgba(0,255,157,0);}100%{box-shadow:0 0 0 0 rgba(0,255,157,0);}}

        /* TABLE */
        .tw{overflow-x:auto;}
        table{width:100%;border-collapse:collapse;}
        thead tr{background:rgba(0,0,0,.3);}
        th{padding:.7rem 1.1rem;text-align:left;font-size:.6rem;letter-spacing:.18em;text-transform:uppercase;color:var(--mut);font-weight:400;border-bottom:1px solid var(--b1);white-space:nowrap;user-select:none;}
        th.th-r{text-align:right;}
        th.sortable{cursor:pointer;transition:color .15s;}
        th.sortable:hover{color:var(--txt);}
        th.sort-on{color:var(--cyan);}
        .th-in{display:flex;align-items:center;gap:.35rem;}
        .th-in-r{justify-content:flex-end;}
        .sort-arr{font-size:.6rem;opacity:.4;}
        th.sort-on .sort-arr{opacity:1;color:var(--cyan);}

        .row{border-bottom:1px solid rgba(14,32,53,.8);cursor:pointer;transition:background .12s;position:relative;animation:ri .28s var(--ease) both;}
        @keyframes ri{from{opacity:0;transform:translateY(5px);}to{opacity:1;transform:none;}}
        .row::before{content:'';position:absolute;left:0;top:0;bottom:0;width:2.5px;background:linear-gradient(180deg,var(--cyan),var(--amber));opacity:0;transition:opacity .15s;}
        .row:hover{background:rgba(0,200,255,.035);}
        .row:hover::before{opacity:1;}
        .row:active{background:rgba(0,200,255,.06);}
        .row-new{animation:rflash 2.8s ease forwards;}
        @keyframes rflash{0%,10%{background:rgba(0,255,157,.07);}100%{background:transparent;}}

        td{padding:.9rem 1.1rem;vertical-align:middle;white-space:nowrap;}

        .t-id{display:inline-flex;align-items:center;justify-content:center;min-width:26px;height:24px;padding:0 6px;border-radius:5px;background:rgba(245,166,35,.1);border:1px solid rgba(245,166,35,.25);color:var(--amber2);font-size:.72rem;font-weight:600;transition:all .15s;}
        .row:hover .t-id{background:rgba(245,166,35,.18);border-color:rgba(245,166,35,.45);}
        .t-repo{display:flex;align-items:center;gap:.55rem;}
        .repo-hex{width:22px;height:22px;flex-shrink:0;background:linear-gradient(135deg,rgba(0,200,255,.13),rgba(0,60,200,.13));border:1px solid rgba(0,200,255,.22);clip-path:polygon(50% 0%,100% 25%,100% 75%,50% 100%,0% 75%,0% 25%);display:flex;align-items:center;justify-content:center;font-size:.48rem;color:var(--cyan);transition:all .2s;}
        .row:hover .repo-hex{background:linear-gradient(135deg,rgba(0,200,255,.24),rgba(0,100,255,.2));border-color:rgba(0,200,255,.4);}
        .repo-name{font-family:var(--sans);font-size:.9rem;font-weight:600;color:var(--txt2);}
        .cell-grp{display:flex;align-items:center;gap:.4rem;}
        .t-hash{font-family:var(--mono);font-size:.78rem;color:#5a8ab5;letter-spacing:.02em;}
        .t-sig{font-family:var(--mono);font-size:.75rem;color:var(--mut);}
        .sig-av{display:inline-flex;align-items:center;justify-content:center;width:var(--sz,22px);height:var(--sz,22px);border-radius:50%;font-size:var(--fz,.5rem);font-weight:700;flex-shrink:0;background:hsl(var(--hue,180),50%,16%);border:1.5px solid hsl(var(--hue,180),50%,28%);color:hsl(var(--hue,180),75%,72%);transition:transform .2s var(--spring);}
        .row:hover .sig-av{transform:scale(1.1);}

        /* CONF PILL */
        .conf-pill{display:inline-flex;align-items:center;gap:.35rem;padding:.22rem .65rem;border-radius:100px;font-size:.68rem;font-weight:500;letter-spacing:.04em;font-family:var(--sans);white-space:nowrap;background:color-mix(in srgb,var(--cc) 10%,transparent);border:1px solid color-mix(in srgb,var(--cc) 30%,transparent);color:var(--cc);}
        .conf-dot{width:5px;height:5px;border-radius:50%;background:var(--cc);box-shadow:0 0 5px var(--cc);animation:breathe 2s ease-in-out infinite;}

        .t-r-cell{display:flex;align-items:center;justify-content:flex-end;gap:.75rem;}
        .t-blk-age{display:flex;flex-direction:column;align-items:flex-end;gap:1px;}
        .t-blk{font-size:.75rem;color:var(--mut);}
        .t-age{font-size:.65rem;color:var(--dim);}

        /* DETAILS BUTTON */
        .details-btn{display:inline-flex;align-items:center;gap:.3rem;padding:.32rem .7rem;background:rgba(255,255,255,.04);border:1px solid var(--b2);border-radius:7px;font-family:var(--mono);font-size:.65rem;color:var(--mut);cursor:pointer;transition:all .18s;white-space:nowrap;opacity:0;}
        .row:hover .details-btn{opacity:1;}
        .details-btn:hover{color:var(--cyan);border-color:rgba(0,210,255,.35);background:rgba(0,210,255,.07);}

        /* COPY BUTTON */
        .cpbtn{display:inline-flex;align-items:center;justify-content:center;background:rgba(255,255,255,.06);border:1px solid var(--b3);border-radius:6px;cursor:pointer;color:var(--mut);flex-shrink:0;transition:all .18s var(--spring);padding:0;}
        .cpbtn:hover{background:rgba(0,210,255,.12);border-color:rgba(0,210,255,.5);color:var(--cyan2);transform:scale(1.1);}
        .cpbtn:active{transform:scale(.92);}
        .cpbtn-done{background:rgba(0,255,157,.12)!important;border-color:rgba(0,255,157,.45)!important;color:var(--green)!important;}

        /* MODAL OVERLAY */
        .m-overlay{position:fixed;inset:0;z-index:500;display:flex;align-items:center;justify-content:center;padding:1.5rem;background:rgba(0,0,0,.75);backdrop-filter:blur(14px) saturate(.55);animation:ov .2s var(--ease);}
        @keyframes ov{from{opacity:0;}to{opacity:1;}}

        /* MODAL CARD */
        .m-card{background:linear-gradient(160deg,#06101c 0%,#040c16 100%);border:1px solid var(--b2);border-radius:20px;width:100%;max-width:560px;max-height:90vh;overflow-y:auto;box-shadow:0 0 0 1px rgba(0,210,255,.06),0 40px 80px rgba(0,0,0,.7);animation:card-in .3s var(--spring);}
        @keyframes card-in{from{opacity:0;transform:translateY(20px) scale(.96);}to{opacity:1;transform:none;}}
        .m-card::-webkit-scrollbar{width:3px;}
        .m-card::-webkit-scrollbar-thumb{background:var(--b2);border-radius:2px;}

        /* modal header */
        .m-head{display:flex;align-items:flex-start;gap:1rem;padding:1.75rem 1.75rem 1.25rem;}
        .m-head-info{flex:1;min-width:0;}
        .m-eyebrow{display:flex;align-items:center;gap:.4rem;font-size:.58rem;letter-spacing:.2em;text-transform:uppercase;color:var(--cyan);margin-bottom:.5rem;opacity:.8;}
        .m-eyebrow-hex{font-size:.7rem;}
        .m-repo-name{font-family:var(--sans);font-size:1.35rem;font-weight:700;color:var(--txt2);line-height:1.2;margin-bottom:.25rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}

        /* STATUS BLOCK — four semantic tiers, no silly 100% bar */
        .m-status-block{display:flex;flex-direction:column;align-items:flex-end;gap:.25rem;flex-shrink:0;}
        .m-status-badge{display:inline-flex;align-items:center;gap:.4rem;padding:.32rem .8rem;border-radius:100px;font-size:.78rem;font-weight:600;letter-spacing:.04em;font-family:var(--sans);background:color-mix(in srgb,var(--cc) 12%,transparent);border:1px solid color-mix(in srgb,var(--cc) 35%,transparent);color:var(--cc);}
        .m-status-dot{width:7px;height:7px;border-radius:50%;background:var(--cc);box-shadow:0 0 8px var(--cc);animation:breathe 1.8s ease-in-out infinite;}
        .m-status-meta{font-size:.65rem;color:var(--mut);text-align:right;letter-spacing:.04em;}

        .m-close{display:flex;align-items:center;justify-content:center;width:32px;height:32px;background:rgba(255,255,255,.05);border:1px solid var(--b2);border-radius:8px;color:var(--mut);cursor:pointer;flex-shrink:0;align-self:flex-start;transition:all .15s;}
        .m-close:hover{background:rgba(255,77,109,.12);border-color:rgba(255,77,109,.3);color:var(--red);}

        /* accent line picks up status color */
        .m-accent{height:1px;margin:0 1.75rem;background:linear-gradient(90deg,var(--cc,var(--cyan)),transparent);opacity:.3;}

        /* modal body */
        .m-body{display:grid;grid-template-columns:1fr 1fr;gap:.85rem;padding:1.5rem 1.75rem;}
        .m-field-span{grid-column:1/-1;}
        .m-label{font-size:.58rem;letter-spacing:.18em;text-transform:uppercase;color:var(--mut);margin-bottom:.4rem;}
        .m-val{display:flex;align-items:center;gap:.6rem;background:rgba(0,0,0,.3);border:1px solid var(--b1);border-radius:10px;padding:.75rem .9rem;min-height:48px;}
        .m-val-feature{border-color:rgba(0,210,255,.2);background:rgba(0,210,255,.03);}
        .m-mono{font-family:var(--mono);}
        .m-val-text{font-size:.8rem;color:var(--txt);word-break:break-all;flex:1;min-width:0;line-height:1.55;}
        .m-val-feature .m-val-text{color:var(--cyan2);}
        .m-block-val{font-family:var(--mono);font-size:.95rem;color:var(--txt2);font-weight:500;flex:1;}
        .m-age-val{font-family:var(--sans);font-size:.95rem;color:var(--txt2);font-weight:500;flex:1;}

        /* modal actions */
        .m-actions{display:flex;flex-wrap:wrap;gap:.65rem;padding:0 1.75rem 1.75rem;}
        .m-btn{display:inline-flex;align-items:center;gap:.45rem;padding:.62rem 1.1rem;border-radius:9px;font-family:var(--mono);font-size:.72rem;letter-spacing:.05em;cursor:pointer;transition:all .18s;white-space:nowrap;flex:1;justify-content:center;}
        .m-btn-primary{background:linear-gradient(135deg,rgba(0,210,255,.14),rgba(0,80,255,.1));border:1px solid rgba(0,210,255,.3);color:var(--cyan);}
        .m-btn-primary:hover{background:linear-gradient(135deg,rgba(0,210,255,.24),rgba(0,80,255,.18));border-color:var(--cyan);box-shadow:0 0 20px rgba(0,210,255,.1);}
        .m-btn:not(.m-btn-primary):not(.m-btn-cli){background:rgba(255,255,255,.04);border:1px solid var(--b2);color:var(--mut);}
        .m-btn:not(.m-btn-primary):not(.m-btn-cli):hover{border-color:var(--b3);color:var(--txt);}
        .m-btn-cli{background:rgba(0,255,157,.05);border:1px solid rgba(0,255,157,.2);color:rgba(0,255,157,.85);}
        .m-btn-cli:hover{background:rgba(0,255,157,.1);border-color:rgba(0,255,157,.4);color:var(--green);}
        .m-btn:active{transform:scale(.97);}

        /* EMPTY */
        .empty{padding:5rem 2rem;text-align:center;}
        .e-icon{font-size:3rem;opacity:.15;margin-bottom:1.25rem;}
        .e-title{font-family:var(--disp);font-size:1.6rem;letter-spacing:.12em;color:var(--mut);margin-bottom:.5rem;}
        .e-body{font-size:.78rem;color:var(--dim);letter-spacing:.04em;margin-bottom:1.5rem;line-height:1.7;}
        .e-code{font-family:var(--mono);color:var(--amber);background:rgba(245,166,35,.08);padding:.1rem .35rem;border-radius:3px;}
        .term{display:inline-block;background:rgba(0,0,0,.5);border:1px solid var(--b2);border-radius:8px;padding:.6rem 1.3rem;font-size:.78rem;color:var(--green);}
        .term::before{content:'$ ';color:var(--mut);}

        /* SPINNER */
        .spin-c{padding:4.5rem 2rem;display:flex;flex-direction:column;align-items:center;gap:1.1rem;}
        .spin-orbit{position:relative;width:48px;height:48px;display:flex;align-items:center;justify-content:center;}
        .spin-r1,.spin-r2{position:absolute;inset:0;border-radius:50%;border:2px solid transparent;}
        .spin-r1{border-top-color:var(--cyan);border-right-color:rgba(0,200,255,.25);animation:srot .9s linear infinite;}
        .spin-r2{inset:8px;border-top-color:var(--amber);border-right-color:rgba(245,166,35,.25);animation:srot 1.3s linear infinite reverse;}
        .spin-core{width:7px;height:7px;border-radius:50%;background:var(--cyan);box-shadow:0 0 10px var(--cyan);animation:breathe 1.5s ease-in-out infinite;}
        @keyframes srot{to{transform:rotate(360deg);}}
        .spin-lbl{font-size:.72rem;color:var(--mut);letter-spacing:.18em;text-transform:uppercase;}
        .spin-sub{font-size:.63rem;color:var(--dim);letter-spacing:.04em;}

        /* PANEL FOOT */
        .pf{display:flex;align-items:center;justify-content:space-between;padding:.9rem 1.25rem;border-top:1px solid var(--b1);background:rgba(0,0,0,.18);gap:1rem;flex-wrap:wrap;}
        .pf-cmd{font-size:.72rem;color:var(--mut);letter-spacing:.03em;}
        .pf-dol{color:var(--green);margin-right:.4rem;}
        .pf-r{display:flex;align-items:center;gap:1.1rem;}
        .pf-rec{font-size:.65rem;color:var(--dim);letter-spacing:.06em;}
        .pf-link{font-size:.65rem;color:rgba(0,200,255,.5);text-decoration:none;letter-spacing:.05em;transition:color .15s;}
        .pf-link:hover{color:var(--cyan);}

        /* SITE FOOTER */
        .site-foot{margin-top:2rem;padding:1.1rem 0;border-top:1px solid var(--b1);display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap;}
        .foot-l{display:flex;align-items:center;gap:.6rem;font-size:.65rem;color:var(--dim);letter-spacing:.07em;}
        .foot-logo{font-family:var(--disp);font-size:.9rem;color:var(--mut);letter-spacing:.2em;}
        .foot-sep{color:var(--b3);}
        .foot-addr{font-size:.62rem;color:var(--dim);font-family:var(--mono);letter-spacing:.04em;}

        /* TOASTS */
        .toast-stack{position:fixed;bottom:1.5rem;right:1.5rem;z-index:9999;display:flex;flex-direction:column;gap:.5rem;pointer-events:none;}
        .toast{display:flex;align-items:center;gap:.55rem;padding:.65rem 1.1rem;border-radius:9px;font-family:var(--mono);font-size:.72rem;letter-spacing:.04em;backdrop-filter:blur(14px);animation:tIn .3s var(--spring) both,tOut .3s var(--ease) 2.9s both;}
        @keyframes tIn{from{opacity:0;transform:translateY(8px) scale(.95);}to{opacity:1;transform:none;}}
        @keyframes tOut{from{opacity:1;}to{opacity:0;transform:translateY(4px);}}
        .toast-copy{background:rgba(8,20,34,.94);border:1px solid rgba(0,200,255,.25);color:var(--txt2);}
        .toast-new{background:rgba(8,20,34,.94);border:1px solid rgba(0,255,157,.35);color:var(--green2);}
        .ti{font-size:.8rem;}

        @media(max-width:900px){.stats{grid-template-columns:repeat(2,1fr);}}
        @media(max-width:700px){
          .s-in{width:185px;}.ph{flex-direction:column;align-items:flex-start;}
          .hero-title{font-size:3.5rem;}.topbar{flex-wrap:wrap;gap:.75rem;}.t-nav{display:none;}
          .m-body{grid-template-columns:1fr;}.pf{flex-direction:column;align-items:flex-start;}
          .m-actions{flex-direction:column;}.m-btn{flex:none;width:100%;}
          .m-head{flex-wrap:wrap;}.m-status-block{width:100%;align-items:flex-start;margin-top:.5rem;}
        }
      `}</style>
      <ToastProvider><AppContent /></ToastProvider>
    </>
  );
}
