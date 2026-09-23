"""Focused pytest suite for the NEW SMS gateway features (iteration 4).

Covers:
- Retry policy: 3-attempt cap driving a job to FAILED with counts identity at each step
- Exact counts identity: total == sent+failed+sending+retrying+queued and pending == queued+retrying
- Self-heal of stuck SENDING jobs (STUCK_TIMEOUT_SEC=90) -> we use 95s wait
- Idempotency / duplicate_ignored preserved
- Pause/Resume requeue of SENDING -> QUEUED
- New dashboard fields (sms_permission, gateway_state, current_job)
- Heartbeat accepts sms_permission and reflects in dashboard
- Regression: sample-template, history returns job_id, job_id format SMS-YYMMDD-NNNNNN
"""
import io
import os
import re
import time
import pytest
import requests
import pandas as pd

with open("/app/frontend/.env") as f:
    for line in f:
        if line.startswith("EXPO_PUBLIC_BACKEND_URL="):
            BASE = line.split("=", 1)[1].strip()
            break
API = f"{BASE}/api"


# ---- Fixtures ------------------------------------------------------------- #
@pytest.fixture(scope="session")
def token():
    r = requests.post(f"{API}/gateway/setup", timeout=30)
    assert r.status_code == 200, r.text
    return r.json()["token"]


@pytest.fixture(scope="session")
def h(token):
    return {"X-Gateway-Token": token}


def _make_xlsx(rows):
    df = pd.DataFrame(rows)
    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as w:
        df.to_excel(w, index=False, sheet_name="Sheet1")
    buf.seek(0)
    return buf.getvalue()


def _upload_and_batch(h, mobiles):
    rows = [{"Mobile": m, "Message": f"TEST_new_{i}"} for i, m in enumerate(mobiles)]
    data = _make_xlsx(rows)
    files = {"file": ("t.xlsx", data,
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


def _counts_identity(b):
    total = b["total"]
    parts = b["sent"] + b["failed"] + b["sending"] + b["retrying"] + b["queued"]
    assert total == parts, f"total identity broken: {b}"
    assert b["pending"] == b["queued"] + b["retrying"], f"pending identity broken: {b}"


# --------------------------------------------------------------------------- #
# NEW: retry cap (attempts=0 -> 1 -> 2 -> 3 -> FAILED) and counts identity
# --------------------------------------------------------------------------- #
class TestRetryCap:
    def test_three_failures_drive_to_failed_with_counts_identity(self, h):
        batch_id = _upload_and_batch(h, ["9000000001"])

        # State 0: 1 queued
        b = requests.get(f"{API}/batches/{batch_id}", headers=h, timeout=30).json()
        assert b["total"] == 1 and b["queued"] == 1 and b["retrying"] == 0
        _counts_identity(b)

        # Attempt 1
        r = requests.get(f"{API}/batches/{batch_id}/next", headers=h, timeout=30).json()
        assert r["job"] is not None, f"no job claimed: {r}"
        job = r["job"]
        assert job["attempts"] == 1
        msg_id = job["message_id"]
        assert re.match(r"^SMS-\d{6}-\d{6}$", job["job_id"]), f"bad job_id: {job['job_id']}"

        b = requests.get(f"{API}/batches/{batch_id}", headers=h, timeout=30).json()
        assert b["sending"] == 1 and b["queued"] == 0
        _counts_identity(b)

        # Fail 1 -> RETRYING (attempts=1 < 3)
        rr = requests.post(f"{API}/jobs/{msg_id}/result", headers=h,
                           json={"status": "failed", "error_message": "e1", "simulated": True},
                           timeout=30).json()
        assert rr["status"] == "RETRYING", rr
        b = requests.get(f"{API}/batches/{batch_id}", headers=h, timeout=30).json()
        assert b["retrying"] == 1 and b["sending"] == 0
        _counts_identity(b)
        assert b["pending"] == 1  # retrying counted as pending

        # Wait for 10s backoff
        time.sleep(11)

        # Attempt 2
        r = requests.get(f"{API}/batches/{batch_id}/next", headers=h, timeout=30).json()
        assert r["job"] is not None, f"job not re-claimable after backoff: {r}"
        assert r["job"]["attempts"] == 2
        b = requests.get(f"{API}/batches/{batch_id}", headers=h, timeout=30).json()
        assert b["sending"] == 1 and b["retrying"] == 0
        _counts_identity(b)

        rr = requests.post(f"{API}/jobs/{msg_id}/result", headers=h,
                           json={"status": "failed", "error_message": "e2", "simulated": True},
                           timeout=30).json()
        assert rr["status"] == "RETRYING", rr
        b = requests.get(f"{API}/batches/{batch_id}", headers=h, timeout=30).json()
        assert b["retrying"] == 1
        _counts_identity(b)

        # Wait 20s backoff
        time.sleep(21)

        # Attempt 3 -> after fail, attempts==3 -> FAILED
        r = requests.get(f"{API}/batches/{batch_id}/next", headers=h, timeout=30).json()
        assert r["job"] is not None
        assert r["job"]["attempts"] == 3
        rr = requests.post(f"{API}/jobs/{msg_id}/result", headers=h,
                           json={"status": "failed", "error_message": "e3", "simulated": True},
                           timeout=30).json()
        assert rr["status"] == "FAILED", rr

        b = requests.get(f"{API}/batches/{batch_id}", headers=h, timeout=30).json()
        assert b["failed"] == 1 and b["retrying"] == 0 and b["sending"] == 0
        _counts_identity(b)

    def test_sent_transition(self, h):
        batch_id = _upload_and_batch(h, ["9000000002"])
        r = requests.get(f"{API}/batches/{batch_id}/next", headers=h, timeout=30).json()
        msg_id = r["job"]["message_id"]
        rr = requests.post(f"{API}/jobs/{msg_id}/result", headers=h,
                           json={"status": "sent", "simulated": True}, timeout=30).json()
        assert rr["status"] == "SENT"
        b = requests.get(f"{API}/batches/{batch_id}", headers=h, timeout=30).json()
        assert b["sent"] == 1
        _counts_identity(b)


# --------------------------------------------------------------------------- #
# NEW: idempotency preserved on duplicate result
# --------------------------------------------------------------------------- #
class TestIdempotency:
    def test_duplicate_result_ignored(self, h):
        batch_id = _upload_and_batch(h, ["9000000003"])
        r = requests.get(f"{API}/batches/{batch_id}/next", headers=h, timeout=30).json()
        msg_id = r["job"]["message_id"]
        rr = requests.post(f"{API}/jobs/{msg_id}/result", headers=h,
                           json={"status": "sent", "simulated": True}, timeout=30).json()
        assert rr["status"] == "SENT"
        # duplicate
        rr2 = requests.post(f"{API}/jobs/{msg_id}/result", headers=h,
                            json={"status": "failed", "error_message": "should be ignored",
                                  "simulated": True}, timeout=30).json()
        assert rr2.get("duplicate_ignored") is True
        assert rr2.get("status") == "SENT"


# --------------------------------------------------------------------------- #
# NEW: pause/resume/stop requeue SENDING -> QUEUED
# --------------------------------------------------------------------------- #
class TestControlRequeue:
    def test_pause_requeues_and_resume_reclaims(self, h):
        batch_id = _upload_and_batch(h, ["9000000004", "9000000005"])
        # claim one
        r = requests.get(f"{API}/batches/{batch_id}/next", headers=h, timeout=30).json()
        assert r["job"] is not None
        # pause
        p = requests.post(f"{API}/batches/{batch_id}/control", headers=h,
                          json={"action": "pause"}, timeout=30).json()
        assert p["control_state"] == "paused"
        assert p["sending"] == 0, f"sending should be requeued on pause: {p}"
        assert p["queued"] == 2, f"both should be queued: {p}"
        _counts_identity(p)
        # next returns null while paused
        rn = requests.get(f"{API}/batches/{batch_id}/next", headers=h, timeout=30).json()
        assert rn["job"] is None
        assert rn["control_state"] == "paused"
        # resume
        requests.post(f"{API}/batches/{batch_id}/control", headers=h,
                      json={"action": "resume"}, timeout=30)
        r2 = requests.get(f"{API}/batches/{batch_id}/next", headers=h, timeout=30).json()
        assert r2["job"] is not None
        # clean up: mark sent
        requests.post(f"{API}/jobs/{r2['job']['message_id']}/result", headers=h,
                      json={"status": "sent", "simulated": True}, timeout=30)

    def test_stop_requeues(self, h):
        batch_id = _upload_and_batch(h, ["9000000006"])
        r = requests.get(f"{API}/batches/{batch_id}/next", headers=h, timeout=30).json()
        assert r["job"] is not None
        s = requests.post(f"{API}/batches/{batch_id}/control", headers=h,
                          json={"action": "stop"}, timeout=30).json()
        assert s["control_state"] == "stopped"
        assert s["sending"] == 0 and s["queued"] == 1
        _counts_identity(s)
        rn = requests.get(f"{API}/batches/{batch_id}/next", headers=h, timeout=30).json()
        assert rn["job"] is None
        assert rn["control_state"] == "stopped"


# --------------------------------------------------------------------------- #
# NEW: self-heal stuck SENDING jobs (STUCK_TIMEOUT_SEC = 90s)
# --------------------------------------------------------------------------- #
class TestSelfHeal:
    @pytest.mark.slow
    def test_stuck_sending_reclaimed_after_90s(self, h):
        batch_id = _upload_and_batch(h, ["9000000007"])
        r = requests.get(f"{API}/batches/{batch_id}/next", headers=h, timeout=30).json()
        assert r["job"] is not None
        first_msg_id = r["job"]["message_id"]
        assert r["job"]["attempts"] == 1
        # DO NOT report result. Wait 95s so the SENDING becomes stuck.
        time.sleep(95)
        # next() should self-heal (SENDING -> RETRYING) then reclaim it
        r2 = requests.get(f"{API}/batches/{batch_id}/next", headers=h, timeout=30).json()
        # After self-heal, the job is set RETRYING with next_attempt_at=now; same
        # request also claims it back -> attempts should be 2.
        assert r2["job"] is not None, f"self-heal did not reclaim: {r2}"
        assert r2["job"]["message_id"] == first_msg_id
        assert r2["job"]["attempts"] == 2
        b = requests.get(f"{API}/batches/{batch_id}", headers=h, timeout=30).json()
        _counts_identity(b)
        # clean up: mark sent to not leak
        requests.post(f"{API}/jobs/{first_msg_id}/result", headers=h,
                      json={"status": "sent", "simulated": True}, timeout=30)


# --------------------------------------------------------------------------- #
# NEW: dashboard fields + heartbeat sms_permission propagation
# --------------------------------------------------------------------------- #
class TestDashboardNewFields:
    def test_dashboard_has_new_fields(self, h):
        r = requests.get(f"{API}/dashboard", headers=h, timeout=30)
        assert r.status_code == 200
        d = r.json()
        for k in ("sms_permission", "gateway_state", "current_job",
                  "connected", "sim_available", "network_connected",
                  "today_total", "today_sent", "today_failed", "today_pending"):
            assert k in d, f"missing dashboard field: {k}"
        assert d["gateway_state"] in ("READY", "BUSY", "ERROR", "DISCONNECTED"), d["gateway_state"]

    def test_heartbeat_sets_sms_permission_and_gateway_state(self, h):
        # send heartbeat with sms_permission=True + sim + network
        r = requests.post(f"{API}/gateway/heartbeat", headers=h,
                          json={"sim_available": True, "network_connected": True,
                                "sms_permission": True}, timeout=30)
        assert r.status_code == 200
        d = requests.get(f"{API}/dashboard", headers=h, timeout=30).json()
        assert d["sms_permission"] is True
        assert d["sim_available"] is True
        assert d["network_connected"] is True
        assert d["connected"] is True
        # no active job at this exact moment expected -> READY (may be BUSY if other tests leaked)
        assert d["gateway_state"] in ("READY", "BUSY"), d

        # now flip sms_permission False -> gateway_state should become ERROR
        r = requests.post(f"{API}/gateway/heartbeat", headers=h,
                          json={"sim_available": True, "network_connected": True,
                                "sms_permission": False}, timeout=30)
        assert r.status_code == 200
        d = requests.get(f"{API}/dashboard", headers=h, timeout=30).json()
        assert d["sms_permission"] is False
        # if not busy, must be ERROR (permission missing)
        # if BUSY due to leaked SENDING, still acceptable but rare
        assert d["gateway_state"] in ("ERROR", "BUSY"), d


# --------------------------------------------------------------------------- #
# Regression: job_id in history, sample-template public helper
# --------------------------------------------------------------------------- #
class TestRegression:
    def test_history_has_job_id(self, h):
        r = requests.get(f"{API}/history?status=all&limit=50", headers=h, timeout=30)
        assert r.status_code == 200
        items = r.json()["items"]
        assert len(items) >= 1
        found = [i for i in items if i.get("job_id") and re.match(r"^SMS-\d{6}-\d{6}$", i["job_id"])]
        assert len(found) >= 1, f"no job_id in history items: {items[:3]}"

    def test_sample_template_public(self):
        r = requests.get(f"{API}/sample-template", timeout=30)
        assert r.status_code == 200
        assert "spreadsheet" in r.headers.get("content-type", "")
        assert len(r.content) > 500

    def test_auth_missing_token(self):
        r = requests.get(f"{API}/dashboard", timeout=30)
        assert r.status_code == 403

    def test_auth_bad_token(self):
        r = requests.get(f"{API}/dashboard", headers={"X-Gateway-Token": "nope"}, timeout=30)
        assert r.status_code == 403
