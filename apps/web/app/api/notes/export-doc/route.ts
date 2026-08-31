import { auth } from "@/auth";
import {
  buildCreateRequests,
  buildUpdateRequests,
  type DocsDocument,
  type NoteDocInput,
} from "@/lib/notesToDoc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Sync one note from the Notes workspace to Google Docs. Rides the existing
// NextAuth Google login (same access token as grade sync), then batch-applies
// formatting so headings, bullets, bold, and highlighter colors survive the
// trip. Needs the `documents` scope — added in auth.ts, so students who signed
// in before it was added must sign in with Google again.
//
// Two paths:
//  - No docId (or the doc is gone / no longer carries our named ranges):
//    create a fresh doc and stamp a named range around each section.
//  - Known docId: read the doc back and rewrite *only* the sections whose text
//    actually changed. Anything the student added to the doc themselves —
//    comments, images, their own paragraphs between sections — survives, which
//    a blunt "replace the whole body" sync would wipe out every time.
// Either way the response carries the docId so the note can stay linked to it.

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

  let body: Partial<NoteDocInput> & { docId?: unknown };
  try {
    body = (await req.json()) as Partial<NoteDocInput> & { docId?: unknown };
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

  const linkedId = str(body.docId).trim();

  try {
    // Re-sync path: fetch the linked doc and patch just the stale sections.
    if (linkedId) {
      const existing = await fetchDoc(linkedId, token);
      if (existing) {
        const { requests, changed, relink } = buildUpdateRequests(note, existing);
        // relink means we can't locate our sections any more — fall through and
        // start a clean doc rather than overwriting the student's edits blind.
        if (!relink) {
          if (requests.length) {
            const ok = await batchUpdate(linkedId, token, requests);
            if (!ok) {
              return Response.json(
                {
                  error:
                    "Couldn't update the Google Doc right now — please try again.",
                },
                { status: 502 },
              );
            }
          }
          return Response.json({
            url: docUrl(linkedId),
            docId: linkedId,
            created: false,
            changed,
          });
        }
      }
    }

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

    // 2. Insert the text, layer on the formatting, and mark the sections.
    const { requests } = buildCreateRequests(note);
    if (requests.length) await batchUpdate(docId, token, requests);

    return Response.json({
      url: docUrl(docId),
      docId,
      created: true,
      changed: [],
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

const docUrl = (id: string) => `https://docs.google.com/document/d/${id}/edit`;

// Read a linked doc back. A 404/410 means the student deleted it and a 400 means
// the id is junk — both just mean "make a new one", so they return null rather
// than throwing. A 401/403 is a real auth problem and does throw.
async function fetchDoc(
  docId: string,
  token: string,
): Promise<DocsDocument | null> {
  const res = await fetch(`${DOCS}/${encodeURIComponent(docId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.ok) return (await res.json()) as DocsDocument;
  if (res.status === 401 || res.status === 403) throw makeErr(res.status);
  return null;
}

async function batchUpdate(docId: string, token: string, requests: unknown[]) {
  const res = await fetch(`${DOCS}/${docId}:batchUpdate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ requests }),
  });
  // On the create path the doc exists either way; if formatting fails we still
  // hand back the link rather than losing the student's export. Callers that
  // need the write to have landed check the returned flag.
  if (!res.ok && (res.status === 401 || res.status === 403)) {
    throw makeErr(res.status);
  }
  return res.ok;
}

function makeErr(status: number): Error & { status: number } {
  const e = new Error(`Docs ${status}`) as Error & { status: number };
  e.status = status;
  return e;
}
