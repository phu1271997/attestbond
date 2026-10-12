import { CONTRACT_ADDRESS, NETWORK, GLJS } from "./config.js";

const { createClient } = await import(GLJS);
const { TransactionStatus } = await import(GLJS + "/types");

const CHAIN = {
  id: NETWORK.id,
  name: NETWORK.name,
  nativeCurrency: NETWORK.nativeCurrency,
  rpcUrls: { default: { http: [NETWORK.rpcUrl] } },
  defaultNumberOfInitialValidators: 5,
  defaultConsensusMaxRotations: 3,
};
const ZERO = "0x0000000000000000000000000000000000000000";

let wallet = { address: "", chainId: "", ok: false };

// ------------------------------------------------------------------ chain io
function readClient() {
  return createClient({ chain: CHAIN, endpoint: NETWORK.rpcUrl, account: { address: ZERO } });
}
async function writeClient() {
  const c = createClient({ chain: CHAIN, account: wallet.address });
  if (c.initializeConsensusSmartContract) await c.initializeConsensusSmartContract();
  return c;
}
async function read(fn, args = []) {
  return readClient().readContract({ address: CONTRACT_ADDRESS, functionName: fn, args });
}
async function readJSON(fn, args = []) {
  const r = await read(fn, args);
  return typeof r === "string" ? JSON.parse(r) : r;
}
async function write(fn, args, value = 0n) {
  const c = await writeClient();
  return c.writeContract({ address: CONTRACT_ADDRESS, functionName: fn, args, value });
}
async function waitAccepted(hash) {
  return readClient().waitForTransactionReceipt({ hash, status: TransactionStatus.ACCEPTED, retries: 200, interval: 4000 });
}

// -------------------------------------------------------------------- wallet
function provider() {
  if (!window.ethereum) throw new Error("No injected wallet found. Install MetaMask.");
  return window.ethereum;
}
async function refreshWallet() {
  if (!window.ethereum) { wallet = { address: "", chainId: "", ok: false }; return; }
  const p = provider();
  const accs = await p.request({ method: "eth_accounts" });
  const chainId = String(await p.request({ method: "eth_chainId" }));
  wallet = { address: accs[0] || "", chainId, ok: chainId.toLowerCase() === NETWORK.hexId };
}
async function connect() {
  const p = provider();
  const accs = await p.request({ method: "eth_requestAccounts" });
  wallet.address = accs[0] || "";
  await switchNet();
  await refreshWallet();
  renderWallet();
  route();
}
async function switchNet() {
  const p = provider();
  try {
    await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: NETWORK.hexId }] });
  } catch (e) {
    if (e && e.code === 4902) {
      await p.request({ method: "wallet_addEthereumChain", params: [{
        chainId: NETWORK.hexId, chainName: NETWORK.name, nativeCurrency: NETWORK.nativeCurrency,
        rpcUrls: [NETWORK.rpcUrl], blockExplorerUrls: [NETWORK.explorerUrl] }] });
    } else { throw e; }
  }
  await refreshWallet();
  renderWallet();
}

// --------------------------------------------------------------------- utils
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const short = (a) => (a && a.length > 12 ? a.slice(0, 6) + "…" + a.slice(-4) : a || "—");
const genFmt = (wei) => { try { return (Number(BigInt(wei)) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 6 }) + " GEN"; } catch { return wei + " wei"; } };
const txUrl = (h) => `${NETWORK.explorerUrl}/tx/${h}`;
const addrUrl = (a) => `${NETWORK.explorerUrl}/address/${a}`;
const whenTs = (t) => (t ? new Date(t * 1000).toLocaleString() : "—");
function setStatus(el, kind, msg, hash) {
  const link = hash ? ` <a href="${txUrl(hash)}" target="_blank" rel="noopener">view tx ↗</a>` : "";
  if (kind === "busy") el.innerHTML = `<span class="spinner"></span><span>${esc(msg)}</span>`;
  else if (kind === "err") el.innerHTML = `<span class="err">✗ ${esc(msg)}</span>`;
  else el.innerHTML = `<span class="good">✓ ${esc(msg)}</span>${link}`;
}

// ------------------------------------------------------------- wallet header
function renderWallet() {
  const el = $("#wallet");
  if (!window.ethereum) { el.innerHTML = `<span class="pill bad">No wallet</span>`; return; }
  if (!wallet.address) { el.innerHTML = `<button class="primary" id="connect">Connect wallet</button>`; $("#connect").onclick = () => connect().catch((e) => alert(e.message)); return; }
  const net = wallet.ok ? `<span class="pill ok">Studionet</span>` : `<button id="switch">Switch to Studionet</button>`;
  el.innerHTML = `${net}<span class="pill" title="${wallet.address}"><a href="${addrUrl(wallet.address)}" target="_blank" rel="noopener">${short(wallet.address)}</a></span>`;
  if ($("#switch")) $("#switch").onclick = () => switchNet().then(route).catch((e) => alert(e.message));
}

async function ensureReady() {
  if (!window.ethereum) throw new Error("Install MetaMask to sign transactions.");
  if (!wallet.address) { await connect(); }
  if (!wallet.ok) { await switchNet(); }
  if (!wallet.ok) throw new Error("Switch your wallet to GenLayer Studionet (chain 61999).");
}

// ---------------------------------------------------------------------- views
function setTab(view) {
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
}

async function viewBoard() {
  setTab("board");
  const v = $("#view");
  v.innerHTML = `<div class="banner">Reviews run on GenLayer validators and take ~15–40s to reach consensus. Each verdict and rationale come from that consensus, not from this site.</div><div id="list"><div class="empty"><span class="spinner"></span> loading attestations…</div></div>`;
  try {
    const items = await readJSON("list_attestations", [0, 50]);
    const list = $("#list");
    if (!items.length) { list.innerHTML = `<div class="empty">No attestations yet. File the first one.</div>`; return; }
    list.innerHTML = items.map(cardHTML).join("");
    list.querySelectorAll(".order").forEach((c) => (c.onclick = () => (location.hash = `#/claim/${c.dataset.id}`)));
  } catch (e) {
    $("#list").innerHTML = `<div class="empty err">Could not load attestations: ${esc(e.message)}</div>`;
  }
}

function cardHTML(a) {
  return `<div class="order" data-id="${a.id}">
    <div class="hd"><span class="title">#${a.id} · ${esc(a.claim.slice(0, 80))}${a.claim.length > 80 ? "…" : ""}</span>
      <span class="badge ${a.status}">${a.status}</span></div>
    <div class="meta">stake ${genFmt(a.stake)} · attester ${short(a.attester)} · settle by ${whenTs(a.settle_by)}${a.verdict !== "NONE" ? ` · AI verdict ${a.verdict} (${a.confidence}%)` : ""}</div>
  </div>`;
}

async function viewFile() {
  setTab("file");
  const v = $("#view");
  v.innerHTML = `<div class="card">
    <h2>File a staked attestation</h2>
    <div class="sub">Stake GEN behind a public claim about yourself or your project. Validators read the live sources and rule SUPPORTED (stake returns, reputation rises) or REFUTED (the challenger receives your stake, reputation falls).</div>
    <label>Challenger address (receives the stake if your claim is REFUTED — must differ from you)</label>
    <input id="challenger" placeholder="0x…" />
    <label>Claim — the public statement you stand behind</label>
    <textarea id="claim" rows="2" placeholder="e.g. Our smart-contract audit by Acme Security is published at the link below."></textarea>
    <label>Check rule — how a validator should verify it from the sources</label>
    <textarea id="rule" rows="2" placeholder="e.g. A source must show a published audit report naming our project and Acme Security."></textarea>
    <label>Source URL(s) — 1 to 3 public https links, one per line</label>
    <textarea id="urls" rows="3" placeholder="https://acme-security.example/reports/ourproject.pdf"></textarea>
    <label>Settle-by (local time)</label>
    <input id="settleby" type="datetime-local" />
    <div class="hint">Settle-by must be 5 minutes to 90 days from now. You can request a review any time before it; no maturity wait.</div>
    <label>Stake (GEN)</label>
    <input id="stake" type="number" step="0.0001" min="0" value="0.001" />
    <div class="inline-actions"><button class="primary" id="submit">Stake &amp; file attestation</button></div>
    <div class="status-line" id="st"></div>
  </div>`;
  const d = new Date(Date.now() + 20 * 60 * 1000);
  $("#settleby").value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  $("#submit").onclick = submitAttestation;
}

async function submitAttestation() {
  const st = $("#st");
  try {
    await ensureReady();
    const challenger = $("#challenger").value.trim();
    const claim = $("#claim").value.trim();
    const rule = $("#rule").value.trim();
    const urls = $("#urls").value.split("\n").map((s) => s.trim()).filter(Boolean);
    const settleby = Math.floor(new Date($("#settleby").value).getTime() / 1000);
    const stake = BigInt(Math.round(parseFloat($("#stake").value) * 1e18));
    if (!/^0x[0-9a-fA-F]{40}$/.test(challenger)) throw new Error("Enter a valid challenger address.");
    if (!claim || !rule || !urls.length) throw new Error("Fill in the claim, rule and at least one source URL.");
    if (!(stake > 0n)) throw new Error("Stake must be greater than zero.");
    setStatus(st, "busy", "Awaiting signature in your wallet…");
    const hash = await write("file_attestation", [challenger, claim, rule, urls, settleby], stake);
    setStatus(st, "busy", "Submitted. Waiting for the network to accept it…", hash);
    await waitAccepted(hash);
    const count = Number(await read("get_attestation_count", []));
    const id = String(count - 1);
    const a = await readJSON("get_attestation", [id]);
    if (a.status === "OPEN" && a.claim === claim) {
      setStatus(st, "ok", `Attestation #${id} filed and staked.`, hash);
      setTimeout(() => (location.hash = `#/claim/${id}`), 900);
    } else {
      const reason = await read("get_last_reject", [wallet.address]);
      setStatus(st, "err", `Rejected: ${reason || "invalid terms"}. Your stake is held as withdrawable credit (see My account).`);
    }
  } catch (e) {
    setStatus(st, "err", e.message || String(e));
  }
}

async function viewClaim(id) {
  const v = $("#view");
  v.innerHTML = `<div class="card"><div class="empty"><span class="spinner"></span> loading attestation #${esc(id)}…</div></div>`;
  let a;
  try { a = await readJSON("get_attestation", [id]); }
  catch { v.innerHTML = `<div class="card"><div class="empty err">Attestation #${esc(id)} not found.</div><button id="back">← attestations</button></div>`; $("#back").onclick = () => (location.hash = "#/"); return; }
  const now = Math.floor(Date.now() / 1000);
  const over = now >= a.settle_by;
  const canReview = a.status === "OPEN" && !over;
  const canLapse = a.status === "OPEN" && over;
  let rep = null;
  try { rep = await readJSON("get_reputation", [a.attester]); } catch {}
  v.innerHTML = `<div class="card">
    <div class="hd" style="display:flex;justify-content:space-between;align-items:center;gap:12px">
      <h2 style="margin:0">Attestation #${esc(a.id)}</h2><span class="badge ${a.status}">${a.status}</span></div>
    <div class="reason" style="border-left-color:var(--accent-2)"><strong>Claim.</strong> ${esc(a.claim)}</div>
    <div class="kv">
      <div class="k">Check rule</div><div class="v">${esc(a.check_rule)}</div>
      <div class="k">Stake</div><div class="v">${genFmt(a.stake)}</div>
      <div class="k">Attester</div><div class="v mono"><a href="${addrUrl(a.attester)}" target="_blank" rel="noopener">${esc(a.attester)}</a>${rep ? ` · reputation ${rep.score}/100 (${rep.supported}✓ / ${rep.refuted}✗)` : ""}</div>
      <div class="k">Challenger</div><div class="v mono"><a href="${addrUrl(a.challenger)}" target="_blank" rel="noopener">${esc(a.challenger)}</a></div>
      <div class="k">Settle by</div><div class="v">${whenTs(a.settle_by)}</div>
      <div class="k">Reviews run</div><div class="v">${a.review_count}</div>
      ${a.settlement === "PAID" ? `<div class="k">Settled to</div><div class="v mono">${short(a.recipient)} (${a.recipient.toLowerCase() === a.attester.toLowerCase() ? "attester" : "challenger"})</div>` : ""}
    </div>
    <details class="ev"><summary>Source evidence (${a.source_urls.length} URL${a.source_urls.length > 1 ? "s" : ""})</summary>
      ${a.source_urls.map((u) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(u)} ↗</a>`).join("")}</details>
    ${a.verdict !== "NONE" ? `<div class="reason"><strong>Validator verdict: <span class="badge ${a.verdict}">${a.verdict}</span> · confidence ${a.confidence}%</strong><br/>${esc(a.reason)}</div>` : `<div class="hint" style="margin-top:14px">No ruling yet.</div>`}
    <div class="inline-actions">
      ${canReview ? `<button class="primary" id="review">Run validator review</button>` : ""}
      ${canLapse ? `<button id="lapse">Lapse (return stake to attester)</button>` : ""}
      <button id="back">← attestations</button>
    </div>
    <div class="status-line" id="st"></div>
  </div>`;
  $("#back").onclick = () => (location.hash = "#/");
  if ($("#review")) $("#review").onclick = () => runWrite("review_attestation", [id], "Validators are rendering the sources and judging the claim… (~15–40s)", id);
  if ($("#lapse")) $("#lapse").onclick = () => runWrite("lapse_attestation", [id], "Lapsing the attestation…", id);
}

async function runWrite(fn, args, busyMsg, id) {
  const st = $("#st");
  try {
    await ensureReady();
    setStatus(st, "busy", "Awaiting signature in your wallet…");
    const hash = await write(fn, args);
    setStatus(st, "busy", busyMsg, hash);
    await waitAccepted(hash);
    setStatus(st, "ok", "Done. Refreshing…", hash);
    setTimeout(() => viewClaim(id), 1000);
  } catch (e) { setStatus(st, "err", e.message || String(e)); }
}

async function viewReputation() {
  setTab("reputation");
  const v = $("#view");
  v.innerHTML = `<div class="card">
    <h2>Reputation lookup</h2>
    <div class="sub">Every resolved attestation folds into a rolling, money-backed reputation for the attester address (an EMA over SUPPORTED=100 / REFUTED=0, starting at 100).</div>
    <label>Address</label>
    <input id="addr" placeholder="0x…" value="${wallet.address || ""}" />
    <div class="inline-actions"><button class="primary" id="look">Look up</button></div>
    <div id="out" style="margin-top:16px"></div>
  </div>`;
  $("#look").onclick = async () => {
    const addr = $("#addr").value.trim();
    const out = $("#out");
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) { out.innerHTML = `<span class="err">Enter a valid address.</span>`; return; }
    out.innerHTML = `<span class="spinner"></span>`;
    try {
      const r = await readJSON("get_reputation", [addr]);
      out.innerHTML = `<div class="kv">
        <div class="k">Reputation score</div><div class="v"><strong>${r.score} / 100</strong></div>
        <div class="k">Supported</div><div class="v good">${r.supported}</div>
        <div class="k">Refuted</div><div class="v err">${r.refuted}</div>
        <div class="k">Resolved total</div><div class="v">${r.resolved}</div>
      </div>${r.seen ? "" : `<div class="hint">This address has no resolved attestations yet (default score 100).</div>`}`;
    } catch (e) { out.innerHTML = `<span class="err">${esc(e.message)}</span>`; }
  };
  if (wallet.address) $("#look").click();
}

async function viewAccount() {
  setTab("account");
  const v = $("#view");
  if (!wallet.address) { v.innerHTML = `<div class="card"><div class="empty">Connect your wallet to see credits and withdraw.</div></div>`; return; }
  v.innerHTML = `<div class="card"><div class="empty"><span class="spinner"></span> loading your account…</div></div>`;
  const credit = await read("get_credit", [wallet.address]);
  const reject = await read("get_last_reject", [wallet.address]);
  const rep = await readJSON("get_reputation", [wallet.address]);
  v.innerHTML = `<div class="card">
    <h2>My account</h2>
    <div class="sub">${esc(short(wallet.address))}</div>
    <div class="kv">
      <div class="k">Reputation</div><div class="v">${rep.score}/100 (${rep.supported}✓ / ${rep.refuted}✗)</div>
      <div class="k">Withdrawable credit</div><div class="v">${genFmt(credit)}</div>
      ${reject ? `<div class="k">Last rejected claim</div><div class="v err">${esc(reject)}</div>` : ""}
    </div>
    <div class="hint">Credit builds up from returned stakes (SUPPORTED / LAPSED), from stakes credited to you as a challenger (REFUTED), or from a claim whose terms were rejected. Withdraw sends it to your wallet.</div>
    <div class="inline-actions">${BigInt(credit) > 0n ? `<button class="primary" id="wd">Withdraw ${genFmt(credit)}</button>` : `<button disabled>Nothing to withdraw</button>`}</div>
    <div class="status-line" id="st"></div>
  </div>`;
  if ($("#wd")) $("#wd").onclick = async () => {
    const st = $("#st");
    try {
      await ensureReady();
      setStatus(st, "busy", "Awaiting signature…");
      const hash = await write("withdraw", [credit.toString()]);
      setStatus(st, "busy", "Withdrawing…", hash);
      await waitAccepted(hash);
      setStatus(st, "ok", "Withdrawn.", hash);
      setTimeout(viewAccount, 1200);
    } catch (e) { setStatus(st, "err", e.message || String(e)); }
  };
}

// --------------------------------------------------------------------- router
function route() {
  const h = location.hash;
  const m = h.match(/^#\/claim\/(\d+)/);
  if (m) return viewClaim(m[1]);
  if (h.startsWith("#/file")) return viewFile();
  if (h.startsWith("#/reputation")) return viewReputation();
  if (h.startsWith("#/account")) return viewAccount();
  return viewBoard();
}

document.querySelectorAll("#tabs button").forEach((b) => {
  b.onclick = () => { location.hash = b.dataset.view === "board" ? "#/" : `#/${b.dataset.view}`; };
});
window.addEventListener("hashchange", route);

$("#contract-foot").innerHTML = CONTRACT_ADDRESS && !CONTRACT_ADDRESS.includes("__")
  ? ` · <a href="${addrUrl(CONTRACT_ADDRESS)}" target="_blank" rel="noopener">contract ${short(CONTRACT_ADDRESS)} ↗</a>` : "";

if (window.ethereum) {
  window.ethereum.on && window.ethereum.on("accountsChanged", () => refreshWallet().then(() => { renderWallet(); route(); }));
  window.ethereum.on && window.ethereum.on("chainChanged", () => refreshWallet().then(() => { renderWallet(); route(); }));
}
await refreshWallet();
renderWallet();
route();
