import { createFolder, joinFolder } from "@/lib/folders";
import { isValidFolderCode } from "@eliora/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Create or join a shared folder.
//   { action: "create", name, memberId, memberName }  -> { folder }
//   { action: "join",   code, memberId, memberName }   -> { folder } | 404
export async function POST(req: Request) {
  let body: {
    action?: string;
    name?: string;
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
      return Response.json({ error: "Give your folder a name." }, { status: 400 });
    }
    const folder = await createFolder({ name, memberId, memberName });
    return Response.json({ folder });
  }

  if (body.action === "join") {
    const code = (body.code ?? "").trim().toUpperCase();
    if (!isValidFolderCode(code)) {
      return Response.json({ error: "That code doesn't look right." }, { status: 400 });
    }
    const folder = await joinFolder({ code, memberId, memberName });
    if (!folder) {
      return Response.json(
        { error: "No folder with that code — check it and try again." },
        { status: 404 },
      );
    }
    return Response.json({ folder });
  }

  return Response.json({ error: "Unknown action." }, { status: 400 });
}
