# GENLAYER PROJECT EXPLORER — SUBMISSION DRAFT
**Project:** AttestBond · **Prepared:** 2026-10-12 · **Status: READY**

No blockers. Contract is live on Studionet, every write method has a UI caller,
and the board already shows one SUPPORTED + one REFUTED attestation with a folded
reputation score and completed withdrawals, visible without a wallet.

---

## Project name
AttestBond

## Primary category
**Identity/Reputation** — the contract's durable output is a money-backed, on-chain
reputation score per address, built from independently judged public claims. Not
`Dispute Resolution`: there is no appeal of a prior verdict, it is a first-pass
attestation check. Not `AI & Agents`: the AI is the judge, not the product.

## Category tags
- **Category tag 1 — Claim Attestation** — `file_attestation` records a signed,
  staked public claim and `review_attestation` rules whether the live sources
  support it. This is the core user action.
- **Category tag 2 — Reputation Scoring** — every resolved claim folds into a
  rolling score (EMA over SUPPORTED=100 / REFUTED=0) with supported/refuted
  tallies, readable via `get_reputation` and the Reputation tab.

Rejected: *Credential Validation* (claims are general, not KYC/credential
specific), *Sybil Detection* (no graph/identity-clustering logic).

## Logo
`frontend` favicon (inline SVG shield-with-check in indigo/green).
Exportable to PNG 1024/512 on request. Concept: a shield (trust) clipping a check
mark (verified), one mark.

## One-liner (172 / 180)
Stake GEN behind a public claim about your project; GenLayer validators read the live sources and rule it supported or refuted, building a money-backed on-chain reputation.

## Description (989 / 1000)
AttestBond turns public claims into money-backed, independently judged statements. An attester files a claim about itself or its project (an audit is published, a release shipped, a grant deliverable is live), stakes GEN, and sets a check rule, up to three public source URLs, a settle-by deadline and a challenger address.

Anyone triggers a review. GenLayer validators render the live sources on-chain and an LLM jury rules, strictly under the rule: SUPPORTED returns the stake and raises the attester's reputation, REFUTED sends the stake to the challenger and lowers it, INCONCLUSIVE keeps it open. Unresolved by the deadline, it LAPSES and the stake returns. Each resolved claim folds into a rolling reputation score (0-100) other contracts can read.

It is for teams that want to put money behind what they assert, and for anyone verifying those assertions. No operator sets the verdict or the score; both come from validator consensus reading the real web, which Solidity cannot do.

## How to try it
Prerequisites: a browser wallet (MetaMask). Reading the board and reputation needs
no wallet. To file or review a claim you need a little GEN on Studionet (chain
61999) — fund the wallet from the Studio **Accounts** panel; ~0.002 GEN covers the
stake plus gas for one full round.

Step 1 — Browse the board. Open the app; the board shows two seeded attestations
(one SUPPORTED, one REFUTED). Click one to read its claim, check rule, sources,
the verdict + confidence + rationale, the settled recipient, and the attester's
reputation.

Step 2 — Check reputation. Open the **Reputation lookup** tab and paste the
attester address shown on a card to see its score (0-100) and supported/refuted
tallies.

Step 3 — Connect and switch network. Click **Connect wallet**; the app switches
you to Studionet automatically.

Step 4 — File a claim. Go to **File an attestation**. Enter a challenger address
(any address other than yours), a claim, a check rule, and a public https source
URL that actually backs the claim. Keep the settle-by default. Enter a stake
(e.g. 0.001) and sign.

Step 5 — Review it. Open your attestation and click **Run validator review**. A
loading state shows while validators render the sources and reach consensus
(~15–40s). The verdict, confidence, rationale and your updated reputation appear.

Step 6 — Settle. On SUPPORTED the stake is credited back to you; open **My
account** and withdraw it.

Expected end state: your attestation shows SUPPORTED or REFUTED with an AI
rationale, your reputation score has moved, and the stake reached the correct
party.

If something goes wrong:
- Wrong network — use the **Switch to Studionet** button in the header.
- Review returned INCONCLUSIVE — the sources were unreadable or did not clearly
  back the claim; it stays open, run the review again with a clearer source.
- "settle window has closed" — the settle-by passed; click **Lapse** to return
  the stake.

## Expected verification outcome (422 / 500)
Open the board without a wallet: attestation #0 reads SUPPORTED (confidence 99) and #1 reads REFUTED (confidence 95), each with a rationale and a settled recipient. The Reputation tab shows the attester at score 75 with 1 supported and 1 refuted. Each attestation links to its GenLayer transaction. Verdicts, confidence and the reputation score are produced by validator consensus reading live sources, not by the website.

## Contract link
https://explorer-studio.genlayer.com/address/0x1854EE843C07552F640DdBae0e427ced3dA6D978

Address: `0x1854EE843C07552F640DdBae0e427ced3dA6D978`
Network: GenLayer Studionet (chain 61999)
Status: **Preview** (Studio-hosted)
Verified: deployed and seeded by the project wallet; SUPPORTED, REFUTED and
withdrawal transactions are on-chain, the reputation score folded to 75, and the
board renders to an anonymous visitor (confirmed in a browser with no wallet).

## Website
https://attestbond.vercel.app

## GitHub
https://github.com/phu1271997/attestbond

## Community links (optional)
—
