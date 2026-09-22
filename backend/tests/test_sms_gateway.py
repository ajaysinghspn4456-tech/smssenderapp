"""Backend regression suite for Private SMS Gateway.
Covers setup/auth, dashboard, file upload/columns/validate, batch queue,
job result idempotency, control (pause/resume/stop), test SMS, history,
export, and settings.
"""
import io
import os
import time
import pytest
import requests
import pandas as pd

BASE = os.environ["EXPO_PUBLIC_BACKEND_URL"].rstrip("/") if os.environ.get("EXPO_PUBLIC_BACKEND_URL") else None
if not BASE:
    # fall back to reading frontend/.env
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


@pytest.fixture(scope="session")
def sample_xlsx_bytes():
    df = pd.DataFrame([
        {"Name": "A", "Mobile": "9876543210", "Message": "Hi TEST_1"},
        {"Name": "B", "Mobile": "+91 98765 43211", "Message": "Hi TEST_2"},
        {"Name": "C", "Mobile": "9876543210", "Message": "Hi TEST_dup"},   # duplicate
        {"Name": "D", "Mobile": "abc", "Message": "Hi TEST_invalid"},      # invalid
        {"Name": "E", "Mobile": "", "Message": ""},                        # empty
        {"Name": "F", "Mobile": "9876543212", "Message": ""},              # invalid (empty message)
    ])
    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as w:
        df.to_excel(w, index=False, sheet_name="Sheet1")
    buf.seek(0)
    return buf.getvalue()


# ---- Auth / setup --------------------------------------------------------- #
class TestAuth:
    def test_setup_returns_token(self, token):
        assert isinstance(token, str) and len(token) > 20

    def test_setup_idempotent_returns_same_token(self, token):
        r = requests.post(f"{API}/gateway/setup", timeout=30)
        assert r.status_code == 200
        body = r.json()
        assert body["created"] is False
        assert body["token"] == token

    def test_protected_route_without_token(self):
        r = requests.get(f"{API}/dashboard", timeout=30)
        assert r.status_code == 403

    def test_protected_route_with_invalid_token(self):
        r = requests.get(f"{API}/dashboard", headers={"X-Gateway-Token": "bad"}, timeout=30)
        assert r.status_code == 403


# ---- Dashboard + settings ------------------------------------------------- #
class TestDashboardSettings:
    def test_dashboard(self, h):
        r = requests.get(f"{API}/dashboard", headers=h, timeout=30)
        assert r.status_code == 200
        d = r.json()
        for k in ("gateway_id", "connected", "sim_available", "network_connected",
                  "today_total", "today_sent", "today_failed", "today_pending"):
            assert k in d

    def test_get_settings(self, h):
        r = requests.get(f"{API}/gateway/settings", headers=h, timeout=30)
        assert r.status_code == 200
        s = r.json()
        assert s["default_country_code"] == "+91"

    def test_update_settings_persists(self, h):
        r = requests.put(f"{API}/gateway/settings", headers=h, json={"sending_delay": 4}, timeout=30)
        assert r.status_code == 200
        assert r.json()["sending_delay"] == 4
        # revert
        requests.put(f"{API}/gateway/settings", headers=h, json={"sending_delay": 3}, timeout=30)


# ---- File upload / validate ---------------------------------------------- #
@pytest.fixture(scope="session")
def uploaded_file(h, sample_xlsx_bytes):
    files = {"file": ("test.xlsx", sample_xlsx_bytes,
                       "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")}
    r = requests.post(f"{API}/files", headers=h, files=files, timeout=30)
    assert r.status_code == 200, r.text
    return r.json()


class TestFileFlow:
    def test_upload(self, uploaded_file):
        assert "file_id" in uploaded_file
        assert uploaded_file["sheets"] == ["Sheet1"]

    def test_reject_bad_extension(self, h):
        r = requests.post(f"{API}/files", headers=h,
                          files={"file": ("bad.txt", b"hi", "text/plain")}, timeout=30)
        assert r.status_code == 400

    def test_columns(self, h, uploaded_file):
        r = requests.get(f"{API}/files/{uploaded_file['file_id']}/columns",
                         headers=h, params={"sheet": "Sheet1"}, timeout=30)
        assert r.status_code == 200
        c = r.json()
        assert c["columns"] == ["Name", "Mobile", "Message"]
        assert c["total_rows"] == 6
        assert len(c["preview"]) == 6

    def test_validate_summary(self, h, uploaded_file):
        r = requests.post(f"{API}/files/validate", headers=h,
                          json={"file_id": uploaded_file["file_id"], "sheet": "Sheet1",
                                "mobile_column": "Mobile", "message_column": "Message",
                                "country_code": "+91"}, timeout=30)
        assert r.status_code == 200
        v = r.json()
        s = v["summary"]
        assert s["total"] == 6
        assert s["valid"] == 2
        assert s["duplicate"] == 1
        assert s["invalid"] == 2
        assert s["empty"] == 1
        # normalization
        valid_rows = [r for r in v["rows"] if r["status"] == "valid"]
        assert all(vr["mobile"].startswith("+91") for vr in valid_rows)

    def test_validate_bad_column(self, h, uploaded_file):
        r = requests.post(f"{API}/files/validate", headers=h,
                          json={"file_id": uploaded_file["file_id"], "sheet": "Sheet1",
                                "mobile_column": "NoCol", "message_column": "Message",
                                "country_code": "+91"}, timeout=30)
        assert r.status_code == 400


# ---- Batch + queue -------------------------------------------------------- #
@pytest.fixture(scope="session")
def batch(h, uploaded_file):
    r = requests.post(f"{API}/batches", headers=h,
                      json={"file_id": uploaded_file["file_id"], "sheet": "Sheet1",
                            "mobile_column": "Mobile", "message_column": "Message",
                            "country_code": "+91"}, timeout=30)
    assert r.status_code == 200, r.text
    return r.json()


class TestBatch:
    def test_batch_created(self, batch):
        assert batch["total"] == 2  # 2 valid rows
        assert "batch_id" in batch

    def test_get_batch(self, h, batch):
        r = requests.get(f"{API}/batches/{batch['batch_id']}", headers=h, timeout=30)
        assert r.status_code == 200
        b = r.json()
        assert b["total"] == 2
        assert b["control_state"] == "running"

    def test_next_claims_pending_and_result_idempotent(self, h, batch):
        r = requests.get(f"{API}/batches/{batch['batch_id']}/next", headers=h, timeout=30)
        assert r.status_code == 200
        payload = r.json()
        assert payload["job"] is not None
        msg_id = payload["job"]["message_id"]
        # After claim, status should be SENDING internally; reporting result should transition
        rr = requests.post(f"{API}/jobs/{msg_id}/result", headers=h,
                           json={"status": "sent", "simulated": True}, timeout=30)
        assert rr.status_code == 200
        assert rr.json().get("status") == "SENT"
        # duplicate result must be ignored
        rr2 = requests.post(f"{API}/jobs/{msg_id}/result", headers=h,
                            json={"status": "sent", "simulated": True}, timeout=30)
        assert rr2.status_code == 200
        assert rr2.json().get("duplicate_ignored") is True

    def test_pause_requeues_sending(self, h, batch):
        # claim next
        r = requests.get(f"{API}/batches/{batch['batch_id']}/next", headers=h, timeout=30)
        assert r.status_code == 200
        job = r.json()["job"]
        assert job is not None, "expected a second job in SENDING"
        # pause
        rp = requests.post(f"{API}/batches/{batch['batch_id']}/control",
                           headers=h, json={"action": "pause"}, timeout=30)
        assert rp.status_code == 200
        # next should return null
        rn = requests.get(f"{API}/batches/{batch['batch_id']}/next", headers=h, timeout=30)
        assert rn.status_code == 200
        assert rn.json()["job"] is None
        # resume
        rr = requests.post(f"{API}/batches/{batch['batch_id']}/control",
                           headers=h, json={"action": "resume"}, timeout=30)
        assert rr.status_code == 200
        # should be able to claim the requeued PENDING job again
        rn2 = requests.get(f"{API}/batches/{batch['batch_id']}/next", headers=h, timeout=30)
        assert rn2.status_code == 200
        j2 = rn2.json()["job"]
        assert j2 is not None
        # complete it as failed
        requests.post(f"{API}/jobs/{j2['message_id']}/result", headers=h,
                      json={"status": "failed", "error_message": "TEST_fail",
                            "simulated": True}, timeout=30)

    def test_export(self, h, token, batch):
        r = requests.get(f"{API}/batches/{batch['batch_id']}/export",
                         params={"token": token}, timeout=30)
        assert r.status_code == 200
        assert "spreadsheet" in r.headers.get("content-type", "")
        assert len(r.content) > 1000

    def test_export_bad_token(self, batch):
        r = requests.get(f"{API}/batches/{batch['batch_id']}/export",
                         params={"token": "bad"}, timeout=30)
        assert r.status_code == 403


# ---- Test SMS ------------------------------------------------------------- #
class TestTestSms:
    def test_create_and_result(self, h):
        r = requests.post(f"{API}/sms/test", headers=h,
                          json={"mobile": "9876500001", "message": "TEST_hello"}, timeout=30)
        assert r.status_code == 200
        job = r.json()["job"]
        assert job["is_test"] is True
        assert job["status"] == "SENDING"
        assert job["mobile_number"] == "+919876500001"
        rr = requests.post(f"{API}/jobs/{job['message_id']}/result", headers=h,
                           json={"status": "sent", "simulated": True}, timeout=30)
        assert rr.status_code == 200

    def test_invalid_number(self, h):
        r = requests.post(f"{API}/sms/test", headers=h,
                          json={"mobile": "abc", "message": "x"}, timeout=30)
        assert r.status_code == 400


# ---- History -------------------------------------------------------------- #
class TestHistory:
    def test_all(self, h):
        r = requests.get(f"{API}/history?status=all&search=", headers=h, timeout=30)
        assert r.status_code == 200
        items = r.json()["items"]
        assert isinstance(items, list) and len(items) >= 1

    def test_filter_sent(self, h):
        r = requests.get(f"{API}/history?status=sent&search=", headers=h, timeout=30)
        assert r.status_code == 200
        assert all(i["status"] == "SENT" for i in r.json()["items"])

    def test_search_by_number(self, h):
        r = requests.get(f"{API}/history?status=all&search=9876500001", headers=h, timeout=30)
        assert r.status_code == 200
        items = r.json()["items"]
        assert any("9876500001" in i["mobile_number"] for i in items)


# ---- Token rotate --------------------------------------------------------- #
class TestTokenRotation:
    def test_regenerate_rotates(self, h, token):
        r = requests.post(f"{API}/gateway/token/regenerate", headers=h, timeout=30)
        assert r.status_code == 200
        new_tok = r.json()["token"]
        assert new_tok != token
        # old token should now fail
        r2 = requests.get(f"{API}/dashboard", headers={"X-Gateway-Token": token}, timeout=30)
        assert r2.status_code == 403
        # restore original for other tests -- rotate again using new
        r3 = requests.post(f"{API}/gateway/token/regenerate",
                           headers={"X-Gateway-Token": new_tok}, timeout=30)
        assert r3.status_code == 200
        # Update fixture-scoped header for later tests won't help; but session done here.
