import OpenAI from "openai";
import {
  ELIORA_SUMMARY_MODEL,
  classifySchoolItem,
  parseIcs,
  schoolImportPrompt,
  type EventKind,
  type LearnerProfile,
  type SchoolImport,
  type SchoolImportItem,
} from "@eliora/shared";

// Imports a learner's assignments / due dates / classes / grades from ANY school
// app WITHOUT accounts or OAuth. Two modes feed the same { import: SchoolImport }
// shape:
//   • "ics"   — an iCalendar feed (URL or raw text). Google Classroom, Canvas,
//               Schoology and PowerSchool all expose one. Parsed deterministically.
//   • "paste" — pasted portal text / CSV / grade report. Parsed by a forced tool
//               call (gpt-4o-mini) so the output is always structured.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KINDS: readonly string[] = ["exam", "final", "quiz", "assignment", "other"];
const asKind = (v: unknown): EventKind =>
  KINDS.includes(String(v)) ? (v as EventKind) : "other";
const str = (v: unknown) =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;
const asDate = (v: unknown) => {
  const m = String(v ?? "").match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : undefined;
};

const EXTRACT_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "extract_school_data",
    description:
      "Return the classes, assignments, events, and grades found in the text.",
    parameters: {
      type: "object",
      properties: {
        classes: {
          type: "array",
          items: { type: "string" },
          description: "Distinct course/class names.",
        },
        assignments: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              subject: { type: "string" },
              due: { type: "string", description: "YYYY-MM-DD if given." },
            },
            required: ["title"],
          },
        },
        events: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              date: { type: "string", description: "YYYY-MM-DD." },
              kind: {
                type: "string",
                enum: ["exam", "final", "quiz", "assignment", "other"],
              },
            },
            required: ["title", "date"],
          },
        },
        grades: {
          type: "array",
          items: {
            type: "object",
            properties: {
              course: { type: "string" },
              grade: { type: "string" },
            },
            required: ["course", "grade"],
          },
        },
      },
      required: ["classes", "assignments", "events", "grades"],
    },
  },
};

type Body = {
  mode?: "ics" | "paste";
  icsUrl?: string;
  icsText?: string;
  text?: string;
  profile?: LearnerProfile;
};

// Refuse to fetch obviously-internal hosts (basic SSRF guard). This route takes
// a user-supplied URL server-side, so keep it to public http(s) calendar feeds.
function isSafeFeedUrl(u: URL): boolean {
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const h = u.hostname.toLowerCase();
  if (
    h === "localhost" ||
    h === "0.0.0.0" ||
    h === "::1" ||
    h.endsWith(".local") ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^169\.254\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h)
  )
    return false;
  return true;
}

// Dedupe class names case-insensitively, keeping first-seen casing.
function dedupe(names: (string | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names) {
    const t = (n ?? "").trim();
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

async function importFromIcs(body: Body): Promise<SchoolImport> {
  let raw = (body.icsText ?? "").trim();
  const urlRaw = (body.icsUrl ?? "").trim();
  if (!raw && urlRaw) {
    // Calendar feeds are commonly handed out as webcal:// — swap to https.
    const normalized = urlRaw.replace(/^webcal:\/\//i, "https://");
    let url: URL;
    try {
      url = new URL(normalized);
    } catch {
      throw new Error("bad_url");
    }
    if (!isSafeFeedUrl(url)) throw new Error("bad_url");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    try {
      const res = await fetch(url.toString(), {
        signal: ctrl.signal,
        headers: { "User-Agent": "Eliora/1.0 (calendar import)" },
      });
      raw = await res.text();
    } finally {
      clearTimeout(timer);
    }
  }
  const parsed = parseIcs(raw);
  const items: SchoolImportItem[] = parsed
    .filter((e) => e.title && e.date)
    .map((e) => {
      const c = classifySchoolItem(e.title, e.description);
      return {
        type: c.type,
        title: e.title,
        date: e.date,
        subject: c.subject,
        kind: c.kind,
      };
    })
    // Soonest first, and keep it manageable.
    .sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""))
    .slice(0, 200);
  return {
    items,
    classes: dedupe(items.map((i) => i.subject)),
    grades: [],
  };
}

async function importFromPaste(body: Body): Promise<SchoolImport> {
  const text = (body.text ?? "").trim();
  if (!text) throw new Error("empty");
  const today = new Date().toISOString().slice(0, 10);
  const client = new OpenAI(); // reads OPENAI_API_KEY; throws if missing
  const completion = await client.chat.completions.create({
    model: ELIORA_SUMMARY_MODEL,
    max_completion_tokens: 2500,
    messages: [
      { role: "system", content: schoolImportPrompt(body.profile) },
      { role: "user", content: `Today is ${today}.\n\n${text.slice(0, 16000)}` },
    ],
    tools: [EXTRACT_TOOL],
    tool_choice: { type: "function", function: { name: "extract_school_data" } },
  });
  const call = completion.choices[0]?.message?.tool_calls?.[0];
  const args =
    call && "function" in call
      ? JSON.parse(call.function.arguments || "{}")
      : {};

  const items: SchoolImportItem[] = [];
  for (const a of Array.isArray(args.assignments) ? args.assignments : []) {
    const title = str(a?.title);
    if (!title) continue;
    items.push({
      type: "assignment",
      title,
      date: asDate(a?.due),
      subject: str(a?.subject),
      kind: "assignment",
    });
  }
  for (const e of Array.isArray(args.events) ? args.events : []) {
    const title = str(e?.title);
    const date = asDate(e?.date);
    if (!title || !date) continue;
    items.push({ type: "event", title, date, kind: asKind(e?.kind) });
  }
  const grades = (Array.isArray(args.grades) ? args.grades : [])
    .map((g: { course?: unknown; grade?: unknown }) => ({
      course: str(g?.course),
      grade: str(g?.grade),
    }))
    .filter(
      (g: { course?: string; grade?: string }) => g.course && g.grade,
    )
    .slice(0, 40) as { course: string; grade: string }[];

  const classes = dedupe([
    ...(Array.isArray(args.classes) ? args.classes.map(str) : []),
    ...items.map((i) => i.subject),
  ]).slice(0, 40);

  return { items: items.slice(0, 200), classes, grades };
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const mode: "ics" | "paste" = body.mode === "paste" ? "paste" : "ics";
  try {
    const result =
      mode === "ics"
        ? await importFromIcs(body)
        : await importFromPaste(body);
    if (
      !result.items.length &&
      !result.classes.length &&
      !result.grades.length
    ) {
      return Response.json({
        import: result,
        note:
          mode === "ics"
            ? "I couldn't find any events in that calendar — double-check the link, or paste your assignments instead."
            : "I couldn't find any school data in that — try pasting a bit more.",
      });
    }
    return Response.json({ import: result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (msg === "bad_url") {
      return Response.json(
        { error: "That doesn't look like a valid calendar link." },
        { status: 200 },
      );
    }
    if (msg === "empty") {
      return Response.json(
        { error: "Paste something first." },
        { status: 200 },
      );
    }
    return Response.json(
      {
        error:
          mode === "ics"
            ? "Couldn't read that calendar — check the link or upload the .ics file instead."
            : "Couldn't read that right now — try again.",
      },
      { status: 200 },
    );
  }
}
