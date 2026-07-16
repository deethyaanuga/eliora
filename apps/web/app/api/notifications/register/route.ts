import {
  isExpoPushToken,
  isValidTime,
  saveSubscription,
  removeSubscription,
} from "@/lib/notifications";

// Register (or update) a device for the daily check-in push notification.
// Called by the mobile app on launch and whenever the learner changes their
// check-in time or toggles reminders. No auth: the Expo push token is the
// identity, and a token only ever routes to the device that owns it.
//
//   POST { token, time: "HH:MM", timezone, name?, enabled? }  → upsert
//   DELETE { token }                                          → unregister
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: {
    token?: string;
    time?: string;
    timezone?: string;
    name?: string;
    enabled?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }

  const token = (body.token ?? "").trim();
  if (!isExpoPushToken(token)) {
    return Response.json({ error: "Invalid push token." }, { status: 400 });
  }
  if (!isValidTime(body.time)) {
    return Response.json(
      { error: "Time must be in HH:MM (24-hour) form." },
      { status: 400 },
    );
  }
  const timezone = (body.timezone ?? "").trim();
  if (!timezone) {
    return Response.json({ error: "Missing timezone." }, { status: 400 });
  }

  try {
    await saveSubscription({
      token,
      name: body.name,
      time: body.time!.trim(),
      timezone,
      enabled: body.enabled !== false,
    });
    return Response.json({ ok: true });
  } catch {
    return Response.json(
      { error: "Could not save your reminder — try again." },
      { status: 500 },
    );
  }
}

export async function DELETE(req: Request) {
  let body: { token?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }
  const token = (body.token ?? "").trim();
  if (!isExpoPushToken(token)) {
    return Response.json({ error: "Invalid push token." }, { status: 400 });
  }
  try {
    await removeSubscription(token);
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "Could not unregister." }, { status: 500 });
  }
}
