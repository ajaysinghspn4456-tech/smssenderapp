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
  const delayMs = Math.max(0, (settings?.sending_delay ?? 2)) * 1000;

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
        const r = await sendOneSms(job.mobile_number, job.message, simId);
        results.push({ message_id: job.message_id, status: "sent", simulated: r.simulated });
      } catch (e: any) {
        results.push({ message_id: job.message_id, status: "failed", error_message: String(e?.message || e) });
      }
      if (delayMs) await sleep(delayMs);
    }
    try {
      await reportResultsBulk(results);
    } catch {
      // backend self-heals SENDING jobs into retries if we fail to report
    }
    try {
      const b = await getBatch(batchId);
      onProgress?.(b.sent + b.failed, b.total);
    } catch {
      /* ignore */
    }
  }
}

// The function the foreground service runs. It must keep awaiting while active.
async function foregroundTask(args?: { batchId?: string }) {
  const batchId = args?.batchId;
  if (!batchId) return;
  await processBatch(
    batchId,
    () => BackgroundService.isRunning(),
    async (sent, total) => {
      try {
        await BackgroundService.updateNotification({ taskDesc: `${sent} / ${total} sent` });
      } catch {
        /* ignore */
      }
    },
  );
  // finished on its own
  try {
    await BackgroundService.stop();
  } catch {
    /* ignore */
  }
}

export async function startSending(batchId: string, onProgress?: (sent: number, total: number) => void) {
  if (hasForegroundService && !DEMO_MODE) {
    if (BackgroundService.isRunning()) return;
    await BackgroundService.start(foregroundTask, {
      taskName: "uppcl-sms",
      taskTitle: "UPPCL Suchna Seva – Sending SMS",
      taskDesc: "Starting…",
      taskIcon: { name: "ic_launcher", type: "mipmap" },
      color: "#1F2937",
      parameters: { batchId },
      linkingURI: "frontend://",
    });
    return;
  }
  // Fallback: in-process loop kept awake (web / Expo Go / module missing)
  if (localRunning) return;
  localRunning = true;
  activateKeepAwakeAsync(KA_TAG).catch(() => {});
  await processBatch(batchId, () => localRunning, onProgress);
  localRunning = false;
  deactivateKeepAwake(KA_TAG);
}

export async function stopSending() {
  localRunning = false;
  deactivateKeepAwake(KA_TAG);
  if (hasForegroundService) {
    try {
      if (BackgroundService.isRunning()) await BackgroundService.stop();
    } catch {
      /* ignore */
    }
  }
}

export function isSending(): boolean {
  if (hasForegroundService && BackgroundService.isRunning()) return true;
  return localRunning;
}
