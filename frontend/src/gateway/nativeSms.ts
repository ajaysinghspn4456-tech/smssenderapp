// Native SMS bridge. Real SMS sending uses Android's SmsManager via
// `expo-android-sms-sender`, which ONLY exists in a real Android build
// (not Expo Go / web preview). When the native module is unavailable we run
// in DEMO_MODE so the full queue flow stays testable, and the UI clearly
// flags that sends are simulated.

import { Platform, PermissionsAndroid } from "react-native";

let mod: any = null;
try {
  // require (not import) so a missing native module fails gracefully at runtime
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  mod = require("expo-android-sms-sender");
} catch {
  mod = null;
}

export function isNativeSmsAvailable(): boolean {
  return Platform.OS === "android" && !!mod && typeof mod.sendSms === "function";
}

export const DEMO_MODE = !isNativeSmsAvailable();

export type PermissionState = "granted" | "denied" | "blocked" | "unavailable";

export async function requestSmsPermission(): Promise<PermissionState> {
  if (Platform.OS !== "android") return "unavailable";
  try {
    const res = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.SEND_SMS,
      {
        title: "SMS permission",
        message: "This private gateway needs permission to send SMS through your SIM.",
        buttonPositive: "Allow",
        buttonNegative: "Deny",
      },
    );
    if (res === PermissionsAndroid.RESULTS.GRANTED) return "granted";
    if (res === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) return "blocked";
    return "denied";
  } catch {
    return "denied";
  }
}

export async function requestPhoneStatePermission(): Promise<PermissionState> {
  if (Platform.OS !== "android") return "unavailable";
  try {
    const res = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.READ_PHONE_STATE,
    );
    if (res === PermissionsAndroid.RESULTS.GRANTED) return "granted";
    if (res === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) return "blocked";
    return "denied";
  } catch {
    return "denied";
  }
}

export async function checkSmsPermission(): Promise<boolean> {
  if (Platform.OS !== "android") return DEMO_MODE; // web/demo: treat as granted for the flow
  try {
    return await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.SEND_SMS);
  } catch {
    return false;
  }
}

export type SimCard = { id: number; displayName: string; carrierName: string; slotIndex?: number };

export async function getSimCards(): Promise<SimCard[]> {
  if (!isNativeSmsAvailable() || typeof mod.getSimCards !== "function") return [];
  try {
    return (await mod.getSimCards()) as SimCard[];
  } catch {
    return [];
  }
}

// Sends one SMS. Resolves only when SmsManager accepts the message; throws on
// failure. In DEMO_MODE it simulates a short delivery so the flow is testable.
export async function sendOneSms(
  number: string,
  message: string,
  simId?: number | null,
): Promise<{ simulated: boolean }> {
  if (DEMO_MODE) {
    await new Promise((r) => setTimeout(r, 250));
    return { simulated: true };
  }
  await mod.sendSms(number, message, simId ?? undefined);
  return { simulated: false };
}
