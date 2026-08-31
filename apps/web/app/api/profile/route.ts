import { auth } from "@/auth";
import { getProfile, saveProfile } from "@/lib/profiles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Remembers the learner's sign-up survey so logging in on a new device doesn't
// restart the questionnaire. The identity comes from the session, never the
// request body, so a user can only ever read or write their own profile.
//
// GET  /api/profile                 -> { profile } (null when never saved)
// POST /api/profile { profile }     -> { ok: true }

export async function GET() {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) {
    return Response.json({ error: "Not signed in" }, { status: 401 });
  }
  return Response.json({ profile: await getProfile(email) });
}

export async function POST(req: Request) {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) {
    return Response.json({ error: "Not signed in" }, { status: 401 });
  }
  let profile: unknown;
  try {
    profile = (await req.json())?.profile;
  } catch {
    profile = null;
  }
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    return Response.json({ error: "Missing profile" }, { status: 400 });
  }
  const ok = await saveProfile(email, profile as Record<string, unknown>);
  if (!ok) {
    return Response.json({ error: "Profile too large" }, { status: 413 });
  }
  return Response.json({ ok: true });
}
