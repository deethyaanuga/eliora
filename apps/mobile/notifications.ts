// Daily check-in push notifications.
//
// Mobile has no login, so the device's Expo push token is its identity. On
// launch (and whenever the learner changes their reminder) we register the
// token + preferred local time + timezone with the web server, whose cron then
// pushes a warm nudge each day. Tapping the notification opens the app straight
// into the daily check-in chat (see App.tsx's response listener).
import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";

const API_BASE_URL: string =
  (Constants.expoConfig?.extra?.apiBaseUrl as string) ?? "http://localhost:3000";

export const CHECKIN_ENABLED_KEY = "eliora-checkin-enabled";
export const CHECKIN_TIME_KEY = "eliora-checkin-time"; // "HH:MM" (24h)
export const DEFAULT_CHECKIN_TIME = "09:00";
const CHANNEL_ID = "daily-check-in";

// The hidden kickoff turn that opens the daily check-in conversation once the
// learner taps the notification. Sent as a hidden user message so the chat
// reads as if Eliora started it. Mirrors CHECK_IN_CHAT_PROMPT in @eliora/shared
// (kept inline here — the mobile app doesn't depend on the shared package).
export const CHECK_IN_CHAT_PROMPT =
  "It's our daily check-in. Greet me warmly and briefly, then look at what's " +
  "actually on my plate — my plan's next steps, anything due soon, my nearest " +
  "exam, and topics I've struggled with. Ask me ONE friendly opening question " +
  "to see how I'm doing and what I want to focus on today. Don't dump a to-do " +
  "list or lecture me — keep it short, warm, and easy to reply to.";

// Foreground behavior: still show the banner if a check-in lands while the app
// is open. Set once at module load, before any listeners fire.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

export type CheckInPrefs = { enabled: boolean; time: string };

export async function loadCheckInPrefs(): Promise<CheckInPrefs> {
  const [enabledRaw, timeRaw] = await Promise.all([
    AsyncStorage.getItem(CHECKIN_ENABLED_KEY),
    AsyncStorage.getItem(CHECKIN_TIME_KEY),
  ]);
  return {
    // Default ON so learners get their daily nudge without hunting for a toggle.
    enabled: enabledRaw !== "0",
    time: /^([01]\d|2[0-3]):[0-5]\d$/.test(timeRaw ?? "")
      ? (timeRaw as string)
      : DEFAULT_CHECKIN_TIME,
  };
}

export async function saveCheckInPrefs(prefs: CheckInPrefs): Promise<void> {
  await Promise.all([
    AsyncStorage.setItem(CHECKIN_ENABLED_KEY, prefs.enabled ? "1" : "0"),
    AsyncStorage.setItem(CHECKIN_TIME_KEY, prefs.time),
  ]);
}

// Ask for permission and fetch this device's Expo push token. Returns null on a
// simulator, if permission is denied, or if no EAS project id is configured
// (getExpoPushTokenAsync needs one on a real build).
async function getPushToken(): Promise<string | null> {
  if (!Device.isDevice) return null; // no push on simulators/emulators

  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: "Daily check-in",
      importance: Notifications.AndroidImportance.DEFAULT,
      lightColor: "#2c6b4c",
    });
  }

  const existing = await Notifications.getPermissionsAsync();
  let status = existing.status;
  if (status !== "granted") {
    status = (await Notifications.requestPermissionsAsync()).status;
  }
  if (status !== "granted") return null;

  const projectId =
    (Constants.expoConfig?.extra as { eas?: { projectId?: string } })?.eas
      ?.projectId ?? Constants.easConfig?.projectId;
  try {
    const { data } = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined,
    );
    return data;
  } catch {
    return null; // e.g. missing project id on a bare device build
  }
}

// Register this device's daily check-in with the server (upsert). Call on
// launch and whenever prefs change. `name` is the learner's first name for a
// warm greeting. Silently no-ops if we can't get a push token.
export async function syncCheckInRegistration(
  prefs: CheckInPrefs,
  name?: string,
): Promise<{ ok: boolean; hasToken: boolean }> {
  const token = await getPushToken();
  if (!token) return { ok: false, hasToken: false };

  const timezone =
    Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  try {
    if (!prefs.enabled) {
      // Unregister so the server stops sending, but keep the local pref.
      await fetch(`${API_BASE_URL}/api/notifications/register`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      return { ok: true, hasToken: true };
    }
    const res = await fetch(`${API_BASE_URL}/api/notifications/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token,
        time: prefs.time,
        timezone,
        name: name?.trim() || undefined,
        enabled: true,
      }),
    });
    return { ok: res.ok, hasToken: true };
  } catch {
    return { ok: false, hasToken: true };
  }
}

export { Notifications };
