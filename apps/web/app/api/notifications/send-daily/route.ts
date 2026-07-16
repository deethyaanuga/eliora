import { checkInNotification } from "@eliora/shared";
import { getAllSubscriptions, markSent } from "@/lib/notifications";

// Cron endpoint: send the daily check-in push to every device that is due right
// now. Meant to be hit frequently (e.g. every 15 min) by a scheduler; it figures
// out who is due from each subscription's local time, so learners get their
// notification at their own chosen hour regardless of when the cron fires.
//
// A device is "due" when, in ITS timezone: reminders are enabled, the current
// time is within CATCH_UP_MIN minutes at/after its check-in time, and it hasn't
// already been sent today. Sending is idempotent per local day via lastSentDate.
//
// Protected by CRON_SECRET: send it as `Authorization: Bearer <secret>` (which
// is exactly what Vercel Cron does when CRON_SECRET is set). If CRON_SECRET is
// unset, the endpoint runs unguarded — fine for local dev only.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// How long after the target time we'll still send, so a device is covered even
// if the cron interval doesn't land exactly on its minute. Keep this >= the
// cron interval to avoid missed days.
const CATCH_UP_MIN = 20;

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

// Current local wall-clock (date + minutes-since-midnight) in an IANA timezone.
function localNow(timezone: string): { date: string; minutes: number } | null {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date());
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const hour = parseInt(get("hour"), 10) % 24; // "24" → 0 at midnight
    const minute = parseInt(get("minute"), 10);
    return {
      date: `${get("year")}-${get("month")}-${get("day")}`,
      minutes: hour * 60 + minute,
    };
  } catch {
    return null; // bad/unknown timezone — skip this subscription
  }
}

function unauthorized() {
  return Response.json({ error: "Unauthorized." }, { status: 401 });
}

async function handle(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) return unauthorized();
  }

  const subs = await getAllSubscriptions();
  const due = subs.filter((s) => {
    if (!s.enabled) return false;
    const now = localNow(s.timezone);
    if (!now) return false;
    if (s.lastSentDate === now.date) return false; // already sent today
    const [h, m] = s.time.split(":").map((n) => parseInt(n, 10));
    const target = h * 60 + m;
    const delta = now.minutes - target;
    return delta >= 0 && delta <= CATCH_UP_MIN;
  });

  if (!due.length) {
    return Response.json({ ok: true, checked: subs.length, sent: 0 });
  }

  // Expo accepts a batch of up to 100 messages per request.
  const messages = due.map((s) => {
    const day = localNow(s.timezone)?.date ?? "";
    const { title, body } = checkInNotification({ name: s.name, dayKey: day });
    return {
      to: s.token,
      title,
      body,
      sound: "default",
      // Opens the app straight into the daily check-in chat.
      data: { type: "daily-check-in" },
      channelId: "daily-check-in",
    };
  });

  const sentTokens: string[] = [];
  try {
    for (let i = 0; i < messages.length; i += 100) {
      const batch = messages.slice(i, i + 100);
      const res = await fetch(EXPO_PUSH_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(batch),
      });
      if (res.ok) {
        for (const msg of batch) sentTokens.push(msg.to);
      }
    }
  } catch {
    // Network hiccup — leave lastSentDate untouched so the next cron retries.
  }

  // Mark each sent device against its own local date (timezones may differ).
  const byDate = new Map<string, string[]>();
  for (const s of due) {
    if (!sentTokens.includes(s.token)) continue;
    const date = localNow(s.timezone)?.date ?? "";
    const list = byDate.get(date) ?? [];
    list.push(s.token);
    byDate.set(date, list);
  }
  for (const [date, tokens] of byDate) await markSent(tokens, date);

  return Response.json({
    ok: true,
    checked: subs.length,
    sent: sentTokens.length,
  });
}

// Support both GET (simple schedulers / Vercel Cron) and POST (manual trigger).
export async function GET(req: Request) {
  return handle(req);
}
export async function POST(req: Request) {
  return handle(req);
}
