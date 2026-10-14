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
const SINK = "0x00000000000000000000000000000000000000dead";

let wallet = { address: "", chainId: "", ok: false };

// ------------------------------------------------------------------ chain io
// genlayer-js 0.9.0 routes by account TYPE: a bare address string sends eth_*
// through window.ethereum (MetaMask signs); an account OBJECT routes to the RPC
// endpoint for reads. We keep those two clients strictly separate.
function readClient() {
  return createClient({ chain: CHAIN, endpoint: NETWORK.rpcUrl, account: { address: ZERO } });
}
async function writeClient() {
  const c = createClient({ chain: CHAIN, account: wallet.address });
  // initializeConsensusSmartContract() is fire-and-forget in the constructor;
  // await it before the first write or writeContract throws "not initialized".
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
function waitFor(hash, status) {
  return readClient().waitForTransactionReceipt({ hash, status, retries: 240, interval: 4000 });
}
// The GenVM execution result lives in consensus_data.leader_receipt. ACCEPTED /
// FINALIZED only mean the tx was included — they are NOT proof the code ran. We
// read execution_result and reject anything that is not SUCCESS.
function leaderReceipt(rcpt) {
  const cd = rcpt && rcpt.consensus_data;
  if (!cd) return null;
  let lr = cd.leader_receipt;
  if (Array.isArray(lr)) lr = lr[0];
  return lr || null;
}
// Throws a tagged error (.genvm === true) when a receipt proves the GenVM did
// NOT run successfully, so callers can tell a real execution failure apart from
// a slow/timed-out wait.
function execError(msg) { const e = new Error(String(msg)); e.genvm = true; return e; }
function assertExecuted(rcpt) {
  const lr = leaderReceipt(rcpt);
  if (!lr || lr.execution_result !== "SUCCESS") {
    throw execError((lr && (lr.error || (lr.result && lr.result.payload))) || "GenVM execution did not succeed");
  }
  const st = lr.result && lr.result.status;
  if (st && st !== "return") throw execError(`GenVM returned ${st}: ${(lr.result && lr.result.payload) || ""}`);
  return rcpt;
}

// Full send: sign → wait ACCEPTED → verify GenVM execution → wait FINALIZED →
// verify the FINALIZED receipt ALSO succeeded. We never treat ACCEPTED alone as
// success. A finalized receipt that reverted (or any other proven execution
// failure) is rethrown as an error. A finalization wait that merely times out
// is reported as finalized:false (pending) — it is NOT reported as success.
async function send(st, busyMsg, fn, args, value = 0n) {
  setStatus(st, "busy", "Awaiting signature in your wallet…");
  const hash = await write(fn, args, value);
  setStatus(st, "busy", busyMsg, hash);
  const accepted = await waitFor(hash, TransactionStatus.ACCEPTED);
  assertExecuted(accepted);
  setStatus(st, "busy", "Executed. Confirming finalization on GenLayer…", hash);
  let finalized = false;
  try {
    const fin = await waitFor(hash, TransactionStatus.FINALIZED);
    assertExecuted(fin);          // finalized receipt must also be SUCCESS
    finalized = true;
  } catch (e) {
    if (e && e.genvm) throw e;    // a proven finalization failure surfaces as an error
    finalized = false;            // timed out: executed but finalization still pending
  }
  return { hash, receipt: accepted, finalized };
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
const qid = () => new URLSearchParams(location.search).get("id");
const same = (a, b) => a && b && a.toLowerCase() === b.toLowerCase();
const isSink = (a) => same(a, SINK);
const TERMINAL = ["SUPPORTED", "REFUTED", "LAPSED"];
function setStatus(el, kind, msg, hash) {
  const link = hash ? ` <a href="${txUrl(hash)}" target="_blank" rel="noopener">view tx ↗</a>` : "";
  if (kind === "busy") el.innerHTML = `<span class="spinner"></span><span>${esc(msg)}</span>`;
  else if (kind === "err") el.innerHTML = `<span class="err">✗ ${esc(msg)}</span>`;
  else if (kind === "warn") el.innerHTML = `<span class="warn">⚠ ${esc(msg)}</span>${link}`;
  else el.innerHTML = `<span class="good">✓ ${esc(msg)}</span>${link}`;
}
function payoutWho(a) {
  if (isSink(a.recipient)) return "burned (slashed)";
  if (same(a.recipient, a.attester)) return "attester";
  if (same(a.recipient, a.challenger)) return "challenger";
  return short(a.recipient);
}

// -------------------------------------------------------------------- chrome
const NAV = [
  { href: "/", label: "Attestations", page: "board" },
  { href: "/file", label: "File a claim", page: "file" },
  { href: "/explorer", label: "Explorer", page: "explorer" },
  { href: "/reputation", label: "Reputation", page: "reputation" },
  { href: "/account", label: "My account", page: "account" },
];
function renderNav(current) {
  const el = $("#nav");
  if (el) el.innerHTML = NAV.map((n) => `<a class="tab ${n.page === current ? "active" : ""}" href="${n.href}">${esc(n.label)}</a>`).join("");
}
function renderWallet() {
  const el = $("#wallet");
  if (!el) return;
  if (!window.ethereum) { el.innerHTML = `<span class="pill bad">No wallet</span>`; return; }
  if (!wallet.address) { el.innerHTML = `<button class="primary" id="connect">Connect wallet</button>`; $("#connect").onclick = () => connect().catch((e) => alert(e.message)); return; }
  const net = wallet.ok ? `<span class="pill ok">Studionet</span>` : `<button id="switch">Switch to Studionet</button>`;
  el.innerHTML = `${net}<span class="pill" title="${wallet.address}"><a href="${addrUrl(wallet.address)}" target="_blank" rel="noopener">${short(wallet.address)}</a></span>`;
  if ($("#switch")) $("#switch").onclick = () => switchNet().catch((e) => alert(e.message));
}
function footContract() {
  const el = $("#contract-foot");
  if (el) el.innerHTML = CONTRACT_ADDRESS && !CONTRACT_ADDRESS.includes("__")
    ? ` · <a href="${addrUrl(CONTRACT_ADDRESS)}" target="_blank" rel="noopener">contract ${short(CONTRACT_ADDRESS)} ↗</a>` : "";
}
async function ensureReady() {
  if (!window.ethereum) throw new Error("Install MetaMask to sign transactions.");
  if (!wallet.address) { await connect(); }
  if (!wallet.ok) { await switchNet(); }
  if (!wallet.ok) throw new Error("Switch your wallet to GenLayer Studionet (chain 61999).");
}

// ------------------------------------------------------------- card + verdict
function badge(text) { return `<span class="badge ${text}">${text}</span>`; }
function cardHTML(a) {
  const chal = a.challenged ? ` · <span class="pill">challenged</span>` : "";
  return `<a class="order" href="/claim?id=${a.id}">
    <div class="hd"><span class="title">#${a.id} · ${esc(a.claim.slice(0, 80))}${a.claim.length > 80 ? "…" : ""}</span>${badge(a.status)}</div>
    <div class="meta">stake ${genFmt(a.stake)} · attester ${short(a.attester)} · settle by ${whenTs(a.settle_by)}${chal}${a.verdict !== "NONE" ? ` · AI verdict ${a.verdict} (${a.confidence}%)` : ""}</div>
  </a>`;
}

// --------------------------------------------------------------------- pages
async function pageBoard() {
  const v = $("#view");
  v.innerHTML = `<div class="banner">Reviews run on GenLayer validators and take ~15–40s to reach consensus. Anyone can post a matching bond to <strong>challenge</strong> an open claim; a refuted claim pays an independent challenger or is burned. Verdicts, rationale and reputation come from consensus, not from this site. Resolved claims and payouts are in the <a href="/explorer">Explorer</a>.</div><div id="list"><div class="empty"><span class="spinner"></span> loading attestations…</div></div>`;
  try {
    const items = await readJSON("list_attestations", [0, 50]);
    const open = items.filter((a) => a.status === "OPEN");
    const list = $("#list");
    if (!items.length) { list.innerHTML = `<div class="empty">No attestations yet. <a href="/file">File the first one.</a></div>`; return; }
    list.innerHTML =
      `<h3 class="sect">Open attestations (${open.length})</h3>` +
      (open.length ? open.map(cardHTML).join("") : `<div class="empty">None open right now — see the <a href="/explorer">Explorer</a> for resolved claims.</div>`) +
      `<h3 class="sect">Most recent</h3>` +
      items.slice(0, 6).map(cardHTML).join("");
  } catch (e) {
    $("#list").innerHTML = `<div class="empty err">Could not load attestations: ${esc(e.message)}</div>`;
  }
}

async function pageExplorer() {
  const v = $("#view");
  v.innerHTML = `<div class="card"><h2>Explorer — resolved claims</h2><div class="sub">Terminal verdicts decided by GenLayer validator consensus, with the rationale, the on-chain payout, and the attester's resulting reputation. Public and read-only — no wallet needed.</div><div id="stats"></div></div><div id="list"><div class="empty"><span class="spinner"></span> loading resolved claims…</div></div>`;
  try {
    const items = await readJSON("list_attestations", [0, 50]);
    const resolved = items.filter((a) => TERMINAL.includes(a.status));
    const n = (s) => resolved.filter((a) => a.status === s).length;
    $("#stats").innerHTML = `<div class="kv">
      <div class="k">Total attestations</div><div class="v">${items.length}</div>
      <div class="k">Resolved</div><div class="v">${resolved.length} — ${n("SUPPORTED")} supported · ${n("REFUTED")} refuted · ${n("LAPSED")} lapsed</div>
    </div>`;
    const list = $("#list");
    if (!resolved.length) { list.innerHTML = `<div class="empty">No resolved claims yet.</div>`; return; }
    const rows = await Promise.all(resolved.map(resolvedRow));
    list.innerHTML = rows.join("");
  } catch (e) {
    $("#list").innerHTML = `<div class="empty err">Could not load resolved claims: ${esc(e.message)}</div>`;
  }
}
async function resolvedRow(a) {
  let rep = null;
  try { rep = await readJSON("get_reputation", [a.attester]); } catch {}
  const repTxt = rep ? (rep.rated ? `${rep.score}/100` : `${rep.score}/100 (unrated)`) : "—";
  return `<div class="order" style="cursor:default">
    <div class="hd"><a class="title" href="/claim?id=${a.id}">#${a.id} · ${esc(a.claim.slice(0, 70))}${a.claim.length > 70 ? "…" : ""}</a>
      <span>${badge(a.status)} ${a.verdict !== "NONE" ? `<span class="pill">${a.confidence}%</span>` : ""}</span></div>
    ${a.reason ? `<div class="reason" style="margin:10px 0">${esc(a.reason)}</div>` : ""}
    <div class="meta">payout ${genFmt(isSink(a.recipient) ? a.slashed : (a.payout || a.stake))} → ${payoutWho(a)}${isSink(a.recipient) ? "" : " " + short(a.recipient)}${!isSink(a.recipient) && BigInt(a.slashed || 0) > 0n ? ` · burned ${genFmt(a.slashed)}` : ""} · attester reputation ${repTxt} · resolved ${whenTs(a.resolved_at)} · <a href="/claim?id=${a.id}">details →</a></div>
  </div>`;
}

function pageFile() {
  const v = $("#view");
  const d = new Date(Date.now() + 20 * 60 * 1000);
  const loc = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  v.innerHTML = `<div class="card">
    <h2>File a staked attestation</h2>
    <div class="sub">Stake GEN behind a public claim about yourself or your project. Validators read the live sources and rule SUPPORTED (stake returns, reputation rises) or REFUTED. You do <strong>not</strong> pick a challenger: any independent party may post a matching bond to challenge your claim, and a refuted claim pays that challenger — or is burned if no one challenged. That is the economic cost of a false claim.</div>
    <label>Claim — the public statement you stand behind</label>
    <textarea id="claim" rows="2" placeholder="e.g. Our smart-contract audit by Acme Security is published at the link below."></textarea>
    <label>Check rule — how a validator should verify it from the sources</label>
    <textarea id="rule" rows="2" placeholder="e.g. A source must show a published audit report naming our project and Acme Security."></textarea>
    <label>Source URL(s) — 1 to 3 public https links, one per line</label>
    <textarea id="urls" rows="3" placeholder="https://acme-security.example/reports/ourproject.pdf"></textarea>
    <label>Settle-by (local time)</label>
    <input id="settleby" type="datetime-local" value="${loc}" />
    <div class="hint">Settle-by must be 5 minutes to 90 days from now. Anyone can request a review before it — no maturity wait.</div>
    <label>Stake (GEN) — minimum 0.0005</label>
    <input id="stake" type="number" step="0.0001" min="0.0005" value="0.001" />
    <div class="inline-actions"><button class="primary" id="submit">Stake &amp; file attestation</button></div>
    <div class="status-line" id="st"></div>
  </div>`;
  $("#submit").onclick = submitAttestation;
}
async function submitAttestation() {
  const st = $("#st");
  try {
    await ensureReady();
    const claim = $("#claim").value.trim();
    const rule = $("#rule").value.trim();
    const urls = $("#urls").value.split("\n").map((s) => s.trim()).filter(Boolean);
    const settleby = Math.floor(new Date($("#settleby").value).getTime() / 1000);
    if (!claim || !rule || !urls.length) throw new Error("Fill in the claim, rule and at least one source URL.");
    if (!Number.isFinite(settleby)) throw new Error("Pick a settle-by time.");
    const stake = BigInt(Math.round(parseFloat($("#stake").value) * 1e18));
    if (stake < 5n * 10n ** 14n) throw new Error("Stake must be at least 0.0005 GEN.");
    const { hash, finalized } = await send(st, "Submitted. Waiting for the network to accept it…",
      "file_attestation", [claim, rule, urls, settleby], stake);
    const count = Number(await read("get_attestation_count", []));
    const id = String(count - 1);
    const a = await readJSON("get_attestation", [id]);
    if (a.status === "OPEN" && a.claim === claim) {
      if (finalized) setStatus(st, "ok", `Attestation #${id} filed and staked. Redirecting…`, hash);
      else setStatus(st, "warn", `Attestation #${id} filed — finalization still pending on GenLayer. Redirecting…`, hash);
      setTimeout(() => (location.href = `/claim?id=${id}`), 1000);
    } else {
      const reason = await read("get_last_reject", [wallet.address]);
      setStatus(st, "err", `Rejected: ${reason || "invalid or duplicate terms"}. Your stake is held as withdrawable credit (see My account).`);
    }
  } catch (e) {
    setStatus(st, "err", e.message || String(e));
  }
}

async function pageClaim() {
  const id = qid();
  const v = $("#view");
  if (!id || !/^\d+$/.test(id)) { v.innerHTML = `<div class="card"><div class="empty">No attestation id. <a href="/">← attestations</a></div></div>`; return; }
  v.innerHTML = `<div class="card"><div class="empty"><span class="spinner"></span> loading attestation #${esc(id)}…</div></div>`;
  const notFound = () => { v.innerHTML = `<div class="card"><div class="empty err">Attestation #${esc(id)} not found.</div><div class="inline-actions"><a class="tab" href="/">← attestations</a></div></div>`; };
  let a;
  try {
    const count = Number(await read("get_attestation_count", []));
    if (!Number.isFinite(count) || Number(id) >= count) { notFound(); return; }
    a = await readJSON("get_attestation", [id]);
  } catch { notFound(); return; }
  const now = Math.floor(Date.now() / 1000);
  const over = now >= a.settle_by;
  const canReview = a.status === "OPEN" && !over;
  const canLapse = a.status === "OPEN" && over;
  const mine = same(wallet.address, a.attester);
  const canChallenge = a.status === "OPEN" && !over && !a.challenged && wallet.address && !mine;
  let rep = null;
  try { rep = await readJSON("get_reputation", [a.attester]); } catch {}
  const repTxt = rep ? (rep.rated ? `${rep.score}/100 (${rep.supported}✓ / ${rep.refuted}✗)` : `${rep.score}/100 (unrated)`) : "";
  v.innerHTML = `<div class="card">
    <div class="hd" style="display:flex;justify-content:space-between;align-items:center;gap:12px">
      <h2 style="margin:0">Attestation #${esc(a.id)}</h2>${badge(a.status)}</div>
    <div class="reason" style="border-left-color:var(--accent-2)"><strong>Claim.</strong> ${esc(a.claim)}</div>
    <div class="kv">
      <div class="k">Check rule</div><div class="v">${esc(a.check_rule)}</div>
      <div class="k">Stake</div><div class="v">${genFmt(a.stake)}</div>
      <div class="k">Attester</div><div class="v mono"><a href="${addrUrl(a.attester)}" target="_blank" rel="noopener">${esc(a.attester)}</a>${rep ? ` · reputation <a href="/reputation?id=${a.attester}">${repTxt}</a>` : ""}</div>
      <div class="k">Challenger</div><div class="v mono">${a.challenged ? `<a href="${addrUrl(a.challenger)}" target="_blank" rel="noopener">${esc(a.challenger)}</a> · bond ${genFmt(a.challenge_bond)}` : "none yet — open to an independent challenge"}</div>
      <div class="k">Settle by</div><div class="v">${whenTs(a.settle_by)}</div>
      <div class="k">Reviews run</div><div class="v">${a.review_count}</div>
      ${a.settlement === "CREDITED" ? `<div class="k">Settled payout</div><div class="v">${genFmt(a.payout || a.stake)} → ${payoutWho(a)}${isSink(a.recipient) ? "" : " " + short(a.recipient)} <span class="pill">credited, pull via withdraw</span>${BigInt(a.slashed || 0) > 0n ? ` · <span class="pill bad">burned ${genFmt(a.slashed)}</span>` : ""}</div>` : ""}
    </div>
    <details class="ev"><summary>Source evidence (${a.source_urls.length} URL${a.source_urls.length > 1 ? "s" : ""})</summary>
      ${a.source_urls.map((u) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(u)} ↗</a>`).join("")}</details>
    ${a.verdict !== "NONE" ? `<div class="reason"><strong>Validator verdict: ${badge(a.verdict)} · confidence ${a.confidence}%</strong><br/>${esc(a.reason)}<div class="hint" style="margin-top:6px">${a.sources_ok} of ${a.source_urls.length} sources fully read · evidence ${a.evidence_complete ? "complete" : "incomplete (conclusive verdicts blocked)"}</div></div>` : `<div class="hint" style="margin-top:14px">No ruling yet.</div>`}
    <div class="inline-actions">
      ${canReview ? `<button class="primary" id="review">Run validator review</button>` : ""}
      ${canChallenge ? `<button id="challenge">Challenge — stake ${genFmt(a.stake)} against this claim</button>` : ""}
      ${canLapse ? `<button id="lapse">Lapse (return stake &amp; bond)</button>` : ""}
      <a class="tab" href="/">← attestations</a><a class="tab" href="/explorer">Explorer</a>
    </div>
    ${canChallenge ? "" : (a.status === "OPEN" && mine ? `<div class="hint">You filed this claim, so you cannot challenge it — challenges must come from an independent party.</div>` : "")}
    <div class="status-line" id="st"></div>
  </div>`;
  if ($("#review")) $("#review").onclick = () => runWrite($("#st"), "review_attestation", [id], "Validators are rendering the sources and judging the claim… (~15–40s)", pageClaim);
  if ($("#lapse")) $("#lapse").onclick = () => runWrite($("#st"), "lapse_attestation", [id], "Lapsing the attestation…", pageClaim);
  if ($("#challenge")) $("#challenge").onclick = async () => {
    const st = $("#st");
    try {
      await ensureReady();
      if (same(wallet.address, a.attester)) throw new Error("The attester cannot challenge their own claim.");
      const { hash, finalized } = await send(st, "Posting your challenge bond…", "challenge_attestation", [id], BigInt(a.stake));
      if (finalized) setStatus(st, "ok", "Challenge posted. Refreshing…", hash);
      else setStatus(st, "warn", "Challenge executed — finalization still pending. Refreshing…", hash);
      setTimeout(pageClaim, 1200);
    } catch (e) { setStatus(st, "err", e.message || String(e)); }
  };
}
async function runWrite(st, fn, args, busyMsg, refresh, value = 0n) {
  try {
    await ensureReady();
    const { hash, finalized } = await send(st, busyMsg, fn, args, value);
    if (finalized) setStatus(st, "ok", "Done and finalized. Refreshing…", hash);
    else setStatus(st, "warn", "Executed — finalization still pending on GenLayer. Refreshing…", hash);
    setTimeout(refresh, 1000);
  } catch (e) { setStatus(st, "err", e.message || String(e)); }
}

function pageReputation() {
  const v = $("#view");
  const pre = qid() || wallet.address || "";
  v.innerHTML = `<div class="card">
    <h2>Reputation lookup</h2>
    <div class="sub">Every resolved attestation folds into a rolling, money-backed reputation for the attester address — a neutral start of <strong>50</strong>, an EMA toward SUPPORTED (100) / REFUTED (0). Unchallenged supported claims only lift the score toward 70; reaching the top requires surviving funded challenges, which resists reputation farming.</div>
    <label>Address</label>
    <input id="addr" placeholder="0x…" value="${esc(pre)}" />
    <div class="inline-actions"><button class="primary" id="look">Look up</button></div>
    <div id="out" style="margin-top:16px"></div>
  </div>`;
  $("#look").onclick = doLookup;
  if (/^0x[0-9a-fA-F]{40}$/.test(pre)) doLookup();
}
async function doLookup() {
  const addr = $("#addr").value.trim();
  const out = $("#out");
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) { out.innerHTML = `<span class="err">Enter a valid address.</span>`; return; }
  out.innerHTML = `<span class="spinner"></span>`;
  try {
    const r = await readJSON("get_reputation", [addr]);
    out.innerHTML = `<div class="kv">
      <div class="k">Reputation score</div><div class="v"><strong>${r.score} / 100</strong>${r.rated ? "" : " <span class=\"pill\">unrated</span>"}</div>
      <div class="k">Supported</div><div class="v good">${r.supported}</div>
      <div class="k">Refuted</div><div class="v err">${r.refuted}</div>
      <div class="k">Challenges survived</div><div class="v">${r.challenged_wins}</div>
      <div class="k">Resolved total</div><div class="v">${r.resolved}</div>
    </div>${r.rated ? "" : `<div class="hint">This address has no resolved attestations yet (neutral score 50).</div>`}`;
  } catch (e) { out.innerHTML = `<span class="err">${esc(e.message)}</span>`; }
}

async function pageAccount() {
  const v = $("#view");
  if (!window.ethereum) { v.innerHTML = `<div class="card"><div class="empty">No wallet found. Install MetaMask to see credits and withdraw.</div></div>`; return; }
  if (!wallet.address) {
    v.innerHTML = `<div class="card"><div class="empty">Connect your wallet to see credits and withdraw.</div><div class="inline-actions"><button class="primary" id="c">Connect wallet</button></div></div>`;
    $("#c").onclick = () => connect().then(pageAccount).catch((e) => alert(e.message)); return;
  }
  v.innerHTML = `<div class="card"><div class="empty"><span class="spinner"></span> loading your account…</div></div>`;
  const acct = await readJSON("get_account", [wallet.address]);
  const credit = acct.available;
  const reject = await read("get_last_reject", [wallet.address]);
  const rep = await readJSON("get_reputation", [wallet.address]);
  v.innerHTML = `<div class="card">
    <h2>My account</h2>
    <div class="sub">${esc(short(wallet.address))}</div>
    <div class="kv">
      <div class="k">Reputation</div><div class="v">${rep.score}/100 ${rep.rated ? `(${rep.supported}✓ / ${rep.refuted}✗)` : "(unrated)"}</div>
      <div class="k">Withdrawable credit</div><div class="v">${genFmt(credit)}</div>
      <div class="k">Delivered to date</div><div class="v">${genFmt(acct.delivered)}</div>
      ${reject ? `<div class="k">Last rejected claim</div><div class="v err">${esc(reject)}</div>` : ""}
    </div>
    <div class="hint">Credit is an internal allocation (returned stakes on SUPPORTED/LAPSED, a won stake+bond as a challenger, a defended bond, or a rejected claim's held stake). It is marked CREDITED on the attestation; <strong>withdraw</strong> delivers it to your wallet and records it under “delivered”.</div>
    <div class="inline-actions">${BigInt(credit) > 0n ? `<button class="primary" id="wd">Withdraw ${genFmt(credit)}</button>` : `<button disabled>Nothing to withdraw</button>`}</div>
    <div class="status-line" id="st"></div>
  </div>`;
  if ($("#wd")) $("#wd").onclick = () => runWrite($("#st"), "withdraw", [credit.toString()], "Withdrawing — delivery settles on finalization…", pageAccount);
}

// --------------------------------------------------------------------- boot
const PAGES = { board: pageBoard, file: pageFile, explorer: pageExplorer, reputation: pageReputation, account: pageAccount, claim: pageClaim };
const page = document.body.dataset.page || "board";
renderNav(["claim"].includes(page) ? "" : page);
footContract();
if (window.ethereum) {
  window.ethereum.on && window.ethereum.on("accountsChanged", () => refreshWallet().then(() => { renderWallet(); if (page === "account") pageAccount(); }));
  window.ethereum.on && window.ethereum.on("chainChanged", () => refreshWallet().then(renderWallet));
}
await refreshWallet();
renderWallet();
(PAGES[page] || pageBoard)();
