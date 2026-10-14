# AttestBond

**Stake-backed public claims with consensus-graded reputation, judged by GenLayer validators.**

- **Live app:** https://attestbond.vercel.app
- **Network:** GenLayer **Studionet** (chain `61999`, RPC `https://studio.genlayer.com/api`) — Explorer status is **Preview**
- **Contract:** [`0x03e2BA90D866eB8d0f3720C8698fFb160ea6908e`](https://explorer-studio.genlayer.com/address/0x03e2BA90D866eB8d0f3720C8698fFb160ea6908e)

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
| `REFUTED` | the attester's **entire stake is forfeited**. If **challenged**, a majority (`SLASH_BURN_BPS` = 60%) is **burned** and the independent challenger gets their bond back plus the 40% bounty; if **unchallenged**, the whole stake is burned. Reputation **falls** |
| `INCONCLUSIVE` | attestation stays open, reviewable again |
| `LAPSED` (after settle-by, unresolved) | stake returns to the attester and any challenger's bond returns to the challenger; reputation unchanged |

### Economic accountability — the challenge is independent, not self-chosen

The attester **does not name the challenger**. Instead, any *independent* party
posts a **matching counter-bond** with `challenge_attestation` to bet against the
claim. This closes the self-dealing loophole: one person can no longer sit on
both sides and recover a forfeited stake through a second wallet.

A refuted claim must cost the attester real value that **no wallet they control
can recover — including the challenger wallet**. So on *every* refuted path the
attester's entire stake is forfeited and a majority is burned:

- **Refuted while challenged** → `SLASH_BURN_BPS` (60%) of the stake is burned to
  the sink (`0x…dead`); the independent challenger gets their bond back plus the
  remaining 40% bounty. The attester recovers **none** of the stake.
- **Refuted while unchallenged** → the whole stake is burned.

This closes the resubmission loophole: if the attester secretly owns the
challenger wallet and posts the bond themselves, they still lose the burned
majority. Worked example (stake `S`, bond `B = S`): the self-dealer commits `2S`
and the challenger wallet receives only `B + 0.4·S = 1.4·S` — a guaranteed net
loss of `0.6·S`. A false claim is always costly, regardless of who triggers the
review.

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
contracts/attestbond.py          # the Intelligent Contract
tests/test_attestbond.py         # direct-VM suite: content-controlled invariants
tests/test_studionet_e2e.py      # StudioNet live e2e suite (real deploys + consensus)
tests/e2e_studionet.py           # live-network helpers (deploy, transact, mocks-free)
scripts/deploy.py                # studionet deploy (genlayer_py) + --check-only schema check
scripts/seed.py                  # SUPPORTED + independent-challenger REFUTED + withdrawals
scripts/build.mjs                # inject CONTRACT_ADDRESS into the frontend at build
frontend/                        # genlayer-js + MetaMask, dedicated routes, no backend
gltest.config.yaml               # studionet test network config
```

## Deploy to Studionet

```bash
source ~/.genlayer/env.sh                  # exports GENLAYER_PRIVATE_KEY
python3 scripts/deploy.py --check-only      # validate the schema, no spend
python3 scripts/deploy.py                   # deploy to chain 61999
```

Put the printed address in `.env` as `CONTRACT_ADDRESS=0x…`.

## Test

Two suites. **(1) Direct-VM suite** (`tests/test_attestbond.py`) runs the real
contract bytecode in gltest's in-process VM with Foundry-style cheatcodes,
pinning deterministic web/LLM responses so the content-controlled invariants are
exercised reproducibly: strict-verdict parsing, malformed-model handling,
truncated/empty/adversarial evidence gates, evidence-fingerprint consensus, and
the self-dealing economics.

```bash
source ~/.genlayer/env.sh
gltest tests/test_attestbond.py -v          # 21 deterministic tests, offline
```

**(2) StudioNet end-to-end suite** (`tests/test_studionet_e2e.py`) deploys the
real contract to the live Studio network and drives it over JSON-RPC through
validator consensus. Every write is asserted to reach **FINALIZED with a GenVM
`execution_result` of SUCCESS** — never merely ACCEPTED. The hosted RPC does not
expose `sim_installMocks`, so verdicts are produced by the **live LLM jury
reading real public sources** (a true python.org fact → SUPPORTED, a false one →
REFUTED, a dead link → INCONCLUSIVE); no-LLM paths use a REJECTED filing's
withdrawable credit. It covers independent-challenger participation,
supported/refuted/inconclusive judgments, the self-dealing challenge, expired
(lapsed) attestations, reputation farming, challenger withdrawals, credited
recipient-wallet delivery, and failed/ambiguous payment recovery.

```bash
source ~/.genlayer/env.sh                   # needs 3+ funded studionet keys
RUN_STUDIONET_E2E=1 gltest --network studionet tests/test_studionet_e2e.py -v
```

It is opt-in (`RUN_STUDIONET_E2E=1`) because it spends real test GEN and takes
several minutes of live consensus.

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
