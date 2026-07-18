import { createRoom, joinRoom } from "@/lib/rooms";
import { isValidRoomCode } from "@eliora/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Create or join a Study Together room.
//   { action: "create", name, topic?, memberId, memberName }  -> { room }
//   { action: "join",   code, memberId, memberName }          -> { room } | 404
export async function POST(req: Request) {
  let body: {
    action?: string;
    name?: string;
    topic?: string;
    code?: string;
    memberId?: string;
    memberName?: string;
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
  const memberName = body.memberName ?? "Guest";

  if (body.action === "create") {
    const name = (body.name ?? "").trim();
    if (!name) {
      return Response.json({ error: "Give your room a name." }, { status: 400 });
    }
    const room = await createRoom({ name, topic: body.topic, memberId, memberName });
    return Response.json({ room });
  }

  if (body.action === "join") {
    const code = (body.code ?? "").trim().toUpperCase();
    if (!isValidRoomCode(code)) {
      return Response.json({ error: "That code doesn't look right." }, { status: 400 });
    }
    const room = await joinRoom({ code, memberId, memberName });
    if (!room) {
      return Response.json(
        { error: "No room with that code — it may have ended." },
        { status: 404 },
      );
    }
    return Response.json({ room });
  }

  return Response.json({ error: "Unknown action." }, { status: 400 });
}
