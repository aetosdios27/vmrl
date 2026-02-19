"use client";

import {
  useState, useEffect, useCallback, useRef, useMemo,
  createContext, useContext
} from "react";
import { createPublicClient, http, parseAbiItem } from "viem";
import { baseSepolia } from "viem/chains";

// --- CONFIGURATION ---
const CONTRACT_ADDRESS = "0xe0C0B432380a07177372d10DF61BAFedAB9D8367";

const rpcClient = createPublicClient({
  chain: baseSepolia,
  transport: http("https://sepolia.base.org"),
});

const eventAbi = parseAbiItem(
  "event NewReceipt(string indexed repoId, bytes32 indexed commitHash, address indexed signer, uint256 receiptId)"
);

// --- TYPES ---
type Receipt = {
  repoId: string | undefined;
  commitHash: string | undefined;
  signer: string | undefined;
  id: string;
  blockNumber: bigint;
};
type Toast = { id: number; message: string; type: "new" | "copy" };

// --- UTILS ---
function timeAgo(block: bigint, latest: bigint): string {
  const s = Number(latest - block) * 2;
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
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

// --- TOAST CONTEXT ---
const ToastCtx = createContext<(msg: string, type?: Toast["type"]) => void>(() => {});
function useToast() { return useContext(ToastCtx); }

function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);
  const push = useCallback((message: string, type: Toast["type"] = "copy") => {
    const id = ++nextId.current;
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

// --- COMPONENTS ---

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
    const nodes = Array.from({ length: 40 }, () => ({
      x: Math.random() * window.innerWidth, y: Math.random() * window.innerHeight,
      vx: (Math.random() - 0.5) * 0.2, vy: (Math.random() - 0.5) * 0.2,
      r: Math.random() * 1.5 + 0.5,
    }));
    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      nodes.forEach(n => {
        n.x += n.vx; n.y += n.vy;
        if (n.x < 0 || n.x > canvas.width) n.vx *= -1;
        if (n.y < 0 || n.y > canvas.height) n.vy *= -1;
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(0, 200, 255, 0.15)`; ctx.fill();
      });
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const dx = nodes[i].x - nodes[j].x, dy = nodes[i].y - nodes[j].y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < 150) {
            ctx.beginPath(); ctx.moveTo(nodes[i].x, nodes[i].y); ctx.lineTo(nodes[j].x, nodes[j].y);
            ctx.strokeStyle = `rgba(0, 200, 255, ${1 - dist / 150})`; ctx.lineWidth = 0.5; ctx.stroke();
          }
        }
      }
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => { cancelAnimationFrame(raf); window.removeEventListener("resize", resize); window.removeEventListener("mousemove", onMouse); };
  }, []);
  return <canvas ref={ref} style={{ position: "fixed", inset: 0, zIndex: 0, pointerEvents: "none", opacity: 0.4 }} />;
}

function Glitch({ children }: { children: string }) {
  return <span className="glitch" data-text={children}>{children}</span>;
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
  return (
    <button className={`cpbtn ${done ? "cpbtn-done" : ""}`} onClick={onClick} style={{ width: size, height: size }} title="Copy">
      {done ? "✓" : "❐"}
    </button>
  );
}

function SignerAvatar({ addr }: { addr: string | undefined }) {
  const hue = addrHue(addr);
  return (
    <span className="sig-av" style={{ "--hue": hue } as React.CSSProperties} title={addr}>
      {addr ? addr.slice(2, 4).toUpperCase() : "??"}
    </span>
  );
}

function ReceiptModal({ r, latest, onClose }: { r: Receipt; latest: bigint; onClose: () => void }) {
  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [onClose]);

  return (
    <div className="m-overlay" onClick={onClose}>
      <div className="m-card" onClick={e => e.stopPropagation()}>
        <div className="m-head">
          <div>
            <div className="m-eyebrow">Receipt #{r.id}</div>
            <div className="m-repo">{r.repoId ?? "Unknown Repo"}</div>
          </div>
          <button className="m-close" onClick={onClose}>✕</button>
        </div>
        <div className="m-body">
          <div className="m-field">
            <div className="m-label">Commit Hash</div>
            <div className="m-val m-mono">
              {r.commitHash} <CopyBtn text={r.commitHash ?? ""} size={20} />
            </div>
          </div>
          <div className="m-field">
            <div className="m-label">Signer Identity</div>
            <div className="m-val">
              <SignerAvatar addr={r.signer} /> <span className="m-mono">{r.signer}</span> <CopyBtn text={r.signer ?? ""} size={20} />
            </div>
          </div>
          <div className="m-field">
            <div className="m-label">Block Number</div>
            <div className="m-val m-mono">#{r.blockNumber.toString()}</div>
          </div>
          <div className="m-field">
            <div className="m-label">Age</div>
            <div className="m-val">{timeAgo(r.blockNumber, latest)}</div>
          </div>
        </div>
        <div className="m-actions">
          <a className="m-btn" href={`https://sepolia.basescan.org/block/${r.blockNumber}`} target="_blank" rel="noreferrer">View on BaseScan ↗</a>
        </div>
      </div>
    </div>
  );
}

// --- MAIN APP ---

function AppContent() {
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [loading, setLoading] = useState(true);
  const [latest, setLatest] = useState<bigint>(BigInt(0));
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Receipt | null>(null);
  const [newIds, setNewIds] = useState<Set<string>>(new Set());
  const toast = useToast();

  const doFetch = useCallback(async () => {
    try {
      const lb = await rpcClient.getBlockNumber();
      setLatest(lb);

      // FIX: Always scan from the very beginning so we never miss old anchors
      const logs = await rpcClient.getLogs({
        address: CONTRACT_ADDRESS,
        event: eventAbi,
        fromBlock: BigInt(0),
        toBlock: lb
      });

      const fmt: Receipt[] = logs.map(l => ({
        repoId: l.args.repoId,
        commitHash: l.args.commitHash as string,
        signer: l.args.signer,
        id: l.args.receiptId?.toString() ?? "—",
        blockNumber: l.blockNumber ?? BigInt(0),
      })).reverse();

      setReceipts(prev => {
        const prevSet = new Set(prev.map(r => r.id));
        const fresh = fmt.filter(r => !prevSet.has(r.id));
        if (fresh.length > 0) {
          setNewIds(new Set(fresh.map(r => r.id)));
          setTimeout(() => toast(`${fresh.length} new anchor${fresh.length > 1 ? "s" : ""}`, "new"), 100);
        }
        return fmt;
      });
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  }, [toast]);

  useEffect(() => { doFetch(); const t = setInterval(doFetch, 5000); return () => clearInterval(t); }, [doFetch]);

  const displayed = useMemo(() => {
    if (!search) return receipts;
    const q = search.toLowerCase();
    return receipts.filter(r =>
      r.repoId?.toLowerCase().includes(q) ||
      r.commitHash?.toLowerCase().includes(q) ||
      r.signer?.toLowerCase().includes(q)
    );
  }, [receipts, search]);

  return (
    <div className="page">
      <NetworkCanvas />
      <div className="inner">
        <header className="head">
          <div className="logo"><Glitch>VMRL</Glitch> <span className="logo-sub">EXPLORER</span></div>
          <div className="net-badge"><span className="dot" />Base Sepolia</div>
        </header>

        <section className="hero">
          <h1 className="hero-t">Immutable Code Provenance</h1>
          <p className="hero-sub">Public Ledger for Software Supply Chain Security</p>
        </section>

        <div className="panel">
          <div className="search-bar">
            <span className="search-icon">🔍</span>
            <input
              className="search-input"
              placeholder="Filter by repo, hash, or signer..."
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            {search && <button className="clear-btn" onClick={() => setSearch("")}>✕</button>}
          </div>

          <div className="table-wrap">
            {loading ? (
              <div className="loading">Scanning Ledger...</div>
            ) : displayed.length === 0 ? (
              <div className="empty">No receipts found.</div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Repo ID</th>
                    <th>Commit Hash</th>
                    <th>Signer</th>
                    <th>Age</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {displayed.map(r => (
                    <tr key={r.id} className={newIds.has(r.id) ? "row-new" : ""} onClick={() => setSelected(r)}>
                      <td className="col-repo">{r.repoId}</td>
                      <td className="col-mono">{short(r.commitHash)}</td>
                      <td className="col-sig"><SignerAvatar addr={r.signer} /> {short(r.signer, 6, 4)}</td>
                      <td className="col-age">{timeAgo(r.blockNumber, latest)}</td>
                      <td><button className="view-btn">View</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <footer className="foot">
          Contract: <span className="foot-addr">{CONTRACT_ADDRESS}</span>
        </footer>
      </div>

      {selected && <ReceiptModal r={selected} latest={latest} onClose={() => setSelected(null)} />}
    </div>
  );
}

export default function Home() {
  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&family=Inter:wght@400;600;800&display=swap');
        :root{--bg:#050505;--fg:#e0e0e0;--acc:#00d4ff;--acc2:#00ff9d;--dim:#333;--bord:#222;}
        *{box-sizing:border-box;}
        body{background:var(--bg);color:var(--fg);font-family:'Inter',sans-serif;margin:0;}
        .page{min-height:100vh;position:relative;overflow-x:hidden;}
        .inner{max-width:1000px;margin:0 auto;padding:2rem;position:relative;z-index:1;}

        .head{display:flex;justify-content:space-between;align-items:center;margin-bottom:3rem;}
        .logo{font-size:1.5rem;font-weight:800;letter-spacing:-0.05em;color:var(--acc);}
        .logo-sub{color:#666;font-size:0.8rem;letter-spacing:0.2em;margin-left:0.5rem;}
        .net-badge{background:#111;border:1px solid #333;padding:0.3rem 0.8rem;border-radius:20px;font-size:0.75rem;display:flex;align-items:center;gap:0.4rem;color:#888;}
        .dot{width:6px;height:6px;background:var(--acc2);border-radius:50%;box-shadow:0 0 8px var(--acc2);}

        .hero{text-align:center;margin-bottom:3rem;}
        .hero-t{font-size:3rem;font-weight:800;margin:0 0 0.5rem 0;background:linear-gradient(to right, #fff, #888);-webkit-background-clip:text;-webkit-text-fill-color:transparent;}
        .hero-sub{color:#666;}

        .panel{background:#0a0a0a;border:1px solid var(--bord);border-radius:12px;overflow:hidden;box-shadow:0 20px 40px rgba(0,0,0,0.5);}
        .search-bar{padding:1rem;border-bottom:1px solid var(--bord);display:flex;align-items:center;gap:0.8rem;}
        .search-input{background:transparent;border:none;color:#fff;font-family:'IBM Plex Mono';font-size:0.9rem;flex:1;outline:none;}
        .search-icon{opacity:0.5;}
        .clear-btn{background:none;border:none;color:#666;cursor:pointer;}

        .table-wrap{overflow-x:auto;}
        table{width:100%;border-collapse:collapse;font-size:0.9rem;}
        th{text-align:left;padding:1rem;color:#555;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.1em;border-bottom:1px solid var(--bord);}
        td{padding:1rem;border-bottom:1px solid #111;}
        tr:last-child td{border-bottom:none;}
        tr:hover{background:#111;cursor:pointer;}
        .row-new{animation:flash 1s ease;}
        @keyframes flash{0%{background:rgba(0,255,157,0.1);}100%{background:transparent;}}

        .col-repo{font-weight:600;color:#fff;}
        .col-mono{font-family:'IBM Plex Mono';color:#888;}
        .col-sig{display:flex;align-items:center;gap:0.5rem;font-family:'IBM Plex Mono';font-size:0.8rem;color:#666;}
        .col-age{color:#444;font-size:0.8rem;}

        .view-btn{background:#111;border:1px solid #333;color:#888;padding:0.3rem 0.8rem;border-radius:4px;cursor:pointer;font-size:0.75rem;transition:all 0.2s;}
        tr:hover .view-btn{background:var(--acc);color:#000;border-color:var(--acc);}

        .sig-av{width:20px;height:20px;border-radius:50%;background:hsl(var(--hue), 60%, 20%);color:hsl(var(--hue), 80%, 70%);display:flex;align-items:center;justify-content:center;font-size:0.5rem;font-weight:bold;border:1px solid hsl(var(--hue), 50%, 30%);}

        .loading, .empty{padding:3rem;text-align:center;color:#444;}

        .cpbtn{background:none;border:none;color:#555;cursor:pointer;font-size:12px;margin-left:5px;}
        .cpbtn:hover{color:var(--acc);}
        .cpbtn-done{color:var(--acc2);}

        .m-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.8);backdrop-filter:blur(5px);z-index:100;display:flex;align-items:center;justify-content:center;padding:1rem;}
        .m-card{background:#0f0f0f;border:1px solid #333;width:100%;max-width:500px;border-radius:12px;overflow:hidden;animation:up 0.2s ease-out;}
        @keyframes up{from{transform:translateY(20px);opacity:0;}to{transform:translateY(0);opacity:1;}}
        .m-head{padding:1.5rem;border-bottom:1px solid #222;display:flex;justify-content:space-between;align-items:start;}
        .m-eyebrow{font-size:0.7rem;text-transform:uppercase;color:var(--acc);letter-spacing:0.1em;margin-bottom:0.3rem;}
        .m-repo{font-size:1.2rem;font-weight:800;}
        .m-close{background:none;border:none;color:#555;font-size:1.2rem;cursor:pointer;}
        .m-close:hover{color:#fff;}
        .m-body{padding:1.5rem;}
        .m-field{margin-bottom:1.5rem;}
        .m-label{font-size:0.75rem;color:#555;margin-bottom:0.4rem;text-transform:uppercase;letter-spacing:0.05em;}
        .m-val{font-size:0.95rem;word-break:break-all;display:flex;align-items:center;gap:0.5rem;}
        .m-mono{font-family:'IBM Plex Mono';color:#ccc;}
        .m-actions{padding:1.5rem;background:#050505;border-top:1px solid #222;}
        .m-btn{display:block;width:100%;padding:0.8rem;text-align:center;background:#161616;color:#ccc;text-decoration:none;border-radius:6px;font-size:0.9rem;border:1px solid #333;transition:all 0.2s;}
        .m-btn:hover{background:#eee;color:#000;}

        .glitch{position:relative;}
        .glitch::before, .glitch::after{content:attr(data-text);position:absolute;top:0;left:0;opacity:0.8;}
        .glitch::before{color:red;z-index:-1;animation:glitch 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94) both infinite;}
        .glitch::after{color:blue;z-index:-2;animation:glitch 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94) reverse both infinite;}
        @keyframes glitch{0%{transform:translate(0)}20%{transform:translate(-2px, 2px)}40%{transform:translate(-2px, -2px)}60%{transform:translate(2px, 2px)}80%{transform:translate(2px, -2px)}100%{transform:translate(0)}}

        .foot{margin-top:2rem;text-align:center;color:#333;font-size:0.75rem;}
        .foot-addr{font-family:'IBM Plex Mono';}

        .toast-stack{position:fixed;bottom:20px;right:20px;z-index:200;}
        .toast{background:#111;border:1px solid #333;padding:0.8rem 1.2rem;margin-top:0.5rem;border-radius:6px;display:flex;align-items:center;gap:0.5rem;font-size:0.85rem;animation:tin 0.2s ease-out;}
        .ti{color:var(--acc);}
        @keyframes tin{from{opacity:0;transform:translateY(10px);}to{opacity:1;transform:translateY(0);}}
      `}</style>
      <ToastProvider><AppContent /></ToastProvider>
    </>
  );
}
