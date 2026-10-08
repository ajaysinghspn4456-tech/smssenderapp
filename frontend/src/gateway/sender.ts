// Centralised SMS sending engine.
//
// On a real Android build it runs inside a FOREGROUND SERVICE (via
// react-native-background-actions) so sending continues when the user leaves
// the screen, minimises the app or locks the phone, with a persistent progress
// notification. When that native module is unavailable (web / Expo Go) it falls
// back to an in-process loop kept alive with expo-keep-awake.
//
// The backend queue is the single source of truth (atomic claim + idempotent
// results), so a successfully sent recipient is never sent twice even across
// restarts.

import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { Platform } from "react-native";

import { getBatch, getSettings, nextBatchJobs, reportResultsBulk } from "@/src/api";
import { DEMO_MODE, requestSmsPermission, sendOneSms } from "@/src/gateway/nativeSms";

const KA_TAG = "sms-batch";
const CLAIM_SIZE = 10;

let BackgroundService: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  BackgroundService = require("react-native-background-actions").default;
} catch {
  BackgroundService = null;
}
export const hasForegroundService = !!BackgroundService;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function safeActivateKeepAwake() {
  if (Platform.OS === "web") return;
  Promise.resolve(activateKeepAwakeAsync(KA_TAG)).catch(() => {});
}

function safeDeactivateKeepAwake() {
  if (Platform.OS === "web") return;
  try {
    Promise.resolve(deactivateKeepAwake(KA_TAG)).catch(() => {});
  } catch {
    // not activated — ignore
  }
}

// A send must never hang the whole job — cap each attempt.
const SEND_TIMEOUT_MS = 30000;
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("Send timed out")), ms)),
  ]);
}

// fallback-loop control
let localRunning = false;

type SendResult = { message_id: string; status: "sent" | "failed"; error_message?: string; simulated?: boolean };

async function processBatch(
  batchId: string,
  isAlive: () => boolean,
  onProgress?: (sent: number, total: number) => void,
) {
  const settings = await getSettings().catch(() => null);
  const simId = settings?.selected_sim ?? undefined;
  const delayMs = Math.max(0, (settings?.sending_delay ?? 1)) * 1000;
  const chunkSize = Math.max(0, settings?.chunk_size ?? 0);
  const chunkPauseMs = Math.max(0, settings?.chunk_pause ?? 0) * 1000;
  let sentSincePause = 0;

  if (!DEMO_MODE) {
    const p = await requestSmsPermission();
    if (p !== "granted") return;
  }

  while (isAlive()) {
    let res;
    try {
      res = await nextBatchJobs(batchId, CLAIM_SIZE);
    } catch {
      await sleep(2000); // transient network issue — never drop the queue
      continue;
    }
    if (res.control_state !== "running") break; // paused / stopped / cancelled
    if (!res.jobs.length) {
      // nothing ready right now (maybe retry backoff) — stop only when truly done
      try {
        const b = await getBatch(batchId);
        onProgress?.(b.sent + b.failed, b.total);
        if (b.pending === 0 && b.sending === 0) break;
      } catch {
        /* ignore */
      }
      await sleep(1500);
      continue;
    }

    const results: SendResult[] = [];
    for (const job of res.jobs) {
      if (!isAlive()) break;
      try {
        const r = await withTimeout(sendOneSms(job.mobile_number, job.message, simId), SEND_TIMEOUT_MS);
        results.push({ message_id: job.message_id, status: "sent", simulated: r.simulated });
      } catch (e: any) {
        results.push({ message_id: job.message_id, status: "failed", error_message: String(e?.message || e) });
      }
      // Auto batch pacing: pause after every `chunkSize` messages so the device/
      // carrier SMS quota window can breathe on big lists (respects OS limits).
      sentSincePause += 1;
      if (chunkSize > 0 && chunkPauseMs > 0 && sentSincePause >= chunkSize) {
        sentSincePause = 0;
        if (results.length) {
          await reportResultsBulk(results).catch(() => {});
          results.length = 0;
        }
        await sleep(chunkPauseMs);
      } else if (delayMs) {
        await sleep(delayMs);
      }
    }
    if (results.length) {
      try {
        await reportResultsBulk(results);
      } catch {
        // backend self-heals SENDING jobs into retries if we fail to report
      }
    }
    try {
      const b = await getBatch(batchId);
      onProgress?.(b.sent + b.failed, b.total);
    } catch {
      /* ignore */
    }
  }
}

// The foreground service runs only as a keep-alive so the OS does not freeze/
// kill the process while minimised or the screen is locked. The ACTUAL sending
// is always driven by the in-process loop in startSending(), so a flaky service
// launch can never leave the job stuck with nothing sending.
async function keepAliveTask() {
  while (localRunning) {
    await sleep(1000);
  }
}

export async function startSending(batchId: string, onProgress?: (sent: number, total: number) => void) {
  if (localRunning) return; // already running
  localRunning = true;

  // best-effort foreground service (Android build only) — never fatal
  if (hasForegroundService && !DEMO_MODE) {
    try {
      if (!BackgroundService.isRunning()) {
        await BackgroundService.start(keepAliveTask, {
          taskName: "uppcl-sms",
          taskTitle: "UPPCL Suchna Seva – Sending SMS",
          taskDesc: "Starting…",
          taskIcon: { name: "ic_launcher", type: "mipmap" },
          color: "#1565C0",
          parameters: { batchId },
          linkingURI: "frontend://",
        });
      }
    } catch {
      // service failed to start — fall back to keep-awake only, sending still runs
    }
  }
  safeActivateKeepAwake();

  try {
    await processBatch(batchId, () => localRunning, async (sent, total) => {
      onProgress?.(sent, total);
      if (hasForegroundService) {
        try {
          await BackgroundService.updateNotification({ taskDesc: `${sent} / ${total} sent` });
        } catch {
          /* ignore */
        }
      }
    });
  } finally {
    localRunning = false;
    safeDeactivateKeepAwake();
    if (hasForegroundService) {
      try {
        if (BackgroundService.isRunning()) await BackgroundService.stop();
      } catch {
        /* ignore */
      }
    }
  }
}

export async function stopSending() {
  localRunning = false;
  safeDeactivateKeepAwake();
  if (hasForegroundService) {
    try {
      if (BackgroundService.isRunning()) await BackgroundService.stop();
    } catch {
      /* ignore */
    }
  }
}

export function isSending(): boolean {
  return localRunning;
}
