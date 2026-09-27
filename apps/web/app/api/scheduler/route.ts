import OpenAI from "openai";
import {
  ELIORA_SUMMARY_MODEL,
  SCHEDULE_DAY_END,
  SCHEDULE_DAY_START,
  SCHEDULE_MAX_BLOCKS,
  WEEK_DAYS,
  scheduleHHMM,
  scheduleMinutes,
  schedulePrompt,
  type ScheduleBlock,
  type ScheduleBlockKind,
  type ScheduleReply,
  type ScheduleRequest,
  type ScheduleStage,
  type WeekDay,
  type WeekSchedule,
} from "@eliora/shared";

// The schedule studio: a conversation that finds out what the learner's week
// already holds — practice, shifts, the thing they never get round to — and
// then lays study blocks into the gaps that are actually left. One turn in,
// one turn out; the client keeps the transcript and the current week and sends
// both back, so this route stays stateless like the rest of them.
//
// POST /api/scheduler  { messages, schedule?, profile? } -> { reply: ScheduleReply }
//
// Forced tool call so every turn comes back the same shape, gpt-4o-mini like
// the other structured endpoints.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Told to build first, a small model still opens with "so, what have you got
// on?" — the questionnaire is a strong enough habit that prose alone doesn't
// break it. So when there's no week yet, "blocks" is a required argument: the
// only reply it can physically make is a drawn week. Any question it still
// wants to ask arrives underneath one.
const planTool = (
  hasWeek: boolean,
): OpenAI.Chat.Completions.ChatCompletionTool => ({
  type: "function",
  function: {
    name: "plan_week",
    description: hasWeek
      ? "Reply to the learner and edit the week they already have."
      : "Draw this learner's week from what they just said, and reply to them.",
    parameters: {
      type: "object",
      properties: {
        reply: {
          type: "string",
          description: hasWeek
            ? "What you say to them. Plain text, a few short lines, naming what you changed."
            : "What you say to them. Plain text, a few short lines: one line on what you took from them and what you assumed, and at most one question.",
        },
        stage: {
          type: "string",
          enum: ["intake", "ready"],
          description:
            '"intake" while still asking what their week holds, "ready" on any turn you return a schedule.',
        },
        chips: {
          type: "array",
          items: { type: "string" },
          description:
            "2–5 short tappable example answers to the question you just asked, if you asked one.",
        },
        blocks: {
          type: "array",
          description:
            "The whole week, for the FIRST draft or a total rebuild only. Send this on your very first reply — draw the week from what they said and default the rest. Leave it out when a week already exists — use edits instead.",
          items: {
            type: "object",
            properties: {
              day: { type: "string", enum: [...WEEK_DAYS] },
              start: {
                type: "string",
                description: 'Start time, "HH:MM" on a 24-hour clock.',
              },
              min: {
                type: "integer",
                description: "Length in minutes, a multiple of 5.",
              },
              title: {
                type: "string",
                description: "Short label, e.g. 'Chemistry' or 'Swim practice'.",
              },
              kind: {
                type: "string",
                enum: ["study", "activity", "class", "rest", "other"],
              },
              detail: {
                type: "string",
                description:
                  "One line: the actual job in this block, not a restatement of the title.",
              },
              fixed: {
                type: "boolean",
                description:
                  "True for real commitments they told you about — these never move.",
              },
              pomodoroMin: {
                type: "integer",
                description:
                  "Study blocks only: work-interval length in minutes for a Pomodoro-style sprint inside this block (e.g. 25). Omit unless the learner wants Pomodoro pacing.",
              },
            },
            required: ["day", "start", "min", "title", "kind"],
          },
        },
        edits: {
          type: "array",
          description:
            "Changes to a week that already exists. Only the blocks you're actually touching — everything you don't name is kept for you.",
          items: {
            type: "object",
            properties: {
              action: {
                type: "string",
                enum: ["add", "update", "remove"],
                description:
                  'Moving something is one "update" with a new day or start — never a "remove" plus an "add".',
              },
              id: {
                type: "string",
                description:
                  "The block's id, copied from the week you were shown. Required for update and remove.",
              },
              day: { type: "string", enum: [...WEEK_DAYS] },
              start: { type: "string", description: '"HH:MM", 24-hour.' },
              min: { type: "integer", description: "Minutes, a multiple of 5." },
              title: { type: "string" },
              kind: {
                type: "string",
                enum: ["study", "activity", "class", "rest", "other"],
              },
              detail: { type: "string" },
              fixed: { type: "boolean" },
              pomodoroMin: {
                type: "integer",
                description:
                  "Study blocks only: work-interval length in minutes for a Pomodoro-style sprint (e.g. 25).",
              },
            },
            required: ["action"],
          },
        },
        summary: {
          type: "string",
          description: "1–2 sentences on the shape of the week.",
        },
        note: { type: "string", description: "One warm sentence from Eliora." },
        warning: {
          type: "string",
          description:
            "Only when the week genuinely doesn't fit — name what to cut.",
        },
      },
      required: hasWeek ? ["reply", "stage"] : ["reply", "stage", "blocks"],
    },
  },
});

const str = (v: unknown) =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

const KINDS: ScheduleBlockKind[] = ["study", "activity", "class", "rest", "other"];
const DAY_ORDER = new Map<WeekDay, number>(WEEK_DAYS.map((d, i) => [d, i]));
const EARLIEST = scheduleMinutes(SCHEDULE_DAY_START);
const LATEST = scheduleMinutes(SCHEDULE_DAY_END);

// The model is good at where things go and bad at staying inside a grid, so
// every block is clamped into drawable hours here rather than trusted. One that
// can't be salvaged is dropped — a week missing a row beats a week with a block
// at 3am.
function normalize(raw: Record<string, unknown>, id: string): ScheduleBlock | null {
  const day = str(raw?.day)?.toLowerCase() as WeekDay | undefined;
  const title = str(raw?.title);
  if (!day || !DAY_ORDER.has(day) || !title) return null;

  const start = scheduleMinutes(str(raw?.start) ?? "");
  if (!start) return null; // 0 means unparseable, and midnight isn't drawable
  const min =
    typeof raw?.min === "number" && raw.min > 0
      ? Math.min(Math.max(5, Math.round(raw.min / 5) * 5), 8 * 60)
      : 30;
  // Slide anything that overruns the drawable day back inside it.
  const from = Math.max(EARLIEST, Math.min(start, LATEST - min));
  if (from + min > LATEST) return null;

  const kind = KINDS.includes(raw?.kind as ScheduleBlockKind)
    ? (raw.kind as ScheduleBlockKind)
    : "other";

  const pomodoroMin =
    kind === "study" &&
    typeof raw?.pomodoroMin === "number" &&
    raw.pomodoroMin > 0
      ? Math.min(Math.max(5, Math.round(raw.pomodoroMin / 5) * 5), min)
      : undefined;

  return {
    id,
    day,
    start: scheduleHHMM(from),
    min,
    title: title.slice(0, 60),
    kind,
    detail: str(raw?.detail)?.slice(0, 160),
    // Pinned means "you told me this is immovable", which only ever describes
    // the learner's own commitments. The model likes to pin study blocks too —
    // but study is precisely the part it's allowed to shuffle.
    fixed:
      raw?.fixed === true && (kind === "activity" || kind === "class")
        ? true
        : undefined,
    pomodoroMin,
  };
}

// Sorted for the grid, deduped so React keys and drop targets stay honest.
function tidy(blocks: ScheduleBlock[], seq: () => string): ScheduleBlock[] {
  const seen = new Set<string>();
  for (const b of blocks) {
    if (seen.has(b.id)) b.id = seq();
    seen.add(b.id);
  }
  return blocks
    .sort(
      (a, b) =>
        DAY_ORDER.get(a.day)! - DAY_ORDER.get(b.day)! ||
        scheduleMinutes(a.start) - scheduleMinutes(b.start),
    )
    .slice(0, SCHEDULE_MAX_BLOCKS);
}

function cleanBlocks(raw: unknown, seq: () => string): ScheduleBlock[] {
  const blocks: ScheduleBlock[] = [];
  for (const b of Array.isArray(raw) ? raw : []) {
    const block = normalize(b, seq());
    if (block) blocks.push(block);
  }
  return tidy(blocks, seq);
}

// Only the fields an edit actually carries, so "move this to Thursday" doesn't
// arrive as a block with no title.
function pick(e: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ["day", "start", "title", "kind", "detail"] as const)
    if (str(e?.[k])) out[k] = e[k];
  if (typeof e?.min === "number") out.min = e.min;
  if (typeof e?.fixed === "boolean") out.fixed = e.fixed;
  if (typeof e?.pomodoroMin === "number") out.pomodoroMin = e.pomodoroMin;
  return out;
}

// Edits, not redraws. Asking a small model to re-emit a whole week with one
// thing moved reliably produces the moved block AND the original — so the week
// is kept here and only the blocks it names are touched.
function applyEdits(
  current: ScheduleBlock[],
  raw: unknown,
  seq: () => string,
): ScheduleBlock[] {
  const blocks = current.map((b) => ({ ...b }));
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const gone = new Set<string>();

  for (const e of Array.isArray(raw) ? raw : []) {
    const action = str(e?.action);
    const id = str(e?.id);

    if (action === "remove") {
      if (id) gone.add(id);
      continue;
    }
    if (action !== "add" && action !== "update") continue;

    const target = action === "update" && id ? byId.get(id) : undefined;
    if (target) {
      const merged = normalize({ ...target, ...pick(e) }, target.id);
      if (merged) Object.assign(target, merged);
      continue;
    }
    // An add, or an update against an id we've never heard of — which is a new
    // block in disguise. Better a block in the wrong place than a silent no-op.
    const fresh = normalize(e, seq());
    if (fresh) {
      blocks.push(fresh);
      byId.set(fresh.id, fresh);
    }
  }

  return tidy(
    blocks.filter((b) => !gone.has(b.id)),
    seq,
  );
}

// The week as the learner currently sees it, drags and hand-edits included —
// this is what she's editing, so it has to go back verbatim, ids and all. The
// id leads every line: an edit that names the wrong one silently rewrites a
// block nobody asked about, and a small model reading to the end of a long line
// for the id is exactly how that happens.
function describe(schedule: WeekSchedule): string {
  const byDay = WEEK_DAYS.map((day) => {
    const rows = schedule.blocks
      .filter((b) => b.day === day)
      .sort((a, b) => scheduleMinutes(a.start) - scheduleMinutes(b.start))
      .map(
        (b) =>
          `  id=${b.id} | ${day} ${b.start} | ${b.min}min | ${b.kind}${
            b.fixed ? " (fixed)" : ""
          }${b.pomodoroMin ? ` (${b.pomodoroMin}min pomodoro)` : ""} | ${b.title}${b.detail ? ` — ${b.detail}` : ""}`,
      );
    return rows.length ? `${day.toUpperCase()}\n${rows.join("\n")}` : `${day.toUpperCase()}\n  (free)`;
  });
  return `The week as it stands right now. Every edit must name one of these \
ids, copied exactly:\n${byDay.join("\n")}`;
}

export async function POST(req: Request) {
  let body: ScheduleRequest;
  try {
    body = (await req.json()) as ScheduleRequest;
  } catch {
    return Response.json({ error: "Bad request." }, { status: 400 });
  }

  // Keep the last stretch of the conversation only: intake is short, and edit
  // requests only ever refer to the week we're already sending in full.
  const turns = (Array.isArray(body.messages) ? body.messages : [])
    .filter((m) => str(m?.text))
    .slice(-20);
  if (!turns.length) {
    return Response.json({ error: "Say something first." }, { status: 400 });
  }

  const current =
    body.schedule && Array.isArray(body.schedule.blocks) && body.schedule.blocks.length
      ? body.schedule
      : null;

  let n = 0;
  const seq = () => `sb${Date.now().toString(36)}${(n++).toString(36)}`;

  try {
    const client = new OpenAI();
    const completion = await client.chat.completions.create({
      model: ELIORA_SUMMARY_MODEL,
      max_completion_tokens: 3000,
      messages: [
        {
          role: "system",
          content: schedulePrompt({ ...body, messages: turns, schedule: current }),
        },
        ...(current
          ? [{ role: "system" as const, content: describe(current) }]
          : []),
        ...turns.map((m) => ({
          role: m.role === "user" ? ("user" as const) : ("assistant" as const),
          content: m.text.trim(),
        })),
      ],
      tools: [planTool(!!current)],
      tool_choice: { type: "function", function: { name: "plan_week" } },
    });

    const call = completion.choices[0]?.message?.tool_calls?.[0];
    const args = JSON.parse(
      (call && "function" in call ? call.function.arguments : "") || "{}",
    );

    // A full week is the first draft or a deliberate rebuild; anything after
    // that arrives as edits laid over the week the learner already has.
    const drafted = cleanBlocks(args?.blocks, seq);
    const edits = Array.isArray(args?.edits) ? args.edits : [];
    let schedule: WeekSchedule | undefined;
    if (drafted.length) {
      schedule = {
        blocks: drafted,
        summary: str(args.summary) || "",
        note: str(args.note),
        warning: str(args.warning),
      };
    } else if (edits.length) {
      // Adds against an empty week are a first draft that took the other door.
      const blocks = applyEdits(current?.blocks ?? [], edits, seq);
      // Edits that clear the board entirely are a misfire, not an instruction —
      // the old week stands until a real replacement arrives.
      if (blocks.length)
        schedule = {
          blocks,
          summary: str(args.summary) || current?.summary || "",
          note: str(args.note) ?? current?.note,
          warning: str(args.warning),
        };
    }

    const stage: ScheduleStage = schedule || current ? "ready" : "intake";

    const reply: ScheduleReply = {
      // She should never be silent, and "tell me about your week" is the wrong
      // thing to say to someone who's already looking at one.
      reply:
        str(args.reply) ||
        (schedule
          ? "Done — that's your week updated."
          : current
            ? "I've left the week as it was. Say that again?"
            : "Tell me what your week already looks like and I'll build round it."),
      // Chips used to be an intake-only thing. Now that the first turn comes
      // back with a week drawn, the one question she has left rides underneath
      // it — and it still deserves tappable answers.
      chips: (Array.isArray(args.chips) ? args.chips : [])
        .map((c: unknown) => str(c)?.slice(0, 40))
        .filter(Boolean)
        .slice(0, 5),
      schedule,
      stage,
    };

    return Response.json({ reply });
  } catch {
    return Response.json(
      { error: "Sorry, I lost my place there. Say that again?" },
      { status: 200 },
    );
  }
}
