"""Iteration 2 focused tests:
- POST /api/files accepts .xlsx, .xls, .csv and returns {file_id, filename, sheets}
- Rejects unsupported extensions with 400
- GET /api/sample-template returns a downloadable xlsx (public)
- Missing/invalid X-Gateway-Token returns 403 (backend uses 403 for invalid token)
- Regression: full pipeline for CSV upload (sheet name == 'CSV')
"""
import io
import os
import pytest
import requests
import pandas as pd

BASE = os.environ.get("EXPO_PUBLIC_BACKEND_URL")
if not BASE:
    with open("/app/frontend/.env") as f:
        for line in f:
            if line.startswith("EXPO_PUBLIC_BACKEND_URL="):
                BASE = line.split("=", 1)[1].strip()
                break
API = f"{BASE.rstrip('/')}/api"


# ---- Fixtures ------------------------------------------------------------- #
@pytest.fixture(scope="module")
def token():
    r = requests.post(f"{API}/gateway/setup", timeout=30)
    assert r.status_code == 200, r.text
    return r.json()["token"]


@pytest.fixture(scope="module")
def h(token):
    return {"X-Gateway-Token": token}


def _df():
    return pd.DataFrame([
        {"Mobile": "9876543210", "Message": "TEST_1"},
        {"Mobile": "+91 98765 43211", "Message": "TEST_2"},
        {"Mobile": "9876543212", "Message": "TEST_3"},
    ])


@pytest.fixture(scope="module")
def xlsx_bytes():
    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as w:
        _df().to_excel(w, index=False, sheet_name="Sheet1")
    buf.seek(0)
    return buf.getvalue()


@pytest.fixture(scope="module")
def xls_bytes():
    # xlwt for legacy .xls writing
    xlwt = pytest.importorskip("xlwt")
    wb = xlwt.Workbook()
    ws = wb.add_sheet("Sheet1")
    ws.write(0, 0, "Mobile"); ws.write(0, 1, "Message")
    for i, row in enumerate(_df().itertuples(index=False), start=1):
        ws.write(i, 0, str(row.Mobile))
        ws.write(i, 1, str(row.Message))
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    return buf.getvalue()


@pytest.fixture(scope="module")
def csv_bytes():
    return _df().to_csv(index=False).encode()


# ---- Auth guard ---------------------------------------------------------- #
class TestAuthGuard:
    def test_missing_token_returns_403(self):
        # no header at all: FastAPI Header(None) -> require_token raises 403 (invalid)
        r = requests.post(f"{API}/files", files={"file": ("x.csv", b"Mobile,Message\n", "text/csv")}, timeout=30)
        assert r.status_code in (401, 403), r.text

    def test_invalid_token_returns_403(self):
        r = requests.post(
            f"{API}/files",
            headers={"X-Gateway-Token": "invalid_xxx"},
            files={"file": ("x.csv", b"Mobile,Message\n", "text/csv")},
            timeout=30,
        )
        assert r.status_code == 403


# ---- /api/files upload for all three formats ----------------------------- #
class TestUploadFormats:
    def test_upload_xlsx(self, h, xlsx_bytes):
        r = requests.post(
            f"{API}/files",
            headers=h,
            files={"file": ("data.xlsx", xlsx_bytes,
                            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
            timeout=60,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert "file_id" in body and isinstance(body["file_id"], str) and len(body["file_id"]) > 0
        assert body["filename"] == "data.xlsx"
        assert body["sheets"] == ["Sheet1"]

    def test_upload_xls(self, h, xls_bytes):
        r = requests.post(
            f"{API}/files",
            headers=h,
            files={"file": ("data.xls", xls_bytes, "application/vnd.ms-excel")},
            timeout=60,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["filename"] == "data.xls"
        assert body["sheets"] == ["Sheet1"]
        assert isinstance(body["file_id"], str) and len(body["file_id"]) > 0

    def test_upload_csv(self, h, csv_bytes):
        r = requests.post(
            f"{API}/files",
            headers=h,
            files={"file": ("data.csv", csv_bytes, "text/csv")},
            timeout=60,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["filename"] == "data.csv"
        # CSV sheet name must be "CSV" per backend contract
        assert body["sheets"] == ["CSV"]

    def test_reject_txt(self, h):
        r = requests.post(
            f"{API}/files",
            headers=h,
            files={"file": ("data.txt", b"hello", "text/plain")},
            timeout=30,
        )
        assert r.status_code == 400
        assert "supported" in r.text.lower() or "xlsx" in r.text.lower()

    def test_reject_pdf(self, h):
        r = requests.post(
            f"{API}/files",
            headers=h,
            files={"file": ("data.pdf", b"%PDF-1.4", "application/pdf")},
            timeout=30,
        )
        assert r.status_code == 400


# ---- CSV full pipeline regression --------------------------------------- #
class TestCsvPipeline:
    def test_full_csv_pipeline(self, h, token, csv_bytes):
        # 1) Upload
        up = requests.post(
            f"{API}/files",
            headers=h,
            files={"file": ("pipe.csv", csv_bytes, "text/csv")},
            timeout=60,
        )
        assert up.status_code == 200, up.text
        file_id = up.json()["file_id"]
        assert up.json()["sheets"] == ["CSV"]

        # 2) Columns
        cols = requests.get(f"{API}/files/{file_id}/columns", headers=h, timeout=30)
        assert cols.status_code == 200
        c = cols.json()
        assert c["sheet"] == "CSV"
        assert "Mobile" in c["columns"] and "Message" in c["columns"]
        assert c["total_rows"] == 3

        # 3) Validate
        val = requests.post(
            f"{API}/files/validate",
            headers=h,
            json={"file_id": file_id, "sheet": "CSV",
                  "mobile_column": "Mobile", "message_column": "Message",
                  "country_code": "+91"},
            timeout=30,
        )
        assert val.status_code == 200
        s = val.json()["summary"]
        assert s["total"] == 3
        assert s["valid"] == 3
        assert s["invalid"] == 0
        assert s["duplicate"] == 0
        assert s["empty"] == 0

        # 4) Create batch
        b = requests.post(
            f"{API}/batches",
            headers=h,
            json={"file_id": file_id, "sheet": "CSV",
                  "mobile_column": "Mobile", "message_column": "Message",
                  "country_code": "+91"},
            timeout=30,
        )
        assert b.status_code == 200
        batch_id = b.json()["batch_id"]
        assert b.json()["total"] == 3

        # 5) Claim next -> report result (once) -> duplicate result ignored
        n = requests.get(f"{API}/batches/{batch_id}/next", headers=h, timeout=30)
        assert n.status_code == 200
        job = n.json()["job"]
        assert job is not None
        msg_id = job["message_id"]

        r1 = requests.post(f"{API}/jobs/{msg_id}/result", headers=h,
                           json={"status": "sent", "simulated": True}, timeout=30)
        assert r1.status_code == 200
        assert r1.json()["status"] == "SENT"

        r2 = requests.post(f"{API}/jobs/{msg_id}/result", headers=h,
                           json={"status": "sent", "simulated": True}, timeout=30)
        assert r2.status_code == 200
        assert r2.json().get("duplicate_ignored") is True

        # 6) Batch counts reflect
        bs = requests.get(f"{API}/batches/{batch_id}", headers=h, timeout=30)
        assert bs.status_code == 200
        counts = bs.json()
        assert counts["total"] == 3
        assert counts["sent"] == 1
        assert counts["pending"] + counts["sending"] == 2

        # 7) Export xlsx
        e = requests.get(f"{API}/batches/{batch_id}/export",
                         params={"token": token}, timeout=30)
        assert e.status_code == 200
        assert "spreadsheet" in e.headers.get("content-type", "")
        assert len(e.content) > 1000


# ---- /api/sample-template -------------------------------------------------- #
class TestSampleTemplate:
    def test_sample_template_downloads_xlsx(self):
        # Public endpoint - no auth required
        r = requests.get(f"{API}/sample-template", timeout=30)
        assert r.status_code == 200, r.text
        ct = r.headers.get("content-type", "")
        assert "spreadsheet" in ct or "openxml" in ct
        cd = r.headers.get("content-disposition", "")
        assert "attachment" in cd.lower()
        assert ".xlsx" in cd.lower()
        assert len(r.content) > 1000
        # parseable by pandas
        df = pd.read_excel(io.BytesIO(r.content), engine="openpyxl")
        assert "Mobile Number" in df.columns
        assert "Message" in df.columns
        assert len(df) >= 1
