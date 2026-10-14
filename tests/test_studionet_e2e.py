"""StudioNet END-TO-END suite for AttestBond.

Every test deploys the real contract to the GenLayer Studio network and drives
it over JSON-RPC through validator consensus. Writes are asserted to reach
FINALIZED with a GenVM execution_result of SUCCESS (never merely ACCEPTED).

The hosted Studio RPC does NOT expose sim_installMocks, so verdicts are produced
by the live LLM jury reading REAL public sources: a true claim about python.org
resolves SUPPORTED, a deliberately false one resolves REFUTED, and a dead link
is unreadable so it can only be INCONCLUSIVE. No-LLM paths (input guards,
reputation start, settlement/delivery split, failed-withdrawal recovery) are
driven deterministically — a REJECTED filing credits the stake as withdrawable,
giving real on-chain credit to exercise withdraw() without a review.

This is the suite the reviewer asked for. It is OPT-IN because it spends real
test GEN and takes several minutes:

    source ~/.genlayer/env.sh
    RUN_STUDIONET_E2E=1 gltest --network studionet tests/test_studionet_e2e.py -v

Scenarios covered: independent-challenger participation, supported / refuted /
inconclusive judgments, expired (lapsed) attestations, reputation-farming
attempts, self-dealing challenges, challenger withdrawals, credited
recipient-wallet delivery, and failed / ambiguous payment recovery. Content-gate
invariants that require controlled page content (evidence-fingerprint consensus,
truncation, malformed-parser, prompt-injection) are covered end-to-end against
the real contract bytecode in tests/test_attestbond.py.
"""
import json
import time

import pytest

from e2e_studionet import (
    STAKE, MIN_STAKE, SLASH_BURN_BPS, SINK, requires_studionet,
    accounts, deploy, transact, transact_ok, transact_fail, file_claim,
    att, rep, credit, last_id, call, view_json,
    TRUE_CLAIM, TRUE_RULE, TRUE_URLS, FALSE_CLAIM, FALSE_RULE, FALSE_URLS, DEAD_URLS,
)

pytestmark = requires_studionet

BURN = STAKE * SLASH_BURN_BPS // 10000
BOUNTY = STAKE - BURN


def file_true(c, acct, urls=None):
    return file_claim(c, acct, TRUE_CLAIM, urls or TRUE_URLS, rule=TRUE_RULE)


def file_false(c, acct, urls=None):
    return file_claim(c, acct, FALSE_CLAIM, urls or FALSE_URLS, rule=FALSE_RULE)


# ---------------------------------------------------------- supported (real jury)

def test_supported_unchallenged_credits_stake_and_lifts_reputation():
    attester = accounts()[0]
    c = deploy()
    aid = file_true(c, attester)
    transact_ok(c, "review_attestation", attester, [aid])
    r = att(c, aid)
    assert r["verdict"] == "SUPPORTED" and r["status"] == "SUPPORTED"
    assert r["settlement"] == "CREDITED" and r["recipient"].lower() == attester.address.lower()
    assert int(r["payout"]) == STAKE
    assert credit(c, attester.address) == STAKE
    rp = rep(c, attester.address)
    assert rp["rated"] and rp["supported"] == 1 and 50 < rp["score"] <= 70


def test_supported_over_a_challenge_pays_defender_and_scores_higher():
    attester, challenger = accounts()[0], accounts()[1]
    c = deploy()
    aid = file_true(c, attester)
    transact_ok(c, "challenge_attestation", challenger, [aid], value=STAKE)
    transact_ok(c, "review_attestation", attester, [aid])
    r = att(c, aid)
    assert r["verdict"] == "SUPPORTED"
    assert r["recipient"].lower() == attester.address.lower()
    assert int(r["payout"]) == STAKE * 2            # own stake back + loser's bond
    assert credit(c, attester.address) == STAKE * 2
    rp = rep(c, attester.address)
    assert rp["challenged_wins"] == 1 and rp["score"] > 60


# ------------------------------------------------------------ refuted (real jury)

def test_refuted_with_challenger_burns_majority_and_delivers_bounty():
    # CORE: the attester's entire stake is forfeited; the majority is burned and
    # the independent challenger receives their bond back plus the minority
    # bounty, then withdraws it to their own wallet (recipient-wallet delivery).
    attester, challenger = accounts()[0], accounts()[1]
    c = deploy()
    aid = file_false(c, attester)
    transact_ok(c, "challenge_attestation", challenger, [aid], value=STAKE)
    transact_ok(c, "review_attestation", challenger, [aid])
    r = att(c, aid)
    assert r["verdict"] == "REFUTED"
    assert r["recipient"].lower() == challenger.address.lower()
    assert int(r["payout"]) == STAKE + BOUNTY
    assert int(r["slashed"]) == BURN
    assert credit(c, challenger.address) == STAKE + BOUNTY
    assert credit(c, attester.address) == 0         # attester recovers nothing
    assert rep(c, attester.address)["refuted"] == 1
    # challenger withdraws winnings -> delivery tracked separately from credit
    transact_ok(c, "withdraw", challenger, [STAKE + BOUNTY])
    acct = view_json(c, "get_account", [challenger.address])
    assert acct["available"] == "0" and int(acct["delivered"]) == STAKE + BOUNTY


def test_refuted_unchallenged_burns_the_whole_stake():
    attester, watcher = accounts()[0], accounts()[2]
    c = deploy()
    aid = file_false(c, attester)
    transact_ok(c, "review_attestation", watcher, [aid])
    r = att(c, aid)
    assert r["verdict"] == "REFUTED"
    assert r["recipient"].lower() == SINK and int(r["slashed"]) == STAKE
    assert credit(c, attester.address) == 0


def test_self_dealing_challenge_is_a_guaranteed_net_loss():
    # The reviewer's loophole: the attester posts the challenge bond from a
    # SECOND wallet they control, hoping refutation returns the stake. Model both
    # wallets as one actor: the burned majority can never come back.
    attester, sock = accounts()[0], accounts()[1]
    c = deploy()
    aid = file_false(c, attester)
    transact_ok(c, "challenge_attestation", sock, [aid], value=STAKE)
    transact_ok(c, "review_attestation", sock, [aid])
    assert att(c, aid)["verdict"] == "REFUTED"
    committed = STAKE + STAKE                                  # stake + bond
    recovered = credit(c, attester.address) + credit(c, sock.address)
    assert recovered < committed
    assert committed - recovered == BURN


def test_dead_source_cannot_conclude():
    attester = accounts()[0]
    c = deploy()
    aid = file_claim(c, attester, "A claim whose only source is a dead link.", DEAD_URLS)
    transact_ok(c, "review_attestation", attester, [aid])
    r = att(c, aid)
    assert r["status"] == "OPEN"              # unreadable evidence => INCONCLUSIVE, stays open
    assert r["evidence_complete"] is False


# -------------------------------------------- deterministic guards (no LLM jury)

def test_reputation_starts_neutral_and_unrated():
    fresh = accounts()[2]
    c = deploy()
    r = rep(c, fresh.address)
    assert r["score"] == 50 and r["rated"] is False


def test_duplicate_claim_is_rejected_and_min_stake_enforced():
    attester = accounts()[0]
    c = deploy()
    first = file_claim(c, attester, "An identical claim.", ["https://ex.com/dup"])
    settle_by = int(time.time()) + 3600
    # filing the same claim+sources again returns the REJECTED sentinel (no new id)
    transact_ok(c, "file_attestation", attester,
                ["An identical claim.", "The sources must confirm the claim.", ["https://ex.com/dup"], settle_by],
                value=STAKE)
    assert last_id(c) == first
    assert "duplicate" in call(c, "get_last_reject", [attester.address]).lower()
    # a sub-minimum stake reverts
    transact_fail(c, "file_attestation", attester,
                  ["Too cheap.", "rule", ["https://ex.com/cheap"], settle_by], value=MIN_STAKE - 1)


def test_challenge_guards_reject_self_and_short_bonds():
    attester, challenger = accounts()[0], accounts()[1]
    c = deploy()
    aid = file_claim(c, attester, "A claim under challenge guards.", ["https://ex.com/g"])
    transact_fail(c, "challenge_attestation", attester, [aid], value=STAKE)        # attester cannot self-challenge
    transact_fail(c, "challenge_attestation", challenger, [aid], value=STAKE // 2)  # bond must match the stake
    assert att(c, aid)["challenged"] is False


def test_unchallenged_supported_farming_cannot_reach_high_trust():
    # Real jury, so keep it short: three supported-but-unchallenged claims must
    # still asymptote toward 70 and never approach 100.
    attester = accounts()[0]
    c = deploy()
    for i in range(3):
        aid = file_claim(c, attester, f"{TRUE_CLAIM} (distinct filing {i})", TRUE_URLS, rule=TRUE_RULE)
        transact_ok(c, "review_attestation", attester, [aid])
    r = rep(c, attester.address)
    assert r["supported"] == 3 and r["score"] <= 70 and r["challenged_wins"] == 0


# ------------------------- settlement vs delivery + recovery (REJECTED credit)

def test_rejected_filing_credits_stake_and_withdraw_delivers_it():
    # A REJECTED filing holds the stake as withdrawable credit (no review needed),
    # exercising the settlement(credit) -> delivery split deterministically.
    attester = accounts()[0]
    c = deploy()
    file_claim(c, attester, "A dup-seed claim.", ["https://ex.com/seed"])
    settle_by = int(time.time()) + 3600
    transact_ok(c, "file_attestation", attester,
                ["A dup-seed claim.", "The sources must confirm the claim.", ["https://ex.com/seed"], settle_by],
                value=STAKE)                                  # duplicate -> REJECTED, credits STAKE
    assert credit(c, attester.address) == STAKE
    acct = view_json(c, "get_account", [attester.address])
    assert acct["available"] == str(STAKE) and acct["delivered"] == "0"
    transact_ok(c, "withdraw", attester, [STAKE])
    acct = view_json(c, "get_account", [attester.address])
    assert acct["available"] == "0" and acct["delivered"] == str(STAKE)


def test_failed_or_ambiguous_payment_recovers_credit():
    attester = accounts()[0]
    c = deploy()
    file_claim(c, attester, "A dup-seed claim for recovery.", ["https://ex.com/rec"])
    settle_by = int(time.time()) + 3600
    transact_ok(c, "file_attestation", attester,
                ["A dup-seed claim for recovery.", "The sources must confirm the claim.", ["https://ex.com/rec"], settle_by],
                value=STAKE)
    assert credit(c, attester.address) == STAKE
    transact_fail(c, "withdraw", attester, [STAKE * 5])       # over-withdraw reverts atomically
    assert credit(c, attester.address) == STAKE
    transact_fail(c, "withdraw", attester, [0])               # zero withdrawal reverts
    assert credit(c, attester.address) == STAKE


# --------------------------------------------------------------- expiry / lapse

@pytest.mark.slow
def test_expired_attestation_lapses_returning_stake_and_bond():
    # Needs a real wait past settle-by (min window is 5 minutes on-chain).
    attester, challenger = accounts()[0], accounts()[1]
    c = deploy()
    window = 300
    aid = file_claim(c, attester, "A claim that will expire unreviewed.", ["https://ex.com/lapse"], window=window)
    transact_ok(c, "challenge_attestation", challenger, [aid], value=STAKE)
    time.sleep(window + 20)
    transact_ok(c, "lapse_attestation", attester, [aid])
    assert att(c, aid)["status"] == "LAPSED"
    assert credit(c, attester.address) == STAKE
    assert credit(c, challenger.address) == STAKE
    assert rep(c, attester.address)["resolved"] == 0
