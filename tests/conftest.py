"""Shared helpers for the AttestBond gltest suite.

The suite runs the real contract bytecode in gltest's in-process "direct" VM
(Foundry-style cheatcodes), which exercises every branch deterministically -
including the non-deterministic web/LLM paths - without needing live validators
or a faucet. The same contract is what ships to Studionet; `scripts/seed.py`
drives the identical flow against the live network with a real LLM jury.
"""
import datetime
import json

CONTRACT = "contracts/attestbond.py"
STAKE = 10 ** 15            # 0.001 GEN
MIN_STAKE = 5 * 10 ** 14    # must match the contract constant
SINK = "0x" + ("0" * 38) + "dead"
AUDITOR = r"attestation auditor"   # matches a line in the leader prompt


def now() -> int:
    return int(datetime.datetime.now(datetime.timezone.utc).timestamp())


def hx(addr) -> str:
    """Direct-VM addresses are 20 raw bytes; views take a 0x hex string."""
    return "0x" + addr.hex()


def iso_in(seconds: int) -> str:
    return (datetime.datetime.now(datetime.timezone.utc)
            + datetime.timedelta(seconds=seconds)).isoformat()


def file_claim(c, vm, attester, claim, urls, stake=STAKE, window=3600, rule="rule: the sources must confirm the claim"):
    vm.sender = attester
    vm.origin = attester
    vm.value = stake
    aid = c.file_attestation(claim, rule, urls, now() + window)
    vm.value = 0
    return aid


def mock_support(vm, body="the claim is clearly confirmed by this page. " * 8):
    vm.clear_mocks()
    vm.mock_web(r"https://", {"status": 200, "body": body})
    vm.mock_llm(AUDITOR, '{"verdict":"SUPPORTED","confidence":96,"reason":"The source confirms the claim."}')


def mock_refute(vm, body="this page directly contradicts the claim. " * 8):
    vm.clear_mocks()
    vm.mock_web(r"https://", {"status": 200, "body": body})
    vm.mock_llm(AUDITOR, '{"verdict":"REFUTED","confidence":92,"reason":"The source contradicts the claim."}')


def review_as(c, vm, who, aid):
    vm.sender = who
    vm.origin = who
    return c.review_attestation(aid)


def att(c, aid) -> dict:
    return json.loads(c.get_attestation(aid))


def rep(c, addr) -> dict:
    return json.loads(c.get_reputation(hx(addr)))


def credit(c, addr) -> int:
    return int(c.get_credit(hx(addr)))
