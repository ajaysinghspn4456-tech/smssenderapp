"""Pytest suite for iteration 5 features (RESEND / CANCEL / CANCEL-ALL /
LIST with display_status / next-batch + jobs/results bulk / duplicate
prevention) plus regression on auth."""
import io
import re
import pytest
import requests
import pandas as pd

with open("/app/frontend/.env") as f:
    for line in f:
        if line.startswith("EXPO_PUBLIC_BACKEND_URL="):
            BASE = line.split("=", 1)[1].strip()
            break
API = f"{BASE}/api"


@pytest.fixture(scope="session")
def token():
    r = requests.post(f"{API}/gateway/setup", timeout=30)
    assert r.status_code == 200, r.text
    return r.json()["token"]


@pytest.fixture(scope="session")
def h(token):
    return {"X-Gateway-Token": token}


def _xlsx(rows):
    df = pd.DataFrame(rows)
    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as w:
        df.to_excel(w, index=False, sheet_name="Sheet1")
    buf.seek(0)
    return buf.getvalue()


def _batch(h, mobiles, msg="TEST_i5"):
    rows = [{"Mobile": m, "Message": f"{msg}_{i}"} for i, m in enumerate(mobiles)]
    files = {"file": ("t.xlsx", _xlsx(rows),
             "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")}
    r = requests.post(f"{API}/files", headers=h, files=files, timeout=30)
    assert r.status_code == 200, r.text
    fid = r.json()["file_id"]
    r = requests.post(f"{API}/batches", headers=h,
                      json={"file_id": fid, "sheet": "Sheet1",
                            "mobile_column": "Mobile", "message_column": "Message",
                            "country_code": "+91"}, timeout=30)
    assert r.status_code == 200, r.text
    return r.json()["batch_id"]


def _identity(b):
    total = b["total"]
    parts = (b["sent"] + b["failed"] + b["sending"] +
             b["retrying"] + b["queued"] + b["cancelled"])
    assert total == parts, f"counts identity broken: {b}"


# -------------------- RESEND single history message ----------------------- #
class TestResendMessage:
    def test_resend_single_creates_new_batch_originals_unchanged(self, h):
        batch_id = _batch(h, ["9100000001"])
        # Claim + mark SENT
        r = requests.get(f"{API}/batches/{batch_id}/next", headers=h, timeout=30).json()
        old_msg = r["job"]["message_id"]
        rr = requests.post(f"{API}/jobs/{old_msg}/result", headers=h,
                           json={"status": "sent", "simulated": True}, timeout=30).json()
        assert rr["status"] == "SENT"

        # Snapshot original from history
        hist = requests.get(f"{API}/history?limit=200", headers=h, timeout=30).json()["items"]
        orig = next((j for j in hist if j["message_id"] == old_msg), None)
        assert orig is not None and orig["status"] == "SENT"
        orig_sent_at = orig.get("sent_at")
        orig_mobile = orig["mobile_number"]
        orig_message = orig["message"]

        # Resend
        res = requests.post(f"{API}/history/{old_msg}/resend", headers=h, timeout=30)
        assert res.status_code == 200, res.text
        rb = res.json()
        assert rb["total"] == 1
        new_batch = rb["batch_id"]
        assert new_batch != batch_id

        # The original job should be UNCHANGED
        hist2 = requests.get(f"{API}/history?limit=200", headers=h, timeout=30).json()["items"]
        same = next(j for j in hist2 if j["message_id"] == old_msg)
        assert same["status"] == "SENT"
        assert same.get("sent_at") == orig_sent_at

        # The new job should be QUEUED w/ same mobile+message and NEW message_id
        new_items = [j for j in hist2 if j.get("batch_id") == new_batch]
        assert len(new_items) == 1
        n = new_items[0]
        assert n["status"] == "QUEUED"
        assert n["message_id"] != old_msg
        assert n["mobile_number"] == orig_mobile
        assert n["message"] == orig_message
        assert re.match(r"^SMS-\d{6}-\d{6}$", n["job_id"])

    def test_resend_unknown_message_404(self, h):
        r = requests.post(f"{API}/history/MSG-NOPE-00001/resend", headers=h, timeout=30)
        assert r.status_code == 404


# -------------------- RESEND whole batch ---------------------------------- #
class TestResendBatch:
    def test_resend_whole_batch_clones_all(self, h):
        batch_id = _batch(h, ["9100000010", "9100000011", "9100000012"])
        # Snapshot originals
        before = requests.get(f"{API}/batches/{batch_id}", headers=h, timeout=30).json()
        assert before["total"] == 3 and before["queued"] == 3

        res = requests.post(f"{API}/batches/{batch_id}/resend", headers=h, timeout=30)
        assert res.status_code == 200, res.text
        d = res.json()
        assert d["total"] == 3
        new_batch = d["batch_id"]
        assert new_batch != batch_id

        # Original unchanged (still 3 queued, same batch_id)
        after = requests.get(f"{API}/batches/{batch_id}", headers=h, timeout=30).json()
        assert after["queued"] == 3 and after["total"] == 3

        # New batch has 3 queued fresh jobs
        nb = requests.get(f"{API}/batches/{new_batch}", headers=h, timeout=30).json()
        assert nb["total"] == 3 and nb["queued"] == 3


# -------------------- CANCEL one batch (queue-level) ---------------------- #
class TestCancelOne:
    def test_cancel_flips_pending_to_cancelled_and_queue_stops(self, h):
        batch_id = _batch(h, ["9100000020", "9100000021", "9100000022", "9100000023"])
        # Claim one and mark SENT -> this one must remain SENT after cancel
        c1 = requests.get(f"{API}/batches/{batch_id}/next", headers=h, timeout=30).json()
        sent_msg = c1["job"]["message_id"]
        requests.post(f"{API}/jobs/{sent_msg}/result", headers=h,
                      json={"status": "sent", "simulated": True}, timeout=30)

        # Cancel
        r = requests.post(f"{API}/batches/{batch_id}/control", headers=h,
                          json={"action": "cancel"}, timeout=30)
        assert r.status_code == 200, r.text
        b = r.json()
        assert b["control_state"] == "cancelled"
        # sent kept + queued->cancelled
        assert b["sent"] == 1
        assert b["cancelled"] == 3
        assert b["queued"] == 0 and b["sending"] == 0 and b["retrying"] == 0
        _identity(b)

        # Queue-level stop: /next must not return a job
        n = requests.get(f"{API}/batches/{batch_id}/next", headers=h, timeout=30).json()
        assert n["job"] is None
        assert n["control_state"] == "cancelled"

        # And /next-batch also returns none
        nb = requests.get(f"{API}/batches/{batch_id}/next-batch?n=5",
                          headers=h, timeout=30).json()
        assert nb["jobs"] == []
        assert nb["control_state"] == "cancelled"

        # Original SENT doc unchanged
        hist = requests.get(f"{API}/history?limit=200&search={sent_msg}",
                            headers=h, timeout=30).json()["items"]
        same = next(j for j in hist if j["message_id"] == sent_msg)
        assert same["status"] == "SENT"


# -------------------- CANCEL ALL ------------------------------------------ #
class TestCancelAll:
    def test_cancel_all_cancels_running_batches(self, h):
        b1 = _batch(h, ["9100000030", "9100000031"])
        b2 = _batch(h, ["9100000032", "9100000033"])
        res = requests.post(f"{API}/batches/cancel-all", headers=h, timeout=30)
        assert res.status_code == 200, res.text
        assert res.json()["cancelled_batches"] >= 2
        # Both affected batches must have 0 pending work
        for bid in (b1, b2):
            d = requests.get(f"{API}/batches/{bid}", headers=h, timeout=30).json()
            assert d["control_state"] == "cancelled"
            assert d["queued"] == 0 and d["sending"] == 0 and d["retrying"] == 0
            _identity(d)


# -------------------- LIST batches + display_status ----------------------- #
class TestListBatches:
    def test_list_includes_fields_and_display_status(self, h):
        bid = _batch(h, ["9100000040"])
        r = requests.get(f"{API}/batches", headers=h, timeout=30)
        assert r.status_code == 200
        items = r.json()["items"]
        assert len(items) >= 1
        row = next((x for x in items if x["batch_id"] == bid), None)
        assert row is not None
        for k in ("name", "display_status", "total", "queued", "sent",
                  "failed", "sending", "retrying", "cancelled"):
            assert k in row, f"missing field: {k}"
        assert row["display_status"] in (
            "RUNNING", "PAUSED", "COMPLETED", "CANCELLED", "FAILED")
        _identity(row)


# -------------------- SPEED: next-batch + bulk results -------------------- #
class TestBulkPath:
    def test_next_batch_claims_n_atomically(self, h):
        bid = _batch(h, [f"910000005{i}" for i in range(6)])
        r = requests.get(f"{API}/batches/{bid}/next-batch?n=4", headers=h,
                         timeout=30).json()
        jobs = r["jobs"]
        assert len(jobs) == 4
        for j in jobs:
            assert j["status"] == "SENDING"
            assert j["attempts"] == 1

        # bulk results: 3 sent, 1 failed
        results = [{"message_id": j["message_id"],
                    "status": ("sent" if i < 3 else "failed"),
                    "error_message": None if i < 3 else "boom",
                    "simulated": True} for i, j in enumerate(jobs)]
        rr = requests.post(f"{API}/jobs/results", headers=h,
                           json={"results": results}, timeout=30)
        assert rr.status_code == 200, rr.text
        assert rr.json()["applied"] == 4

        # Verify state
        d = requests.get(f"{API}/batches/{bid}", headers=h, timeout=30).json()
        assert d["sent"] == 3
        assert d["retrying"] == 1  # 1 failed with attempts<max -> RETRYING
        assert d["sending"] == 0
        _identity(d)

    def test_bulk_results_idempotent(self, h):
        bid = _batch(h, ["9100000060"])
        r = requests.get(f"{API}/batches/{bid}/next-batch?n=1", headers=h,
                         timeout=30).json()
        msg = r["jobs"][0]["message_id"]
        # Mark sent
        a1 = requests.post(f"{API}/jobs/results", headers=h,
                           json={"results": [{"message_id": msg,
                                              "status": "sent",
                                              "simulated": True}]},
                           timeout=30).json()
        assert a1["applied"] == 1
        # Replay (job is now SENT, not SENDING) must be ignored
        a2 = requests.post(f"{API}/jobs/results", headers=h,
                           json={"results": [{"message_id": msg,
                                              "status": "failed",
                                              "error_message": "late",
                                              "simulated": True}]},
                           timeout=30).json()
        assert a2["applied"] == 0
        # And status still SENT
        hist = requests.get(f"{API}/history?limit=50&search={msg}",
                            headers=h, timeout=30).json()["items"]
        assert any(j["message_id"] == msg and j["status"] == "SENT" for j in hist)


# -------------------- Auth regression ------------------------------------- #
class TestAuth:
    def test_missing_token(self):
        r = requests.get(f"{API}/batches", timeout=30)
        assert r.status_code == 403

    def test_invalid_token(self):
        r = requests.get(f"{API}/batches",
                         headers={"X-Gateway-Token": "nope"}, timeout=30)
        assert r.status_code == 403
