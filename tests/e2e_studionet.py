"""Shared helpers for the StudioNet END-TO-END suite (tests/test_studionet_e2e.py).

Unlike conftest.py (which drives the in-process "direct" VM), everything here
talks to the live GenLayer Studio network over JSON-RPC: contracts are really
deployed and transactions really go through validator consensus. Every write is
waited to ACCEPTED (bounded) and then asserted to have a GenVM execution_result
of SUCCESS — so inclusion alone is never treated as proof that the code ran.
The hosted Studio RPC does NOT expose sim_installMocks, so there is no mocking:
verdicts are driven by REAL public sources judged by the live LLM jury (a true
claim about python.org resolves SUPPORTED, a false one REFUTED, a dead link
INCONCLUSIVE). Content-fingerprint / truncation / malformed-parser invariants
that require controlled page content stay in the direct suite.

Run (opt-in; needs funded studionet keys and spends real test GEN):

    source ~/.genlayer/env.sh
    RUN_STUDIONET_E2E=1 gltest --network studionet tests/test_studionet_e2e.py -v
"""
import json
import os
import time

import pytest

from gltest import get_contract_factory, get_accounts, get_gl_client
from gltest.assertions import tx_execution_succeeded, tx_execution_failed
from gltest_cli.config.general import get_general_config
from genlayer_py.types import TransactionStatus

CONTRACT_PATH = "attestbond.py"   # resolved relative to the contracts/ dir by gltest
STAKE = 10 ** 15            # 0.001 GEN
MIN_STAKE = 5 * 10 ** 14
SLASH_BURN_BPS = 6000
SINK = "0x" + ("0" * 38) + "dead"
ZERO = "0x" + ("0" * 40)

# Wait for ACCEPTED (gltest's own default) and then assert the GenVM
# execution_result is SUCCESS on the receipt. ACCEPTED means the tx was carried
# through real validator consensus and the leader executed it; asserting
# execution_result verifies the code actually ran (we never treat mere inclusion
# as proof). FINALIZED adds permanence but, on the degraded hosted Studio, its
# wait can stall for many minutes, so we bound every wait to avoid hanging.
WAIT = TransactionStatus.ACCEPTED
WAIT_INTERVAL = 4000
WAIT_RETRIES = 75            # ~5 min hard cap per tx instead of the 16+ min default


def e2e_enabled() -> bool:
    """Only run against the live simulator when explicitly opted in."""
    if os.environ.get("RUN_STUDIONET_E2E") != "1":
        return False
    try:
        return get_general_config().check_studio_based_rpc()
    except Exception:
        return False


requires_studionet = pytest.mark.skipif(
    not e2e_enabled(),
    reason="StudioNet e2e opt-in: set RUN_STUDIONET_E2E=1 and run `gltest --network studionet`.",
)


def accounts():
    accs = get_accounts()
    if len(accs) < 3:
        pytest.skip("need at least 3 funded studionet accounts (GENLAYER_PRIVATE_KEY[_2.._3])")
    return accs


def _retry(fn, attempts=6):
    """studio.genlayer.com occasionally resets the connection; retry idempotent reads."""
    last = None
    for _ in range(attempts):
        try:
            return fn()
        except Exception as e:   # noqa: BLE001 - transient RPC/network errors
            last = e
            time.sleep(2)
    raise last


_SCHEMA_CACHE = {}


def _factory():
    return get_contract_factory(contract_file_path=CONTRACT_PATH)


def deploy():
    """Deploy a FRESH contract to studionet, wait for finalization, and build a
    Contract handle. The schema fetch and build are retried so a flaky RPC does
    not strand an already-deployed contract."""
    from gltest.contracts.contract import Contract as GLContract
    from gltest.utils import extract_contract_address
    from gltest.assertions import tx_execution_failed

    factory = _factory()
    if "schema" not in _SCHEMA_CACHE:
        # Fetch directly (raises on error so _retry can retry) rather than the
        # fallback helper, which swallows RPC errors and returns None.
        # Pass bytes: the contract source has non-ascii chars (em-dashes) that the
        # str path of encode_hex rejects.
        code_bytes = factory.contract_code.encode("utf-8")
        _SCHEMA_CACHE["schema"] = _retry(
            lambda: get_gl_client().get_contract_schema_for_code(code_bytes))
    schema = _SCHEMA_CACHE["schema"]
    if schema is None:
        raise RuntimeError("could not fetch contract schema from studionet")

    receipt = _retry(lambda: factory.deploy_contract_tx(
        args=[], wait_transaction_status=WAIT,
        wait_interval=WAIT_INTERVAL, wait_retries=WAIT_RETRIES))
    if tx_execution_failed(receipt):
        raise RuntimeError(f"deploy failed: {receipt}")
    address = extract_contract_address(receipt)
    return GLContract.new(address=address, schema=schema, account=get_accounts()[0])


# --- real, stable public facts used to drive the live LLM jury ----------------
# A historically-published release page is a durable TRUE fact.
TRUE_CLAIM = "Python 3.13.0 final has been released and its release page is published on python.org."
TRUE_RULE = "The sources must confirm that Python 3.13.0 has been released."
TRUE_URLS = ["https://www.python.org/downloads/release/python-3130/"]
# A plainly FALSE fact, pointed at the SAME small release page used above (which
# renders fully under MAX_EVIDENCE): the page announces 3.13.0, so a claim that
# it announces 2.0 is actively contradicted => REFUTED on complete evidence.
FALSE_CLAIM = "This python.org release page announces that the release being published is Python version 2.0."
FALSE_RULE = "The sources must confirm the release announced on the page is Python version 2.0."
FALSE_URLS = ["https://www.python.org/downloads/release/python-3130/"]
# A real dead link: renders empty => no source readable => INCONCLUSIVE.
DEAD_URLS = ["https://www.python.org/attestbond-nonexistent-deadlink-xyz-404"]


def transact(contract, method, account, args, value=0):
    """Transact through real validator consensus and return the receipt.

    Waits for ACCEPTED (bounded) — the tx has gone through consensus and the
    leader executed it. Callers assert on the receipt's execution_result. Writes
    are NOT blindly retried (a re-submit could double-execute); a transient
    studio outage mid-write fails the test loudly so it can be re-run.
    """
    client = get_gl_client()
    leader_only = (get_general_config().get_leader_only()
                   if get_general_config().check_studio_based_rpc() else False)
    # Submit ONCE (not retried — a re-submit could double-execute), then retry
    # only the idempotent receipt poll so a studio connection drop mid-wait does
    # not fail an already-submitted tx.
    tx_hash = client.write_contract(
        address=contract.address, function_name=method, account=account,
        value=value, args=args, leader_only=leader_only)
    return _retry(lambda: client.wait_for_transaction_receipt(
        transaction_hash=tx_hash, status=WAIT,
        interval=WAIT_INTERVAL, retries=WAIT_RETRIES))


def transact_ok(contract, method, account, args, value=0):
    """Transact and assert the GenVM execution_result is SUCCESS."""
    receipt = transact(contract, method, account, args, value)
    assert tx_execution_succeeded(receipt), f"expected SUCCESS from {method}, got: {receipt}"
    return receipt


def transact_fail(contract, method, account, args, value=0):
    """Transact and assert the GenVM execution FAILED (reverted)."""
    receipt = transact(contract, method, account, args, value)
    assert tx_execution_failed(receipt), f"expected a revert from {method}, got SUCCESS"
    return receipt


def call(contract, method, args=None):
    # Reads are idempotent, so retry through the studio RPC's intermittent
    # SSL/connection drops.
    bound = getattr(contract, method)
    return _retry(lambda: bound(args=args).call())


def view_json(contract, method, args=None):
    return json.loads(call(contract, method, args))


DEFAULT_RULE = "The sources must confirm the claim."


def file_claim(contract, account, claim, urls, value=STAKE, window=3600, rule=DEFAULT_RULE):
    """File an attestation and return its id (asserting the file succeeded)."""
    settle_by = int(time.time()) + window
    transact_ok(contract, "file_attestation", account, [claim, rule, urls, settle_by], value=value)
    return last_id(contract)


def att(contract, aid):
    return view_json(contract, "get_attestation", [aid])


def rep(contract, addr):
    return view_json(contract, "get_reputation", [addr])


def credit(contract, addr):
    return int(call(contract, "get_credit", [addr]))


def last_id(contract):
    return str(int(call(contract, "get_attestation_count")) - 1)
