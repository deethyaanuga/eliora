import { auth } from "@/auth";
import { changePassword } from "@/lib/users";

export const runtime = "nodejs";

// Change the signed-in user's password (verifies the current one first).
// Google-only accounts have no password in the local store and get a clear
// message instead.
export async function POST(req: Request) {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) {
    return Response.json({ error: "You need to be signed in." }, { status: 401 });
  }

  let body: { currentPassword?: string; newPassword?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }

  const current = body.currentPassword ?? "";
  const next = body.newPassword ?? "";
  if (!current) {
    return Response.json(
      { error: "Enter your current password." },
      { status: 400 },
    );
  }
  if (next.length < 6) {
    return Response.json(
      { error: "New password must be at least 6 characters." },
      { status: 400 },
    );
  }

  const result = await changePassword(email, current, next);
  if (result === "no_user") {
    return Response.json(
      {
        error:
          "This account signs in with Google, so it has no password to change.",
      },
      { status: 400 },
    );
  }
  if (result === "wrong_password") {
    return Response.json(
      { error: "Your current password is incorrect." },
      { status: 403 },
    );
  }
  return Response.json({ ok: true });
}
