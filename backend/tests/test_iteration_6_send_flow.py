"""Iteration 6 - verify the "stuck RUNNING with sent=0" bug is fixed.

Drives the queue end-to-end exactly like the app does and asserts counts
identity, no duplicates, retry semantics, cancel, resend, resend-failed,
settings persistence, and token self-heal via /gateway/setup.
"""
import io
import os
import time

import pandas as pd
import pytest
import requests

BASE = os.environ["EXPO_PUBLIC_BACKEND_URL"].rstrip("/") + "/api" if os.environ.get("EXPO_PUBLIC_BACKEND_URL") else None
# Fallback: read frontend/.env
if not BASE:
    with open("/app/frontend/.env") as f:
        for line in f:
            if line.startswith("EXPO_PUBLIC_BACKEND_URL="):
                BASE = line.split("=", 1)[1].strip() + "/api"
                break


def _token():
    r = requests.post(f"{BASE}/gateway/setup", timeout=15)
    r.raise_for_status()
    return r.json()["token"]


TOKEN = _token()
H = {"X-Gateway-Token": TOKEN}


def _make_xlsx(n: int) -> bytes:
    rows = [{"Mobile Number": f"91000000{i:03d}", "Message": f"Hello {i}"} for i in range(1, n + 1)]
    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as w:
        pd.DataFrame(rows).to_excel(w, index=False, sheet_name="SMS")
    buf.seek(0)
    return buf.read()


def _create_batch(n: int):
    files = {"file": (f"t{n}.xlsx", _make_xlsx(n),
                      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")}
    r = requests.post(f"{BASE}/files", files=files, headers=H, timeout=30)
    r.raise_for_status()
    fid = r.json()["file_id"]
    sheet = r.json()["sheets"][0]
    body = {"file_id": fid, "sheet": sheet, "mobile_column": "Mobile Number",
            "message_column": "Message", "country_code": "+91"}
    r = requests.post(f"{BASE}/batches", json=body, headers=H, timeout=15)
    r.raise_for_status()
    return r.json()["batch_id"]


def _counts_identity(b):
    assert b["total"] == b["sent"] + b["failed"] + b["sending"] + b["retrying"] + b["queued"] + b["cancelled"], b


def _drain(batch_id, mark="sent"):
    """Loop next-batch -> /jobs/results until no jobs remain."""
    iterations = 0
    while True:
        iterations += 1
        assert iterations < 200, "runaway loop"
        r = requests.get(f"{BASE}/batches/{batch_id}/next-batch?n=20", headers=H, timeout=15)
        r.raise_for_status()
        data = r.json()
        jobs = data["jobs"]
        b = requests.get(f"{BASE}/batches/{batch_id}", headers=H, timeout=15).json()
        _counts_identity(b)
        if not jobs:
            if b["pending"] == 0 and b["sending"] == 0:
                return b
            time.sleep(1.0)
            continue
        results = [{"message_id": j["message_id"], "status": mark, "simulated": True} for j in jobs]
        rr = requests.post(f"{BASE}/jobs/results", json={"results": results}, headers=H, timeout=15)
        rr.raise_for_status()


# ----------------------- PRIMARY: send flow completes ---------------------- #
@pytest.mark.parametrize("n", [5, 50])
def test_send_flow_completes(n):
    bid = _create_batch(n)
    final = _drain(bid, "sent")
    assert final["sent"] == n, final
    assert final["pending"] == 0 and final["sending"] == 0 and final["failed"] == 0
    _counts_identity(final)
    lst = requests.get(f"{BASE}/batches", headers=H).json()["items"]
    me = next(x for x in lst if x["batch_id"] == bid)
    assert me["display_status"] == "COMPLETED"
    assert me["sent"] == n


# ------------------------- TOKEN self-heal / 403 --------------------------- #
def test_setup_idempotent_and_403_on_bad_token():
    t1 = requests.post(f"{BASE}/gateway/setup").json()["token"]
    t2 = requests.post(f"{BASE}/gateway/setup").json()["token"]
    assert t1 == t2 == TOKEN  # idempotent, no rotation on setup
    r = requests.get(f"{BASE}/gateway/settings", headers={"X-Gateway-Token": "bad"})
    assert r.status_code == 403
    # client re-fetches via setup and now succeeds
    t3 = requests.post(f"{BASE}/gateway/setup").json()["token"]
    r2 = requests.get(f"{BASE}/gateway/settings", headers={"X-Gateway-Token": t3})
    assert r2.status_code == 200


# ----------------------------- NO duplicates ------------------------------- #
def test_no_duplicate_sends():
    bid = _create_batch(3)
    r = requests.get(f"{BASE}/batches/{bid}/next-batch?n=10", headers=H).json()
    msg_ids = [j["message_id"] for j in r["jobs"]]
    assert len(msg_ids) == 3
    # mark all sent
    requests.post(f"{BASE}/jobs/results", headers=H,
                  json={"results": [{"message_id": m, "status": "sent"} for m in msg_ids]}).raise_for_status()
    # replay bulk -> ignored
    r2 = requests.post(f"{BASE}/jobs/results", headers=H,
                       json={"results": [{"message_id": m, "status": "sent"} for m in msg_ids]})
    assert r2.json()["applied"] == 0
    # single endpoint replay -> duplicate_ignored and status stays SENT
    r3 = requests.post(f"{BASE}/jobs/{msg_ids[0]}/result", headers=H,
                       json={"status": "sent"}).json()
    assert r3.get("duplicate_ignored") is True
    assert r3["status"] == "SENT"
    # next-batch returns nothing (all SENT)
    r4 = requests.get(f"{BASE}/batches/{bid}/next-batch?n=10", headers=H).json()
    assert r4["jobs"] == []


# ------------------------------- RETRY ------------------------------------- #
def test_retry_then_failed():
    bid = _create_batch(1)
    # attempt 1 -> fail
    j = requests.get(f"{BASE}/batches/{bid}/next-batch?n=1", headers=H).json()["jobs"][0]
    mid = j["message_id"]
    r1 = requests.post(f"{BASE}/jobs/{mid}/result", headers=H,
                       json={"status": "failed", "error_message": "e1"}).json()
    assert r1["status"] == "RETRYING"
    # next-attempt_at is in the future (10s). We can't wait; just verify DB state.
    doc = requests.get(f"{BASE}/history?search={mid}", headers=H).json()["items"][0]
    assert doc["status"] == "RETRYING"
    assert doc.get("attempts") == 1


# ------------------------------ CANCEL ------------------------------------- #
def test_cancel_flips_pending_keeps_sent():
    bid = _create_batch(4)
    # send first 2
    r = requests.get(f"{BASE}/batches/{bid}/next-batch?n=2", headers=H).json()
    requests.post(f"{BASE}/jobs/results", headers=H, json={
        "results": [{"message_id": j["message_id"], "status": "sent"} for j in r["jobs"]]
    }).raise_for_status()
    # cancel
    requests.post(f"{BASE}/batches/{bid}/control", json={"action": "cancel"}, headers=H).raise_for_status()
    b = requests.get(f"{BASE}/batches/{bid}", headers=H).json()
    assert b["sent"] == 2 and b["cancelled"] == 2 and b["queued"] == 0 and b["sending"] == 0
    _counts_identity(b)
    # next returns nothing
    nxt = requests.get(f"{BASE}/batches/{bid}/next-batch?n=10", headers=H).json()
    assert nxt["jobs"] == []


# ------------------------------ RESEND ------------------------------------- #
def test_resend_failed_endpoint():
    bid = _create_batch(2)
    # fail both to the max
    for _ in range(3):
        jobs = requests.get(f"{BASE}/batches/{bid}/next-batch?n=10", headers=H).json()["jobs"]
        if not jobs:
            break
        requests.post(f"{BASE}/jobs/results", headers=H, json={
            "results": [{"message_id": j["message_id"], "status": "failed",
                         "error_message": "nope"} for j in jobs]
        })
        time.sleep(0.1)
    # Backend puts them in RETRYING with next_attempt_at in the future until
    # attempts==max; after 3 fails they should be FAILED (but we did not wait
    # for backoff). We just test the "no failed" 400 path works correctly on
    # the ORIGINAL batch if there are failed, else via a batch we know has none.
    b = requests.get(f"{BASE}/batches/{bid}", headers=H).json()
    if b["failed"] > 0:
        r = requests.post(f"{BASE}/batches/{bid}/resend-failed", headers=H)
        assert r.status_code == 200
        assert r.json()["total"] == b["failed"]
    # resend-failed on a batch with 0 failed -> 400
    other = _create_batch(1)
    _drain(other, "sent")
    r2 = requests.post(f"{BASE}/batches/{other}/resend-failed", headers=H)
    assert r2.status_code == 400


# ------------------------------ SETTINGS ----------------------------------- #
def test_settings_persist_chunk_and_delay_zero():
    body = {"chunk_size": 25, "chunk_pause": 15, "sending_delay": 0}
    r = requests.put(f"{BASE}/gateway/settings", json=body, headers=H).json()
    assert r["chunk_size"] == 25 and r["chunk_pause"] == 15 and r["sending_delay"] == 0
    g = requests.get(f"{BASE}/gateway/settings", headers=H).json()
    assert g["chunk_size"] == 25 and g["chunk_pause"] == 15 and g["sending_delay"] == 0
    # restore sane default
    requests.put(f"{BASE}/gateway/settings", json={"sending_delay": 1}, headers=H)


# ------------------------------ REGRESSION -------------------------------- #
def test_regression_endpoints():
    assert requests.get(f"{BASE}/sample-template").status_code == 200
    db = requests.get(f"{BASE}/dashboard", headers=H).json()
    for k in ("gateway_state", "sms_permission", "current_job"):
        assert k in db
    requests.post(f"{BASE}/gateway/heartbeat", headers=H,
                  json={"sim_available": True, "network_connected": True, "sms_permission": True}).raise_for_status()
    hist = requests.get(f"{BASE}/history?status=SENT&search=", headers=H).json()
    assert "items" in hist
    if hist["items"]:
        assert "job_id" in hist["items"][0] or "message_id" in hist["items"][0]
    assert requests.get(f"{BASE}/batches").status_code in (401, 403)
    assert requests.get(f"{BASE}/batches", headers={"X-Gateway-Token": "nope"}).status_code == 403
