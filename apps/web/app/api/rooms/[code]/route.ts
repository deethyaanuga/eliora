import {
  touchRoom,
  postMessage,
  updateTimer,
  leaveRoom,
  type TimerAction,
} from "@/lib/rooms";
import {
  isValidRoomCode,
  TOGETHER_BREAK_SEC,
  TOGETHER_FOCUS_SEC,
} from "@eliora/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ code: string }> };

// GET /api/rooms/[code]?memberId=..&name=..  — poll + heartbeat.
// Returns the current room state; 404 if the room has expired.
export async function GET(req: Request, { params }: Ctx) {
  const { code } = await params;
  if (!isValidRoomCode(code)) {
    return Response.json({ error: "Bad room code." }, { status: 400 });
  }
  const url = new URL(req.url);
  const memberId = (url.searchParams.get("memberId") ?? "").trim();
  const name = url.searchParams.get("name") ?? undefined;
  if (!memberId) {
    return Response.json({ error: "Missing member id." }, { status: 400 });
  }
  const room = await touchRoom(code, memberId, name || undefined);
  if (!room) {
    return Response.json({ error: "Room not found." }, { status: 404 });
  }
  return Response.json(
    { room },
    { headers: { "Cache-Control": "no-store" } },
  );
}

// POST /api/rooms/[code] — room actions.
//   { action: "message", memberId, name, text }
//   { action: "timer",   memberId, name, timer: "focus"|"break"|"pause"|"resume"|"reset", durationSec? }
//   { action: "leave",   memberId }
export async function POST(req: Request, { params }: Ctx) {
  const { code } = await params;
  if (!isValidRoomCode(code)) {
    return Response.json({ error: "Bad room code." }, { status: 400 });
  }
  let body: {
    action?: string;
    memberId?: string;
    name?: string;
    text?: string;
    timer?: string;
    durationSec?: number;
  };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }
  const memberId = (body.memberId ?? "").trim();
  if (!memberId) {
    return Response.json({ error: "Missing member id." }, { status: 400 });
  }
  const name = body.name ?? "Guest";

  if (body.action === "leave") {
    await leaveRoom(code, memberId);
    return Response.json({ ok: true });
  }

  if (body.action === "message") {
    const room = await postMessage(code, memberId, name, body.text ?? "");
    if (!room) return Response.json({ error: "Room not found." }, { status: 404 });
    return Response.json({ room });
  }

  if (body.action === "timer") {
    let act: TimerAction;
    switch (body.timer) {
      case "focus":
        act = { kind: "start", mode: "focus", durationSec: body.durationSec ?? TOGETHER_FOCUS_SEC };
        break;
      case "break":
        act = { kind: "start", mode: "break", durationSec: body.durationSec ?? TOGETHER_BREAK_SEC };
        break;
      case "pause":
        act = { kind: "pause" };
        break;
      case "resume":
        act = { kind: "resume" };
        break;
      case "reset":
        act = { kind: "reset" };
        break;
      default:
        return Response.json({ error: "Unknown timer action." }, { status: 400 });
    }
    const room = await updateTimer(code, memberId, name, act);
    if (!room) return Response.json({ error: "Room not found." }, { status: 404 });
    return Response.json({ room });
  }

  return Response.json({ error: "Unknown action." }, { status: 400 });
}
