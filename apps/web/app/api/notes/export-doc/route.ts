import { auth } from "@/auth";
import { buildDocRequests, type NoteDocInput } from "@/lib/notesToDoc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Sync one note from the Notes workspace to Google Docs. Rides the existing
// NextAuth Google login (same access token as grade sync): creates a new doc in
// the student's Drive, then batch-applies formatting so headings, bullets, bold,
// and highlighter colors survive the trip. Returns the doc's edit URL so the UI
// can open it. Needs the `documents` scope — added in auth.ts, so students who
// signed in before it was added must sign in with Google again.

const DOCS = "https://docs.googleapis.com/v1/documents";

const str = (v: unknown) => (typeof v === "string" ? v : "");

export async function POST(req: Request) {
  const session = await auth();
  const token = (session as { accessToken?: string } | null)?.accessToken;
  const provider = (session as { authProvider?: string } | null)?.authProvider;

  if (!session) {
    return Response.json({ error: "Please sign in first." }, { status: 401 });
  }
  if (provider !== "google" || !token) {
    return Response.json(
      {
        error:
          "Saving to Google Docs needs a Google sign-in. Sign in with Google " +
          "to connect your account.",
        needsGoogle: true,
      },
      { status: 400 },
    );
  }

  let body: Partial<NoteDocInput>;
  try {
    body = (await req.json()) as Partial<NoteDocInput>;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const note: NoteDocInput = {
    title: str(body.title).trim() || "Untitled note",
    template:
      body.template === "cornell" || body.template === "canvas"
        ? body.template
        : "free",
    body: str(body.body),
    cue: str(body.cue),
    summary: str(body.summary),
  };

  // Canvas / mind-map notes are spatial, not linear text — nothing to export.
  if (
    note.template !== "cornell" &&
    !note.body.trim() &&
    !note.cue?.trim() &&
    !note.summary?.trim()
  ) {
    return Response.json(
      { error: "This note is empty — add some text first." },
      { status: 400 },
    );
  }

  try {
    // 1. Create an empty doc titled after the note.
    const createRes = await fetch(DOCS, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title: note.title }),
    });
    if (!createRes.ok) throw makeErr(createRes.status);
    const doc = (await createRes.json()) as { documentId?: string };
    const docId = doc.documentId;
    if (!docId) throw makeErr(502);

    // 2. Insert the text and layer on the formatting in one batch.
    const { requests } = buildDocRequests(note);
    if (requests.length) {
      const updRes = await fetch(`${DOCS}/${docId}:batchUpdate`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ requests }),
      });
      // The doc already exists; if formatting fails we still hand back the link
      // rather than losing the student's export.
      if (!updRes.ok && (updRes.status === 401 || updRes.status === 403)) {
        throw makeErr(updRes.status);
      }
    }

    return Response.json({
      url: `https://docs.google.com/document/d/${docId}/edit`,
      docId,
    });
  } catch (err) {
    const status = (err as { status?: number })?.status;
    if (status === 401 || status === 403) {
      return Response.json(
        {
          error:
            "Google didn't grant access to Docs. Sign out and back in with " +
            "Google, and approve the Docs permission.",
          needsGoogle: true,
        },
        { status: 400 },
      );
    }
    return Response.json(
      { error: "Couldn't save to Google Docs right now — please try again." },
      { status: 502 },
    );
  }
}

function makeErr(status: number): Error & { status: number } {
  const e = new Error(`Docs ${status}`) as Error & { status: number };
  e.status = status;
  return e;
}
