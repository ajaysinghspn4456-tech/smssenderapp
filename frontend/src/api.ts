// Thin API client for the private SMS gateway backend.
// The gateway token lives in SecureStore (never in source) and is attached to
// every request as the X-Gateway-Token header.

import * as FileSystem from "expo-file-system/legacy";
import { Platform } from "react-native";

import { storage } from "@/src/utils/storage";

const BASE = `${process.env.EXPO_PUBLIC_BACKEND_URL}/api`;
export const TOKEN_KEY = "gateway_token";

export async function getStoredToken(): Promise<string> {
  return (await storage.secureGet(TOKEN_KEY, "")) ?? "";
}

async function request<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const token = await getStoredToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(opts.headers as Record<string, string> | undefined),
  };
  if (token) headers["X-Gateway-Token"] = token;
  const res = await fetch(`${BASE}${path}`, { ...opts, headers });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const detail = body?.detail || body || `Request failed (${res.status})`;
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return body as T;
}

// ---- Gateway setup / settings -------------------------------------------- //
export async function setupGateway() {
  return request<{ gateway_id: string; created: boolean; token: string | null }>(
    "/gateway/setup",
    { method: "POST" },
  );
}

export type Settings = {
  gateway_id: string;
  token: string;
  sending_delay: number;
  default_country_code: string;
  selected_sim: number | null;
  connected: boolean;
  sim_available: boolean;
  network_connected: boolean;
  last_heartbeat: string | null;
};

export const getSettings = () => request<Settings>("/gateway/settings");

export const updateSettings = (body: Partial<Pick<Settings, "sending_delay" | "default_country_code" | "selected_sim">>) =>
  request<Settings>("/gateway/settings", { method: "PUT", body: JSON.stringify(body) });

export const regenerateToken = () =>
  request<{ token: string }>("/gateway/token/regenerate", { method: "POST" });

export const revokeToken = () =>
  request<{ token: string }>("/gateway/token/revoke", { method: "POST" });

export const heartbeat = (sim_available: boolean, network_connected: boolean, sms_permission: boolean) =>
  request<{ ok: boolean }>("/gateway/heartbeat", {
    method: "POST",
    body: JSON.stringify({ sim_available, network_connected, sms_permission }),
  });

// ---- Files ---------------------------------------------------------------- //
export type UploadResult = { file_id: string; filename: string; sheets: string[] };

export async function uploadFile(asset: { uri: string; name: string; mimeType?: string; file?: any }) {
  const token = await getStoredToken();

  // Web: use a real Blob/File (Expo's fetch requires standards-compliant parts).
  if (Platform.OS === "web") {
    const form = new FormData();
    if (asset.file) {
      form.append("file", asset.file, asset.name);
    } else {
      const blob = await (await fetch(asset.uri)).blob();
      form.append("file", blob, asset.name);
    }
    const res = await fetch(`${BASE}/files`, {
      method: "POST",
      headers: { "X-Gateway-Token": token },
      body: form,
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.detail || "Upload failed");
    return body as UploadResult;
  }

  // Native: FileSystem.uploadAsync streams the file as multipart and avoids the
  // "Unsupported FormDataPart implementation" error from the native fetch.
  let uploadUri = asset.uri;
  try {
    // ensure the multipart filename keeps the real extension the backend checks
    const dest = `${FileSystem.cacheDirectory}${Date.now()}_${asset.name}`;
    await FileSystem.copyAsync({ from: asset.uri, to: dest });
    uploadUri = dest;
  } catch {
    uploadUri = asset.uri;
  }
  const result = await FileSystem.uploadAsync(`${BASE}/files`, uploadUri, {
    httpMethod: "POST",
    uploadType: FileSystem.FileSystemUploadType.MULTIPART,
    fieldName: "file",
    mimeType: asset.mimeType,
    headers: { "X-Gateway-Token": token },
  });
  let parsed: any = null;
  try {
    parsed = result.body ? JSON.parse(result.body) : null;
  } catch {
    parsed = null;
  }
  if (result.status < 200 || result.status >= 300) {
    throw new Error(parsed?.detail || `Upload failed (${result.status})`);
  }
  return parsed as UploadResult;
}

export type ColumnsResult = {
  sheets: string[];
  sheet: string;
  columns: string[];
  preview: Record<string, string>[];
  total_rows: number;
};

export const getColumns = (fileId: string, sheet?: string) =>
  request<ColumnsResult>(`/files/${fileId}/columns${sheet ? `?sheet=${encodeURIComponent(sheet)}` : ""}`);

export type ValidationRow = {
  row: number;
  raw_mobile: string;
  mobile: string;
  message: string;
  status: "valid" | "invalid" | "duplicate" | "empty";
  issues: string[];
};
export type ValidationResult = {
  summary: { total: number; valid: number; invalid: number; duplicate: number; empty: number };
  rows: ValidationRow[];
};

export const validateFile = (body: {
  file_id: string;
  sheet: string;
  mobile_column: string;
  message_column: string;
  country_code: string;
}) => request<ValidationResult>("/files/validate", { method: "POST", body: JSON.stringify(body) });

// ---- Batches / queue ------------------------------------------------------ //
export const createBatch = (body: {
  file_id: string;
  sheet: string;
  mobile_column: string;
  message_column: string;
  country_code: string;
  selected_rows?: number[];
}) => request<{ batch_id: string; total: number; delay: number }>("/batches", {
  method: "POST",
  body: JSON.stringify(body),
});

export type CurrentActivity = {
  job_id: string;
  message_id: string;
  mobile_number: string;
  status: string;
  attempts: number;
} | null;

export type BatchStatus = {
  batch_id: string;
  control_state: "running" | "paused" | "stopped";
  delay: number;
  filename?: string;
  current_activity: CurrentActivity;
  total: number;
  queued: number;
  sending: number;
  sent: number;
  failed: number;
  retrying: number;
  pending: number;
};

export const getBatch = (id: string) => request<BatchStatus>(`/batches/${id}`);

export const controlBatch = (id: string, action: "pause" | "resume" | "stop") =>
  request<BatchStatus>(`/batches/${id}/control`, { method: "POST", body: JSON.stringify({ action }) });

export type Job = {
  message_id: string;
  batch_id: string;
  row: number;
  mobile_number: string;
  message: string;
  status: string;
  is_test?: boolean;
};

export const nextJob = (id: string) =>
  request<{ job: Job | null; control_state: string; delay?: number }>(`/batches/${id}/next`);

export const reportResult = (messageId: string, body: { status: "sent" | "failed"; error_message?: string; simulated?: boolean }) =>
  request<any>(`/jobs/${messageId}/result`, { method: "POST", body: JSON.stringify(body) });

export const createTestSms = (mobile: string, message: string) =>
  request<{ job: Job }>("/sms/test", { method: "POST", body: JSON.stringify({ mobile, message }) });

// ---- History / dashboard -------------------------------------------------- //
export type HistoryItem = {
  message_id: string;
  job_id?: string;
  mobile_number: string;
  message: string;
  status: string;
  error_message: string | null;
  updated_at: string;
  sent_at?: string | null;
  simulated?: boolean;
  attempts?: number;
};

export const getHistory = (status: string, search: string) =>
  request<{ items: HistoryItem[] }>(
    `/history?status=${encodeURIComponent(status)}&search=${encodeURIComponent(search)}`,
  );

export type Dashboard = {
  gateway_id: string;
  connected: boolean;
  sim_available: boolean;
  network_connected: boolean;
  sms_permission: boolean;
  gateway_state: "READY" | "BUSY" | "ERROR" | "DISCONNECTED";
  current_job: { job_id: string; mobile_number: string; status: string } | null;
  today_total: number;
  today_sent: number;
  today_failed: number;
  today_pending: number;
  last_activity: { job_id?: string; mobile_number: string; status: string; timestamp: string } | null;
};

export const getDashboard = () => request<Dashboard>("/dashboard");

export async function exportUrl(batchId: string): Promise<string> {
  const token = await getStoredToken();
  return `${BASE}/batches/${batchId}/export?token=${encodeURIComponent(token)}`;
}
