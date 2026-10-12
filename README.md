# AttestBond

**Stake-backed public claims with consensus-graded reputation, judged by GenLayer validators.**

- **Live app:** https://attestbond.vercel.app _(updated after deploy)_
- **Network:** GenLayer **Studionet** (chain `61999`, RPC `https://studio.genlayer.com/api`) — Explorer status is **Preview**
- **Contract:** [`0x1854EE843C07552F640DdBae0e427ced3dA6D978`](https://explorer-studio.genlayer.com/address/0x1854EE843C07552F640DdBae0e427ced3dA6D978)

## The problem

Projects make public claims about themselves all the time — "our audit is
published", "we shipped release vN", "the grant deliverable is live" — and ask to
be trusted on them. A claim with **nothing staked** is cheap, and whether the
public evidence actually backs it is a *reading-and-judgment* task that a
centralized checker could fake and that Solidity cannot perform.

## How AttestBond works

An attester files an **attestation** and stakes native **GEN** behind it:

- a public **claim**,
- a **check rule** (how to verify it from the sources),
- 1–3 public **source URLs**,
- a **settle-by** deadline,
- an immutable **challenger** address that collects the stake if the claim is refuted.

Anyone calls `review_attestation`. GenLayer validators **render the live sources
on-chain** (`gl.nondet.web.render`) and an **LLM jury** (`gl.nondet.exec_prompt`)
rules — strictly under the check rule — one of:

| Verdict | Consequence |
|---|---|
| `SUPPORTED` | stake returns to the **attester**; reputation **rises** |
| `REFUTED` | stake credited to the **challenger**; reputation **falls** |
| `INCONCLUSIVE` | attestation stays open, reviewable again |
| `LAPSED` (after settle-by, unresolved) | stake returns to the attester, reputation unchanged |

Every resolved attestation folds into a rolling on-chain **reputation** for the
attester address — an exponential moving average over `SUPPORTED=100 / REFUTED=0`,
starting at 100 — plus supported/refuted tallies. Other contracts can read it.
Funds are pulled with `withdraw`.

## Why it dies without GenLayer

The decision is **whether public evidence supports a claim under a stated rule** —
on-chain web retrieval **plus** language judgment, neither of which Solidity can
do — and the money-backed reputation it produces is only meaningful if no single
party controls the verdict. GenLayer supplies validator web rendering, model
judgment and consensus; the contract supplies staking, settlement and the
reputation ledger. Remove the AI/web layer and reputation becomes a number
somebody types in.

## Contract quality

- The nondet block returns `{verdict, confidence, reason}`; consensus uses
  `gl.vm.run_nondet_unsafe(leader_fn, validator_fn)` — the validator agrees only
  on the **same verdict** and a **comparable confidence band**, never on JSON
  shape.
- Explicit handling + `UserError` for: unreadable/empty sources (→ `INCONCLUSIVE`),
  non-https/duplicate URLs, zero stake, out-of-range settle-by, challenger ==
  attester, double-settlement, acting on a terminal attestation, over-withdrawal.
- Reputation is a real cross-call-readable primitive, not a cosmetic counter.
- **Payable-custody safety**: invalid terms return a `REJECTED` sentinel and hold
  the stake as withdrawable credit, because Studionet credits value to a payable
  contract even on a later execution error.

## Repository layout

```
contracts/attestbond.py    # the Intelligent Contract
scripts/deploy.py          # studionet deploy (genlayer_py) + --check-only schema check
scripts/seed.py            # seed 1 SUPPORTED + 1 REFUTED, fold reputation, withdraw
scripts/build.mjs          # inject CONTRACT_ADDRESS into the frontend at build
frontend/                  # single-page app (genlayer-js + MetaMask), no backend
```

## Deploy to Studionet

```bash
source ~/.genlayer/env.sh                 # exports GENLAYER_PRIVATE_KEY
python3 scripts/deploy.py --check-only     # validate the schema, no spend
python3 scripts/deploy.py                  # deploy to chain 61999
```

Put the printed address in `.env` as `CONTRACT_ADDRESS=0x…`.

## Run the frontend

```bash
node scripts/build.mjs                      # injects the address from .env
npx serve frontend                          # or any static server
```

MetaMask signs (no key in the bundle), the wallet auto-switches to Studionet, a
loading state covers consensus, and the validator's verdict **and rationale** are
shown with an Explorer transaction link.

## Seed demo data

```bash
source ~/.genlayer/env.sh
python3 scripts/seed.py 0x<contract>        # SUPPORTED, REFUTED, reputation, withdrawal
```
