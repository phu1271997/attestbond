# AttestBond

**Stake-backed public claims with consensus-graded reputation, judged by GenLayer validators.**

- **Live app:** https://attestbond.vercel.app
- **Network:** GenLayer **Studionet** (chain `61999`, RPC `https://studio.genlayer.com/api`) — Explorer status is **Preview**
- **Contract:** [`0xB06EE241f27A47B0700c3c6A1a8bf69463aFb6F5`](https://explorer-studio.genlayer.com/address/0xB06EE241f27A47B0700c3c6A1a8bf69463aFb6F5)

## The problem

Projects make public claims about themselves all the time — "our audit is
published", "we shipped release vN", "the grant deliverable is live" — and ask to
be trusted on them. A claim with **nothing staked** is cheap, and whether the
public evidence actually backs it is a *reading-and-judgment* task that a
centralized checker could fake and that Solidity cannot perform.

## How AttestBond works

An attester files an **attestation** and stakes native **GEN** behind it: a public
**claim**, a **check rule** (how to verify it from the sources), 1–3 public
**source URLs** and a **settle-by** deadline.

Anyone calls `review_attestation`. GenLayer validators **render the live sources
on-chain** (`gl.nondet.web.render`) and an **LLM jury** (`gl.nondet.exec_prompt`)
rules — strictly under the check rule — one of:

| Verdict | Consequence |
|---|---|
| `SUPPORTED` | stake returns to the **attester**; reputation **rises** (and a losing challenger's bond is awarded to the attester) |
| `REFUTED` | if **challenged**, the stake + bond go to the independent **challenger**; if **unchallenged**, the stake is **burned** to an unspendable sink; reputation **falls** |
| `INCONCLUSIVE` | attestation stays open, reviewable again |
| `LAPSED` (after settle-by, unresolved) | stake returns to the attester and any challenger's bond returns to the challenger; reputation unchanged |

### Economic accountability — the challenge is independent, not self-chosen

The attester **does not name the challenger**. Instead, any *independent* party
posts a **matching counter-bond** with `challenge_attestation` to bet against the
claim. This closes the self-dealing loophole: one person can no longer sit on
both sides and recover a forfeited stake through a second wallet.

- **Refuted while challenged** → the whole stake (plus the bond back) goes to the
  independent challenger: a real transfer of value to an adversary.
- **Refuted while unchallenged** → the stake is **slashed to a burn sink**
  (`0x…dead`) and can never be recovered by any wallet the attester controls.

So a false claim is always costly, regardless of who triggers the review.

### Reputation — anti-farming

Unrated wallets start at a **neutral 50** (not a perfect 100). Each resolved
claim folds into a rolling EMA. A SUPPORTED-but-**never-challenged** claim can
only lift the score toward **70**; reaching the top requires **surviving a funded
challenge**. Duplicate / trivial claims (same attester, same claim + sources) are
rejected, and every claim must meet a **minimum stake**. The score is a portable
primitive other contracts can read via `get_reputation`.

### Settlement vs delivery

Resolving a claim **credits** the winner's internal balance
(`settlement = CREDITED`); it is never marked *delivered* there. Native GEN only
leaves the contract when the recipient pulls it with `withdraw`, which moves the
credit into a `delivered` ledger atomically with `emit_transfer(on="finalized")`
— there is no window where credit is cleared without a matching delivery, and a
failed/over-sized withdrawal reverts leaving credit intact.

## Why it dies without GenLayer

The decision is **whether public evidence supports a claim under a stated rule** —
on-chain web retrieval **plus** language judgment, neither of which Solidity can
do — and the money-backed reputation it produces is only meaningful if no single
party controls the verdict. GenLayer supplies validator web rendering, model
judgment and consensus; the contract supplies staking, settlement and the
reputation ledger. Remove the AI/web layer and reputation becomes a number
somebody types in.

## Consensus on meaning, not shape

The nondet block runs under `gl.vm.run_nondet_unsafe(leader_fn, validator_fn)`
and the validator agrees on the **meaning** of the ruling, never on JSON shape:

- **Strict verdict validation** — the verdict must be exactly `SUPPORTED`,
  `REFUTED` or `INCONCLUSIVE`; anything else is malformed and is treated as
  INCONCLUSIVE, never substring-matched into a conclusion.
- **Confidence-band agreement** — validators must land in the same low/medium/high band.
- **Decision-critical evidence fingerprint** — for the conclusive verdicts, both
  sides must agree on a fingerprint of the exact evidence the decision rested on,
  so modified or contradictory sources cannot ratify a SUPPORTED/REFUTED ruling.
- **Complete-evidence gate** — a conclusive verdict requires that *every* source
  was fully read. Empty, unreachable or **truncated** sources (content beyond the
  on-chain evidence budget) can only produce INCONCLUSIVE, so silently dropped
  content can never drive a conclusion.

Explicit handling + `UserError` for: unreadable/empty/truncated sources, non-https
or duplicate URLs, below-minimum stake, out-of-range settle-by, self-challenge,
under-funded challenge bond, double-settlement, acting on a terminal attestation,
and over-withdrawal. Invalid or duplicate terms return a `REJECTED` sentinel and
hold the stake as withdrawable credit (Studionet credits value to a payable
contract even on a later execution error).

## Repository layout

```
contracts/attestbond.py    # the Intelligent Contract
tests/                     # gltest suite (20 deterministic end-to-end tests)
scripts/deploy.py          # studionet deploy (genlayer_py) + --check-only schema check
scripts/seed.py            # SUPPORTED + independent-challenger REFUTED + withdrawals
scripts/build.mjs          # inject CONTRACT_ADDRESS into the frontend at build
frontend/                  # genlayer-js + MetaMask, dedicated routes, no backend
gltest.config.yaml         # studionet test network config
```

## Deploy to Studionet

```bash
source ~/.genlayer/env.sh                  # exports GENLAYER_PRIVATE_KEY
python3 scripts/deploy.py --check-only      # validate the schema, no spend
python3 scripts/deploy.py                   # deploy to chain 61999
```

Put the printed address in `.env` as `CONTRACT_ADDRESS=0x…`.

## Test

The suite runs the real contract bytecode in gltest's in-process VM with
Foundry-style cheatcodes, pinning deterministic web/LLM responses so every path
— including the non-deterministic judgment — is exercised reproducibly. It covers
independent-challenger participation, supported/refuted/inconclusive verdicts,
expired (lapsed) attestations, reputation-farming attempts, malformed model
responses, adversarial/incomplete/truncated evidence, evidence-fingerprint
consensus, challenger withdrawals, credited recipient balances, and failed /
over-sized payment recovery.

```bash
source ~/.genlayer/env.sh
gltest tests/ -v                            # 20 tests
```

## Run the frontend

```bash
node scripts/build.mjs                       # injects the address from .env
npx serve frontend                           # or any static server
```

MetaMask signs (no key in the bundle), the wallet auto-switches to Studionet, a
loading state covers consensus, writes are confirmed by **checking GenVM
`execution_result: SUCCESS` and waiting for finalization** (not merely ACCEPTED),
and the validator's verdict **and rationale** are shown with an Explorer link.

## Seed demo data

```bash
source ~/.genlayer/env.sh                     # needs GENLAYER_PRIVATE_KEY + _2
python3 scripts/seed.py 0x<contract>          # SUPPORTED, challenged REFUTED, withdrawals
```
