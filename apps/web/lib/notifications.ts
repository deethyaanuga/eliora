import { promises as fs } from "fs";
import path from "path";
import type { CheckInSubscription } from "@eliora/shared";

// Where daily check-in push subscriptions live. Like the credentials store in
// lib/users.ts, this is a local JSON file matching Eliora's no-database setup —
// NOT production scale; a real deployment should move these to a database.
//
// Mobile has no login, so a subscription is keyed by its Expo push token: the
// token IS the identity. Each record carries the learner's preferred local
// check-in time + IANA timezone so the cron can decide who is due right now.
const FILE = path.join(process.cwd(), ".notif-subs.json");

// Expo push tokens look like "ExponentPushToken[...]" or "ExpoPushToken[...]".
export function isExpoPushToken(token: unknown): token is string {
  return (
    typeof token === "string" &&
    /^Expo(nent)?PushToken\[[^\]]+\]$/.test(token.trim())
  );
}

// "HH:MM" in 24-hour form, 00:00–23:59.
export function isValidTime(time: unknown): time is string {
  return (
    typeof time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(time.trim())
  );
}

async function readAll(): Promise<CheckInSubscription[]> {
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function writeAll(subs: CheckInSubscription[]): Promise<void> {
  await fs.writeFile(FILE, JSON.stringify(subs, null, 2), "utf8");
}

// Create or update a subscription (upsert by token). Preserves lastSentDate so
// re-registering (e.g. on every app launch) never re-triggers today's send.
export async function saveSubscription(sub: {
  token: string;
  name?: string;
  time: string;
  timezone: string;
  enabled: boolean;
}): Promise<void> {
  const subs = await readAll();
  const existing = subs.find((s) => s.token === sub.token);
  if (existing) {
    existing.name = sub.name?.trim() || undefined;
    existing.time = sub.time;
    existing.timezone = sub.timezone;
    existing.enabled = sub.enabled;
  } else {
    subs.push({
      token: sub.token,
      name: sub.name?.trim() || undefined,
      time: sub.time,
      timezone: sub.timezone,
      enabled: sub.enabled,
    });
  }
  await writeAll(subs);
}

export async function removeSubscription(token: string): Promise<void> {
  const subs = await readAll();
  await writeAll(subs.filter((s) => s.token !== token));
}

export async function getAllSubscriptions(): Promise<CheckInSubscription[]> {
  return readAll();
}

// Record that a subscription was sent on a given local date so the cron won't
// double-send if it runs again the same day.
export async function markSent(
  tokens: string[],
  localDate: string,
): Promise<void> {
  if (!tokens.length) return;
  const subs = await readAll();
  const set = new Set(tokens);
  for (const s of subs) if (set.has(s.token)) s.lastSentDate = localDate;
  await writeAll(subs);
}
