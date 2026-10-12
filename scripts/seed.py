#!/usr/bin/env python3
"""Seed AttestBond with one SUPPORTED + one REFUTED attestation, then withdraw.

    source ~/.genlayer/env.sh
    python3 scripts/seed.py 0x<contract>
"""
import json
import os
import sys

import genlayer_py as g
from genlayer_py import chains
from genlayer_py.types import TransactionStatus

STAKE = 10 ** 15  # 0.001 GEN


def main() -> int:
    addr = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("ATTESTBOND_ADDR", "")
    if not addr:
        print("usage: python3 scripts/seed.py 0x<contract>")
        return 2
    attester = g.create_account(os.environ["GENLAYER_PRIVATE_KEY"])
    challenger = g.create_account(os.environ["GENLAYER_PRIVATE_KEY_2"])
    cl = g.create_client(chain=chains.studionet, account=attester)

    now = __import__("time")
    settle_by = int(now.time()) + 3600

    cases = [
        ("SUPPORTED",
         "Python 3.13.0 final has been released and is published on python.org.",
         "The sources must confirm that Python 3.13.0 has been released.",
         ["https://www.python.org/downloads/release/python-3130/"]),
        ("REFUTED",
         "python.org officially lists Python version 2.0 as the current latest stable release.",
         "The sources must confirm the current latest stable Python release is version 2.0.",
         ["https://www.python.org/downloads/"]),
    ]

    filed = []
    for label, claim, rule, urls in cases:
        print(f"\n== filing [{label}] ==")
        tx = cl.write_contract(address=addr, function_name="file_attestation",
                               value=STAKE, account=attester,
                               args=[challenger.address, claim, rule, urls, settle_by])
        print("  file tx:", tx)
        cl.wait_for_transaction_receipt(transaction_hash=tx, status=TransactionStatus.ACCEPTED,
                                        interval=4000, retries=140)
        count = int(cl.read_contract(address=addr, function_name="get_attestation_count", args=[]))
        aid = str(count - 1)
        print("  filed id:", aid)
        filed.append((label, aid))

    for label, aid in filed:
        print(f"\n== reviewing id {aid} (expect {label}) ==")
        tx = cl.write_contract(address=addr, function_name="review_attestation",
                               account=attester, args=[aid])
        print("  review tx:", tx)
        cl.wait_for_transaction_receipt(transaction_hash=tx, status=TransactionStatus.ACCEPTED,
                                        interval=4000, retries=160)
        rec = json.loads(cl.read_contract(address=addr, function_name="get_attestation", args=[aid]))
        print(f"  verdict={rec['verdict']} status={rec['status']} conf={rec['confidence']}")
        print("  reason:", rec["reason"])

    rep = json.loads(cl.read_contract(address=addr, function_name="get_reputation",
                                      args=[attester.address]))
    print("\nattester reputation:", rep)
    print("done.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
