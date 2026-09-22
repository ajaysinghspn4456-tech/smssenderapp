# Private SMS Gateway — PRD

## Original problem statement
A private, single-user bulk SMS gateway. Upload an Excel/CSV of mobile numbers and
per-row messages, preview & validate, then send each row's message via the user's
own Android SIM (the phone is the gateway). NO customer registration, NO login, NO
payments/subscriptions/wallets, NO multi-user. No third-party SMS provider (Twilio,
MSG91, etc.).

## User choices (confirmed)
- Single Expo app that is both the dashboard and the gateway.
- Real SMS via Android native SmsManager (`expo-android-sms-sender`) — works only in
  a real Android build; web/Expo Go runs in DEMO_MODE (simulated sends).
- Gateway-token-only auth (no login).
- Default country code +91, default delay 3s.
- Clean utility light theme, Hindi-friendly labels.

## Architecture
- Backend: FastAPI + MongoDB. Owns gateway settings/token, file parsing (pandas +
  openpyxl/xlrd), row validation, durable SMS job queue (source of truth), history,
  xlsx export, audit logs. Auth via `X-Gateway-Token` header on all mutating routes.
- Frontend: Expo Router app. Tabs: Dashboard, Upload, History, Settings. Stack:
  Preview, Batch (sending engine), Test SMS (modal).
- Send engine runs on the phone: claims next job (`/next`), sends via native SMS,
  reports result (`/result`), waits the configured delay, respects pause/resume/stop.
  Jobs are only marked SENT after the send call succeeds (never on request-sent).

## Collections
gateway_settings (singleton), sms_jobs (queue + history), batches, uploaded_files,
system_logs (audit).

## Implemented (2026-09-22)
- Gateway setup/bootstrap + token; regenerate/revoke; heartbeat (connection/SIM/network).
- Excel/CSV upload; sheet selection; auto column detection + manual mapping; 20-row preview.
- Full validation: number normalization (+cc), invalid/empty/duplicate detection, summary,
  view-problem-rows. No silent data deletion.
- Message preview with per-row select; Send All / Send Selected; confirmation sheet.
- Durable queue with atomic claim, idempotent result reporting (duplicate protection),
  pause/resume/stop (requeues in-flight), progress bar + live counts.
- Test SMS through the same gateway path.
- History with All/Sent/Failed/Pending filters + search.
- Export results to a separate xlsx (original file never modified).
- Settings: delay stepper, country code, SIM selection (native), token copy/reveal/rotate.
- DEMO_MODE banner + simulated sends for web/Expo Go testing.
- Verified: backend 24/24 automated tests pass; all screens render.

## Known limitations
- Real programmatic SMS requires a native Android build (not Expo Go / web preview).
- Sending is foreground-only (no OS background SMS); pending jobs persist safely if the
  app closes. Subject to SIM/carrier/Android rate limits — the app does not bypass them.
- iOS cannot send SMS programmatically (Android-only feature).

## Backlog / next
- P1: SIM slot picker polish on multi-SIM devices; per-batch history grouping view.
- P1: retry-failed action for FAILED jobs.
- P2: TZ-safe dashboard date comparison; migrate deprecated shadow* props to boxShadow.
