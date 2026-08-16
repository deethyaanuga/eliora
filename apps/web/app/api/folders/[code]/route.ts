import {
  touchFolder,
  addItem,
  updateItem,
  removeItem,
  renameFolder,
  leaveFolder,
} from "@/lib/folders";
import { isValidFolderCode } from "@eliora/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ code: string }> };

// GET /api/folders/[code]?memberId=..&name=..  — poll + heartbeat.
// Returns the current folder state; 404 if it has expired.
export async function GET(req: Request, { params }: Ctx) {
  const { code } = await params;
  if (!isValidFolderCode(code)) {
    return Response.json({ error: "Bad folder code." }, { status: 400 });
  }
  const url = new URL(req.url);
  const memberId = (url.searchParams.get("memberId") ?? "").trim();
  const name = url.searchParams.get("name") ?? undefined;
  if (!memberId) {
    return Response.json({ error: "Missing member id." }, { status: 400 });
  }
  const folder = await touchFolder(code, memberId, name || undefined);
  if (!folder) {
    return Response.json({ error: "Folder not found." }, { status: 404 });
  }
  return Response.json({ folder }, { headers: { "Cache-Control": "no-store" } });
}

// POST /api/folders/[code] — folder actions.
//   { action: "add",    memberId, name, item: {kind,title,subject?,due?,details?} }
//   { action: "update", memberId, name, itemId, patch: {done?|kind?|title?|...} }
//   { action: "remove", memberId, name, itemId }
//   { action: "rename", memberId, name, folderName }
//   { action: "leave",  memberId }
export async function POST(req: Request, { params }: Ctx) {
  const { code } = await params;
  if (!isValidFolderCode(code)) {
    return Response.json({ error: "Bad folder code." }, { status: 400 });
  }
  let body: {
    action?: string;
    memberId?: string;
    name?: string;
    itemId?: string;
    folderName?: string;
    item?: Record<string, unknown>;
    patch?: Record<string, unknown>;
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
    await leaveFolder(code, memberId);
    return Response.json({ ok: true });
  }

  const notFound = () =>
    Response.json({ error: "Folder not found." }, { status: 404 });

  if (body.action === "add") {
    const folder = await addItem(code, memberId, name, body.item ?? {});
    return folder ? Response.json({ folder }) : notFound();
  }

  if (body.action === "update") {
    const itemId = (body.itemId ?? "").trim();
    if (!itemId) {
      return Response.json({ error: "Missing item id." }, { status: 400 });
    }
    const folder = await updateItem(code, memberId, name, itemId, body.patch ?? {});
    return folder ? Response.json({ folder }) : notFound();
  }

  if (body.action === "remove") {
    const itemId = (body.itemId ?? "").trim();
    if (!itemId) {
      return Response.json({ error: "Missing item id." }, { status: 400 });
    }
    const folder = await removeItem(code, memberId, name, itemId);
    return folder ? Response.json({ folder }) : notFound();
  }

  if (body.action === "rename") {
    const folder = await renameFolder(code, memberId, name, body.folderName ?? "");
    return folder ? Response.json({ folder }) : notFound();
  }

  return Response.json({ error: "Unknown action." }, { status: 400 });
}
