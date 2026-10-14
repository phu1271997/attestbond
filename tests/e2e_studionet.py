"""Shared helpers for the StudioNet END-TO-END suite (tests/test_studionet_e2e.py).

Unlike conftest.py (which drives the in-process "direct" VM), everything here
talks to the live GenLayer Studio simulator over JSON-RPC: contracts are really
deployed, transactions really go through validator consensus, and every write is
asserted to reach FINALIZED with a GenVM execution_result of SUCCESS - not merely
ACCEPTED. Non-deterministic web/LLM paths are pinned with the simulator's
`sim_installMocks` so verdicts are driven by REAL public sources judged by the live LLM jury
(the hosted Studio RPC does not expose sim_installMocks, so there is no mocking;
content-fingerprint / truncation / malformed-parser invariants that require
controlled content stay in the direct suite). Reviews use stable public facts:
a true claim about python.org resolves SUPPORTED, a false one REFUTED.

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

# A real finalization wait: the Studio appeal window is short on the simulator,
# but give it room so a confirmed FINALIZED receipt is what we assert on.
FINAL = TransactionStatus.FINALIZED


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

    receipt = _retry(lambda: factory.deploy_contract_tx(args=[], wait_transaction_status=FINAL))
    if tx_execution_failed(receipt):
        raise RuntimeError(f"deploy failed: {receipt}")
    address = extract_contract_address(receipt)
    return GLContract.new(address=address, schema=schema, account=get_accounts()[0])


# --- real, stable public facts used to drive the live LLM jury ----------------
# A historically-published release page is a durable TRUE fact.
TRUE_CLAIM = "Python 3.13.0 final has been released and its release page is published on python.org."
TRUE_RULE = "The sources must confirm that Python 3.13.0 has been released."
TRUE_URLS = ["https://www.python.org/downloads/release/python-3130/"]
# A plainly FALSE fact contradicted by the live page.
FALSE_CLAIM = "python.org officially lists Python version 2.0 as the current latest stable release."
FALSE_RULE = "The sources must confirm the current latest stable Python release is version 2.0."
FALSE_URLS = ["https://www.python.org/downloads/"]
# A real dead link: renders empty => no source readable => INCONCLUSIVE.
DEAD_URLS = ["https://www.python.org/attestbond-nonexistent-deadlink-xyz-404"]


def transact(contract, method, account, args, value=0):
    """Transact through consensus and wait for a FINALIZED receipt."""
    bound = getattr(contract.connect(account), method)
    return bound(args=args).transact(value=value, wait_transaction_status=FINAL)


def transact_ok(contract, method, account, args, value=0):
    """Transact, wait FINALIZED, and assert the GenVM execution SUCCEEDED."""
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
