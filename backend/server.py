"""
Private Bulk SMS Gateway - Backend

A single-user, private-use SMS gateway backend. NO customer accounts, NO
payments, NO subscriptions. Every mutating request is authenticated with a
private gateway token generated during setup.

The Android phone (running the Expo app) is the actual SMS gateway. This
backend owns:
  - gateway settings + token
  - excel/csv parsing, column detection and row validation
  - the durable SMS job queue (source of truth for status)
  - history + result export
  - audit / request logging
"""

import io
import os
import re
import logging
import secrets
from pathlib import Path
from datetime import datetime, timezone, date
from typing import List, Optional, Annotated, Any

import pandas as pd
from bson import ObjectId
from pymongo import ReturnDocument
from fastapi import FastAPI, APIRouter, UploadFile, File, Form, Depends, Header, HTTPException, Request
from fastapi.responses import StreamingResponse
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, Field, BeforeValidator, ConfigDict

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

mongo_url = os.environ["MONGO_URL"]
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ["DB_NAME"]]

app = FastAPI(title="Private SMS Gateway")
api_router = APIRouter(prefix="/api")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger("sms_gateway")


# --------------------------------------------------------------------------- #
# Mongo helpers
# --------------------------------------------------------------------------- #
def _to_str_id(v: Any) -> Any:
    if isinstance(v, ObjectId):
        return str(v)
    return v


PyObjectId = Annotated[str, BeforeValidator(_to_str_id)]


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: Optional[datetime]) -> Optional[str]:
    if dt is None:
        return None
    if isinstance(dt, str):
        return dt
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat()


# --------------------------------------------------------------------------- #
# Models
# --------------------------------------------------------------------------- #
class GatewaySettings(BaseModel):
    gateway_id: str
    token: str
    sending_delay: int = 3          # seconds between messages
    default_country_code: str = "+91"
    selected_sim: Optional[int] = None
    connected: bool = False
    sim_available: bool = False
    network_connected: bool = False
    last_heartbeat: Optional[str] = None
    created_at: str = Field(default_factory=lambda: iso(now_utc()))


class SettingsUpdate(BaseModel):
    sending_delay: Optional[int] = None
    default_country_code: Optional[str] = None
    selected_sim: Optional[int] = None


class Heartbeat(BaseModel):
    sim_available: bool = False
    network_connected: bool = False


class ValidateRequest(BaseModel):
    file_id: str
    sheet: str
    mobile_column: str
    message_column: str
    country_code: str = "+91"


class CreateBatchRequest(BaseModel):
    file_id: str
    sheet: str
    mobile_column: str
    message_column: str
    country_code: str = "+91"
    selected_rows: Optional[List[int]] = None   # original row numbers; None = all valid


class ControlRequest(BaseModel):
    action: str   # pause | resume | stop


class JobResult(BaseModel):
    status: str            # sent | failed
    error_message: Optional[str] = None
    simulated: bool = False


class TestSmsRequest(BaseModel):
    mobile: str
    message: str


# --------------------------------------------------------------------------- #
# Auth
# --------------------------------------------------------------------------- #
async def require_token(x_gateway_token: str = Header(None)) -> dict:
    settings = await db.gateway_settings.find_one({"_id": "singleton"})
    if not settings or not settings.get("token"):
        raise HTTPException(status_code=401, detail="Gateway not set up")
    if not x_gateway_token or not secrets.compare_digest(x_gateway_token, settings["token"]):
        raise HTTPException(status_code=403, detail="Invalid gateway token")
    return settings


async def audit(action: str, detail: dict, request: Optional[Request] = None):
    entry = {
        "action": action,
        "detail": detail,
        "ip": request.client.host if request and request.client else None,
        "created_at": iso(now_utc()),
    }
    await db.system_logs.insert_one(entry)


# --------------------------------------------------------------------------- #
# Validation logic
# --------------------------------------------------------------------------- #
def normalize_number(raw: Any, country_code: str) -> str:
    if raw is None:
        return ""
    s = str(raw).strip()
    if s.endswith(".0"):        # pandas turns numeric cells into floats
        s = s[:-2]
    s = re.sub(r"[\s\-()]", "", s)
    cc_digits = re.sub(r"\D", "", country_code)
    if s.startswith("+"):
        digits = re.sub(r"\D", "", s)
        return "+" + digits
    if s.startswith("00"):
        return "+" + re.sub(r"\D", "", s[2:])
    digits = re.sub(r"\D", "", s)
    if not digits:
        return ""
    # already contains country code
    if digits.startswith(cc_digits) and len(digits) > 10:
        return "+" + digits
    if len(digits) == 10:
        return "+" + cc_digits + digits
    return "+" + digits


def is_valid_number(normalized: str) -> bool:
    return bool(re.match(r"^\+\d{8,15}$", normalized))


def classify_rows(df: pd.DataFrame, mobile_col: str, message_col: str, country_code: str):
    """Returns (rows, summary). Each row: original row number, raw + normalized
    values, status (valid|invalid|duplicate|empty) and issues list."""
    rows = []
    seen = {}
    summary = {"total": 0, "valid": 0, "invalid": 0, "duplicate": 0, "empty": 0}

    for idx, r in df.iterrows():
        summary["total"] += 1
        raw_mobile = r.get(mobile_col, "")
        raw_message = r.get(message_col, "")
        raw_mobile = "" if pd.isna(raw_mobile) else str(raw_mobile).strip()
        raw_message = "" if pd.isna(raw_message) else str(raw_message).strip()
        message = re.sub(r"[ \t]+", " ", raw_message).strip()
        normalized = normalize_number(raw_mobile, country_code)

        issues = []
        status = "valid"

        if not raw_mobile and not message:
            status = "empty"
            issues.append("Empty row")
        else:
            if not raw_mobile:
                status = "invalid"
                issues.append("Missing mobile number")
            elif not is_valid_number(normalized):
                status = "invalid"
                issues.append("Invalid mobile number")
            if not message:
                status = "invalid" if status != "empty" else status
                issues.append("Empty message")

        if status == "valid":
            if normalized in seen:
                status = "duplicate"
                issues.append(f"Duplicate of row {seen[normalized]}")
            else:
                seen[normalized] = int(idx) + 1

        summary[status] += 1
        rows.append({
            "row": int(idx) + 1,
            "raw_mobile": raw_mobile,
            "mobile": normalized,
            "message": message,
            "status": status,
            "issues": issues,
        })
    return rows, summary


def read_dataframe(content: bytes, filename: str, sheet: Optional[str] = None) -> pd.DataFrame:
    name = filename.lower()
    if name.endswith(".csv"):
        return pd.read_csv(io.BytesIO(content), dtype=str, keep_default_na=False)
    engine = "xlrd" if name.endswith(".xls") else "openpyxl"
    return pd.read_excel(io.BytesIO(content), sheet_name=sheet, dtype=str,
                         keep_default_na=False, engine=engine)


def read_sheet_names(content: bytes, filename: str) -> List[str]:
    name = filename.lower()
    if name.endswith(".csv"):
        return ["CSV"]
    engine = "xlrd" if name.endswith(".xls") else "openpyxl"
    xls = pd.ExcelFile(io.BytesIO(content), engine=engine)
    return xls.sheet_names


# --------------------------------------------------------------------------- #
# Gateway setup + settings
# --------------------------------------------------------------------------- #
@api_router.get("/")
async def root():
    return {"message": "Private SMS Gateway API"}


@api_router.post("/gateway/setup")
async def gateway_setup(request: Request):
    """Bootstrap for this single private device. Creates settings + token on
    first call and returns the token. Since this is a personal single-user
    gateway (no login by design), a subsequent setup call on the owner's own
    device returns the existing token so the app just works. Token can be
    rotated/revoked from Settings at any time."""
    existing = await db.gateway_settings.find_one({"_id": "singleton"})
    if existing:
        await audit("gateway_setup", {"gateway_id": existing["gateway_id"], "created": False}, request)
        return {
            "gateway_id": existing["gateway_id"],
            "created": False,
            "token": existing["token"],
        }
    token = secrets.token_hex(20)
    settings = GatewaySettings(gateway_id="PHONE-001", token=token)
    doc = settings.model_dump()
    doc["_id"] = "singleton"
    await db.gateway_settings.insert_one(doc)
    await audit("gateway_setup", {"gateway_id": "PHONE-001", "created": True}, request)
    return {"gateway_id": settings.gateway_id, "created": True, "token": token}


@api_router.get("/gateway/settings")
async def get_settings(settings: dict = Depends(require_token)):
    settings.pop("_id", None)
    return settings


@api_router.put("/gateway/settings")
async def update_settings(body: SettingsUpdate, settings: dict = Depends(require_token)):
    update = {k: v for k, v in body.model_dump().items() if v is not None}
    if update:
        await db.gateway_settings.update_one({"_id": "singleton"}, {"$set": update})
    doc = await db.gateway_settings.find_one({"_id": "singleton"})
    doc.pop("_id", None)
    return doc


@api_router.post("/gateway/token/regenerate")
async def regenerate_token(request: Request, settings: dict = Depends(require_token)):
    token = secrets.token_hex(20)
    await db.gateway_settings.update_one({"_id": "singleton"}, {"$set": {"token": token}})
    await audit("token_regenerate", {}, request)
    return {"token": token}


@api_router.post("/gateway/token/revoke")
async def revoke_token(request: Request, settings: dict = Depends(require_token)):
    token = secrets.token_hex(20)
    await db.gateway_settings.update_one(
        {"_id": "singleton"}, {"$set": {"token": token, "connected": False}}
    )
    await audit("token_revoke", {}, request)
    return {"token": token}


@api_router.post("/gateway/heartbeat")
async def heartbeat(body: Heartbeat, settings: dict = Depends(require_token)):
    await db.gateway_settings.update_one(
        {"_id": "singleton"},
        {"$set": {
            "connected": True,
            "sim_available": body.sim_available,
            "network_connected": body.network_connected,
            "last_heartbeat": iso(now_utc()),
        }},
    )
    return {"ok": True}


# --------------------------------------------------------------------------- #
# File upload + parsing
# --------------------------------------------------------------------------- #
@api_router.post("/files")
async def upload_file(request: Request, file: UploadFile = File(...),
                      settings: dict = Depends(require_token)):
    name = file.filename or "upload"
    if not name.lower().endswith((".xlsx", ".xls", ".csv")):
        raise HTTPException(status_code=400, detail="Only .xlsx, .xls, .csv files are supported")
    content = await file.read()
    if len(content) > 15 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="File too large (max 15MB)")
    try:
        sheets = read_sheet_names(content, name)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not read file: {e}")

    doc = {
        "filename": name,
        "content": content,
        "sheets": sheets,
        "created_at": iso(now_utc()),
    }
    result = await db.uploaded_files.insert_one(doc)
    await audit("file_upload", {"filename": name, "sheets": sheets}, request)
    return {"file_id": str(result.inserted_id), "filename": name, "sheets": sheets}


async def _load_file(file_id: str):
    try:
        doc = await db.uploaded_files.find_one({"_id": ObjectId(file_id)})
    except Exception:
        doc = None
    if not doc:
        raise HTTPException(status_code=404, detail="File not found")
    return doc


@api_router.get("/files/{file_id}/columns")
async def get_columns(file_id: str, sheet: Optional[str] = None,
                      settings: dict = Depends(require_token)):
    doc = await _load_file(file_id)
    sheet_name = None if doc["filename"].lower().endswith(".csv") else (sheet or doc["sheets"][0])
    df = read_dataframe(doc["content"], doc["filename"], sheet_name)
    df = df.fillna("")
    columns = [str(c) for c in df.columns]
    preview = df.head(20).astype(str).to_dict(orient="records")
    return {
        "sheets": doc["sheets"],
        "sheet": sheet_name or "CSV",
        "columns": columns,
        "preview": preview,
        "total_rows": int(len(df)),
    }


@api_router.post("/files/validate")
async def validate_file(body: ValidateRequest, settings: dict = Depends(require_token)):
    doc = await _load_file(body.file_id)
    sheet_name = None if doc["filename"].lower().endswith(".csv") else body.sheet
    df = read_dataframe(doc["content"], doc["filename"], sheet_name)
    df = df.fillna("")
    if body.mobile_column not in df.columns or body.message_column not in df.columns:
        raise HTTPException(status_code=400, detail="Selected columns not found in sheet")
    rows, summary = classify_rows(df, body.mobile_column, body.message_column, body.country_code)
    return {"summary": summary, "rows": rows}


# --------------------------------------------------------------------------- #
# Batches (queue)
# --------------------------------------------------------------------------- #
@api_router.post("/batches")
async def create_batch(body: CreateBatchRequest, request: Request,
                       settings: dict = Depends(require_token)):
    doc = await _load_file(body.file_id)
    sheet_name = None if doc["filename"].lower().endswith(".csv") else body.sheet
    df = read_dataframe(doc["content"], doc["filename"], sheet_name)
    df = df.fillna("")
    rows, summary = classify_rows(df, body.mobile_column, body.message_column, body.country_code)

    selected = set(body.selected_rows) if body.selected_rows else None
    valid_rows = [r for r in rows if r["status"] == "valid" and
                  (selected is None or r["row"] in selected)]
    if not valid_rows:
        raise HTTPException(status_code=400, detail="No valid rows to send")

    batch = {
        "filename": doc["filename"],
        "sheet": body.sheet,
        "control_state": "running",
        "total": len(valid_rows),
        "delay": settings.get("sending_delay", 3),
        "created_at": iso(now_utc()),
    }
    batch_result = await db.batches.insert_one(batch)
    batch_id = str(batch_result.inserted_id)

    jobs = []
    for i, r in enumerate(valid_rows):
        jobs.append({
            "message_id": f"MSG-{batch_id[-6:]}-{r['row']:05d}",
            "batch_id": batch_id,
            "row": r["row"],
            "mobile_number": r["mobile"],
            "message": r["message"],
            "status": "PENDING",
            "error_message": None,
            "simulated": False,
            "is_test": False,
            "created_at": iso(now_utc()),
            "updated_at": iso(now_utc()),
        })
    await db.sms_jobs.insert_many(jobs)
    await audit("batch_create", {"batch_id": batch_id, "total": len(jobs)}, request)
    return {"batch_id": batch_id, "total": len(jobs), "delay": batch["delay"]}


async def _batch_counts(batch_id: str) -> dict:
    counts = {"PENDING": 0, "SENDING": 0, "SENT": 0, "FAILED": 0}
    cursor = db.sms_jobs.aggregate([
        {"$match": {"batch_id": batch_id}},
        {"$group": {"_id": "$status", "n": {"$sum": 1}}},
    ])
    async for c in cursor:
        counts[c["_id"]] = c["n"]
    total = sum(counts.values())
    return {"total": total, **{k.lower(): v for k, v in counts.items()}}


@api_router.get("/batches/{batch_id}")
async def get_batch(batch_id: str, settings: dict = Depends(require_token)):
    try:
        batch = await db.batches.find_one({"_id": ObjectId(batch_id)})
    except Exception:
        batch = None
    if not batch:
        raise HTTPException(status_code=404, detail="Batch not found")
    counts = await _batch_counts(batch_id)
    return {
        "batch_id": batch_id,
        "control_state": batch["control_state"],
        "delay": batch.get("delay", 3),
        "filename": batch.get("filename"),
        **counts,
    }


@api_router.post("/batches/{batch_id}/control")
async def control_batch(batch_id: str, body: ControlRequest, request: Request,
                        settings: dict = Depends(require_token)):
    if body.action not in ("pause", "resume", "stop"):
        raise HTTPException(status_code=400, detail="Invalid action")
    state = {"pause": "paused", "resume": "running", "stop": "stopped"}[body.action]
    try:
        oid = ObjectId(batch_id)
    except Exception:
        raise HTTPException(status_code=404, detail="Batch not found")
    await db.batches.update_one({"_id": oid}, {"$set": {"control_state": state}})
    # if a message was mid-SENDING when paused/stopped, leave it; requeue on resume
    if state in ("paused", "stopped"):
        await db.sms_jobs.update_many(
            {"batch_id": batch_id, "status": "SENDING"},
            {"$set": {"status": "PENDING", "updated_at": iso(now_utc())}},
        )
    await audit("batch_control", {"batch_id": batch_id, "action": body.action}, request)
    return await get_batch(batch_id, settings)


@api_router.get("/batches/{batch_id}/next")
async def next_job(batch_id: str, settings: dict = Depends(require_token)):
    """Atomically claim the next pending job (marks it SENDING). Returns null
    when the batch is paused/stopped or nothing pending."""
    try:
        batch = await db.batches.find_one({"_id": ObjectId(batch_id)})
    except Exception:
        batch = None
    if not batch:
        raise HTTPException(status_code=404, detail="Batch not found")
    if batch["control_state"] != "running":
        return {"job": None, "control_state": batch["control_state"]}

    job = await db.sms_jobs.find_one_and_update(
        {"batch_id": batch_id, "status": "PENDING"},
        {"$set": {"status": "SENDING", "updated_at": iso(now_utc())}},
        sort=[("row", 1)],
    )
    if not job:
        return {"job": None, "control_state": "running"}
    job.pop("_id", None)
    return {"job": job, "control_state": "running", "delay": batch.get("delay", 3)}


@api_router.post("/jobs/{message_id}/result")
async def report_result(message_id: str, body: JobResult, request: Request,
                        settings: dict = Depends(require_token)):
    if body.status not in ("sent", "failed"):
        raise HTTPException(status_code=400, detail="Invalid status")
    new_status = body.status.upper()
    # Idempotent: only a job currently SENDING can transition; avoids duplicates.
    result = await db.sms_jobs.find_one_and_update(
        {"message_id": message_id, "status": "SENDING"},
        {"$set": {
            "status": new_status,
            "error_message": body.error_message,
            "simulated": body.simulated,
            "sent_at": iso(now_utc()) if new_status == "SENT" else None,
            "updated_at": iso(now_utc()),
        }},
        return_document=ReturnDocument.AFTER,
    )

    if not result:
        current = await db.sms_jobs.find_one({"message_id": message_id})
        if not current:
            raise HTTPException(status_code=404, detail="Job not found")
        current.pop("_id", None)
        return {"message_id": message_id, "status": current["status"],
                "duplicate_ignored": True}
    await audit("job_result", {"message_id": message_id, "status": new_status,
                               "simulated": body.simulated}, request)
    return {"message_id": message_id, "status": new_status,
            "mobile_number": result["mobile_number"], "timestamp": iso(now_utc())}


# --------------------------------------------------------------------------- #
# Test SMS  (goes through the same queue/gateway path)
# --------------------------------------------------------------------------- #
@api_router.post("/sms/test")
async def create_test_sms(body: TestSmsRequest, request: Request,
                          settings: dict = Depends(require_token)):
    normalized = normalize_number(body.mobile, settings.get("default_country_code", "+91"))
    if not is_valid_number(normalized):
        raise HTTPException(status_code=400, detail="Invalid mobile number")
    if not body.message.strip():
        raise HTTPException(status_code=400, detail="Message is empty")
    message_id = f"TEST-{secrets.token_hex(4)}"
    job = {
        "message_id": message_id,
        "batch_id": "TEST",
        "row": 0,
        "mobile_number": normalized,
        "message": body.message.strip(),
        "status": "SENDING",           # claimed immediately, ready for native send
        "error_message": None,
        "simulated": False,
        "is_test": True,
        "created_at": iso(now_utc()),
        "updated_at": iso(now_utc()),
    }
    await db.sms_jobs.insert_one(job)
    await audit("test_sms", {"message_id": message_id, "mobile": normalized}, request)
    job.pop("_id", None)
    return {"job": job}


# --------------------------------------------------------------------------- #
# History
# --------------------------------------------------------------------------- #
@api_router.get("/history")
async def get_history(status: str = "all", search: str = "", limit: int = 200,
                      settings: dict = Depends(require_token)):
    query: dict = {}
    if status and status.lower() != "all":
        query["status"] = status.upper()
    if search:
        query["$or"] = [
            {"mobile_number": {"$regex": re.escape(search), "$options": "i"}},
            {"message_id": {"$regex": re.escape(search), "$options": "i"}},
            {"message": {"$regex": re.escape(search), "$options": "i"}},
        ]
    cursor = db.sms_jobs.find(query).sort("updated_at", -1).limit(min(limit, 1000))
    items = []
    async for j in cursor:
        j.pop("_id", None)
        items.append(j)
    return {"items": items}


# --------------------------------------------------------------------------- #
# Dashboard
# --------------------------------------------------------------------------- #
@api_router.get("/dashboard")
async def dashboard(settings: dict = Depends(require_token)):
    today = date.today().isoformat()
    pipeline = [
        {"$match": {"created_at": {"$gte": today}}},
        {"$group": {"_id": "$status", "n": {"$sum": 1}}},
    ]
    counts = {"SENT": 0, "FAILED": 0, "PENDING": 0, "SENDING": 0}
    async for c in db.sms_jobs.aggregate(pipeline):
        counts[c["_id"]] = c["n"]

    last = await db.sms_jobs.find_one(sort=[("updated_at", -1)])
    last_activity = None
    if last:
        last_activity = {
            "mobile_number": last["mobile_number"],
            "status": last["status"],
            "timestamp": last.get("updated_at"),
        }

    # heartbeat freshness (connected only if heartbeat within 30s)
    connected = False
    hb = settings.get("last_heartbeat")
    if hb and settings.get("connected"):
        try:
            delta = (now_utc() - datetime.fromisoformat(hb)).total_seconds()
            connected = delta < 30
        except Exception:
            connected = False

    return {
        "gateway_id": settings.get("gateway_id"),
        "connected": connected,
        "sim_available": settings.get("sim_available", False),
        "network_connected": settings.get("network_connected", False),
        "today_total": sum(counts.values()),
        "today_sent": counts["SENT"],
        "today_failed": counts["FAILED"],
        "today_pending": counts["PENDING"] + counts["SENDING"],
        "last_activity": last_activity,
    }


# --------------------------------------------------------------------------- #
# Sample template (public helper) + Export results
# --------------------------------------------------------------------------- #
@api_router.get("/sample-template")
async def sample_template():
    """Downloads a ready-to-use sample xlsx with the expected columns."""
    df = pd.DataFrame([
        {"Mobile Number": "9876543210", "Message": "Dear consumer, aapka bill due hai. Kripya samay par jama karein."},
        {"Mobile Number": "9123456789", "Message": "Namaste, aapka electricity bill taiyar hai."},
        {"Mobile Number": "9988776655", "Message": "Reminder: kripya apna pending bill jama karein. Dhanyavaad."},
        {"Mobile Number": "+919000000001", "Message": "Aapka payment mil gaya hai. Shukriya!"},
    ])
    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as writer:
        df.to_excel(writer, index=False, sheet_name="SMS")
    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": 'attachment; filename="sms_sample_template.xlsx"'},
    )


@api_router.get("/batches/{batch_id}/export")
async def export_results(batch_id: str, token: str = ""):
    """Downloads an xlsx of results. Token passed as query param so a plain
    download URL works on device (never the original file is modified)."""
    settings = await db.gateway_settings.find_one({"_id": "singleton"})
    if not settings or not token or not secrets.compare_digest(token, settings.get("token", "")):
        raise HTTPException(status_code=403, detail="Invalid gateway token")

    cursor = db.sms_jobs.find({"batch_id": batch_id}).sort("row", 1)
    data = []
    async for j in cursor:
        data.append({
            "Original Row": j.get("row"),
            "Mobile Number": j.get("mobile_number"),
            "Message": j.get("message"),
            "Status": j.get("status"),
            "Message ID": j.get("message_id"),
            "Sent Time": j.get("sent_at") or "",
            "Error": j.get("error_message") or "",
        })
    if not data:
        raise HTTPException(status_code=404, detail="No results for this batch")

    df = pd.DataFrame(data)
    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as writer:
        df.to_excel(writer, index=False, sheet_name="Results")
    buf.seek(0)
    filename = f"sms_results_{batch_id[-6:]}.xlsx"
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
