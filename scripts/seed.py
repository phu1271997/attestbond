#!/usr/bin/env python3
"""Seed AttestBond with a full, money-at-stake story on Studionet:

  1. SUPPORTED, unchallenged  - stake returns to the attester, reputation rises.
  2. REFUTED, with an INDEPENDENT challenger who posts a matching bond - the
     challenger collects the stake + bond, the attester's reputation falls.
  3. both winners withdraw their credited GEN.

    source ~/.genlayer/env.sh      # GENLAYER_PRIVATE_KEY + GENLAYER_PRIVATE_KEY_2
    python3 scripts/seed.py 0x<contract>
"""
import json
import os
import sys
import time

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
    chl = g.create_client(chain=chains.studionet, account=challenger)

    def wait(c, tx):
        return c.wait_for_transaction_receipt(
            transaction_hash=tx, status=TransactionStatus.FINALIZED,
            interval=5000, retries=200)

    settle_by = int(time.time()) + 3600

    # --- 1. a true claim, left unchallenged -> SUPPORTED -------------------
    print("\n== filing [SUPPORTED] (unchallenged) ==")
    tx = cl.write_contract(address=addr, function_name="file_attestation", value=STAKE,
                           account=attester,
                           args=["Python 3.13.0 final has been released and is published on python.org.",
                                 "The sources must confirm that Python 3.13.0 has been released.",
                                 ["https://www.python.org/downloads/release/python-3130/"], settle_by])
    wait(cl, tx)
    sup_id = str(int(cl.read_contract(address=addr, function_name="get_attestation_count", args=[])) - 1)
    print("  filed id:", sup_id)

    # --- 2. a false claim, then an INDEPENDENT challenge -> REFUTED ---------
    print("\n== filing [REFUTED] (will be challenged) ==")
    tx = cl.write_contract(address=addr, function_name="file_attestation", value=STAKE,
                           account=attester,
                           args=["python.org officially lists Python version 2.0 as the current latest stable release.",
                                 "The sources must confirm the current latest stable Python release is version 2.0.",
                                 ["https://www.python.org/downloads/"], settle_by])
    wait(cl, tx)
    ref_id = str(int(cl.read_contract(address=addr, function_name="get_attestation_count", args=[])) - 1)
    print("  filed id:", ref_id)

    print("  independent challenger posting a matching bond ...")
    tx = chl.write_contract(address=addr, function_name="challenge_attestation", value=STAKE,
                            account=challenger, args=[ref_id])
    wait(chl, tx)
    print("  challenger:", challenger.address)

    # --- reviews -----------------------------------------------------------
    for label, aid in (("SUPPORTED", sup_id), ("REFUTED", ref_id)):
        print(f"\n== reviewing id {aid} (expect {label}) ==")
        tx = cl.write_contract(address=addr, function_name="review_attestation",
                               account=attester, args=[aid])
        wait(cl, tx)
        rec = json.loads(cl.read_contract(address=addr, function_name="get_attestation", args=[aid]))
        print(f"  verdict={rec['verdict']} status={rec['status']} conf={rec['confidence']}")
        print(f"  payout={rec['payout']} -> {rec['recipient']} ({rec['settlement']})")
        print("  reason:", rec["reason"])

    rep = json.loads(cl.read_contract(address=addr, function_name="get_reputation", args=[attester.address]))
    print("\nattester reputation:", rep)

    # --- 3. winners withdraw ----------------------------------------------
    for name, acct, client in (("attester", attester, cl), ("challenger", challenger, chl)):
        avail = int(client.read_contract(address=addr, function_name="get_credit", args=[acct.address]))
        if avail <= 0:
            continue
        print(f"\n== {name} withdrawing {avail} ==")
        tx = client.write_contract(address=addr, function_name="withdraw",
                                   account=acct, args=[avail])
        wait(client, tx)
        acc = json.loads(client.read_contract(address=addr, function_name="get_account", args=[acct.address]))
        print("  account:", acc)

    print("\ndone.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
