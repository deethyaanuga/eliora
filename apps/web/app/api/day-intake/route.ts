import OpenAI from "openai";
import {
  DayIntakeAnswers,
  DayIntakeReply,
  DayIntakeRequest,
  ELIORA_SUMMARY_MODEL,
  PROFILE_FOCUS_HELP,
  PROFILE_FOCUS_TIME,
  PROFILE_SESSION_LENGTH,
  dayIntakePrompt,
  type ScheduleStage,
} from "@eliora/shared";

// The intake for today's schedule — the five-question form, asked out loud one
// question at a time. She only gathers: the schedule itself is still built by
// /api/suggest (kind: "schedule"), which is the one place that knows how to lay
// out an evening around the learner's real tasks.
//
// POST /api/day-intake  { messages, profile?, today? } -> { reply: DayIntakeReply }
//
// Forced tool call so every turn comes back the same shape, gpt-4o-mini like the
// other structured endpoints.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PLAN_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "plan_today",
    description:
      "Reply to the learner, and once you know enough, hand back what you learned.",
    parameters: {
      type: "object",
      properties: {
        reply: {
          type: "string",
          description:
            "What you say to them. Plain text, a line or two. Exactly one question if you're still asking.",
        },
        stage: {
          type: "string",
          enum: ["intake", "ready"],
          description:
            '"intake" while you\'re still asking, "ready" on the turn you fill in answers.',
        },
        chips: {
          type: "array",
          items: { type: "string" },
          description:
            "2–4 short tappable example answers to the question you just asked. Omit once you're ready.",
        },
        answers: {
          type: "object",
          description:
            "What you found out. Only on the turn you're ready to build.",
          properties: {
            freeHour: {
              type: "integer",
              description:
                "The hour they can start, 9–20 on a 24-hour clock. Required to be ready.",
            },
            budgetMin: {
              type: "integer",
              description:
                "Minutes they want to study today, a multiple of 15. Leave out for 'as much as fits'.",
            },
            focusTime: { type: "string", enum: [...PROFILE_FOCUS_TIME] },
            sessionLength: {
              type: "string",
              enum: [...PROFILE_SESSION_LENGTH],
            },
            focusHelp: {
              type: "string",
              description: "Comma-joined, only values from the allowed list.",
            },
            focusNote: {
              type: "string",
              description:
                "One line in their words on what today has to cover.",
            },
          },
          required: ["freeHour"],
        },
      },
      required: ["reply", "stage"],
    },
  },
};

const str = (v: unknown) =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

// One of the profile's own option strings, or nothing. A near-miss written onto
// the profile ("evenings") would sit there forever matching nothing, so an
// answer that isn't on the list is dropped rather than saved.
const oneOf = (v: unknown, options: readonly string[]) => {
  const said = str(v);
  return said && options.includes(said) ? said : undefined;
};

// "Music, quiet environment" → only the entries that are real options.
const someOf = (v: unknown, options: readonly string[]) => {
  const picked = (str(v) ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => options.includes(s));
  return picked.length ? picked.join(", ") : undefined;
};

// The one field she can't be ready without, and the one the model is most
// likely to hand back as a 12-hour clock number. 3 means 3 PM here — nobody
// starts their after-school study at 3 AM.
function freeHour(raw: unknown): number | undefined {
  const n = typeof raw === "number" ? Math.round(raw) : NaN;
  if (!Number.isFinite(n)) return undefined;
  const hour = n >= 1 && n <= 8 ? n + 12 : n;
  return hour >= 9 && hour <= 20 ? hour : undefined;
}

function cleanAnswers(raw: unknown): DayIntakeAnswers | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const a = raw as Record<string, unknown>;
  const hour = freeHour(a.freeHour);
  if (!hour) return undefined; // no start hour, nothing to build around

  const budget =
    typeof a.budgetMin === "number" && a.budgetMin > 0
      ? Math.min(8 * 60, Math.max(15, Math.round(a.budgetMin / 15) * 15))
      : undefined;

  return {
    freeHour: hour,
    budgetMin: budget,
    focusTime: oneOf(a.focusTime, PROFILE_FOCUS_TIME),
    sessionLength: oneOf(a.sessionLength, PROFILE_SESSION_LENGTH),
    focusHelp: someOf(a.focusHelp, PROFILE_FOCUS_HELP),
    focusNote: str(a.focusNote)?.slice(0, 240),
  };
}

export async function POST(req: Request) {
  let body: DayIntakeRequest;
  try {
    body = (await req.json()) as DayIntakeRequest;
  } catch {
    return Response.json({ error: "Bad request." }, { status: 400 });
  }

  // The intake is a handful of turns by design, so the whole thing fits.
  const turns = (Array.isArray(body.messages) ? body.messages : [])
    .filter((m) => str(m?.text))
    .slice(-16);
  if (!turns.length) {
    return Response.json({ error: "Say something first." }, { status: 400 });
  }

  try {
    const client = new OpenAI();
    const completion = await client.chat.completions.create({
      model: ELIORA_SUMMARY_MODEL,
      max_completion_tokens: 800,
      messages: [
        {
          role: "system",
          content: dayIntakePrompt({ ...body, messages: turns }),
        },
        ...turns.map((m) => ({
          role: m.role === "user" ? ("user" as const) : ("assistant" as const),
          content: m.text.trim(),
        })),
      ],
      tools: [PLAN_TOOL],
      tool_choice: { type: "function", function: { name: "plan_today" } },
    });

    const call = completion.choices[0]?.message?.tool_calls?.[0];
    const args = JSON.parse(
      (call && "function" in call ? call.function.arguments : "") || "{}",
    );

    // "Ready" is the answers, not the label: a turn that says ready without a
    // usable start hour is still a question, and treating it as ready would
    // build the day around an hour nobody named.
    const answers = args?.stage === "ready" ? cleanAnswers(args.answers) : undefined;
    const stage: ScheduleStage = answers ? "ready" : "intake";

    const reply: DayIntakeReply = {
      reply:
        str(args.reply) ||
        (answers
          ? "Got it — building your day now."
          : "When are you free to start today?"),
      chips:
        stage === "intake"
          ? (Array.isArray(args.chips) ? args.chips : [])
              .map((c: unknown) => str(c)?.slice(0, 40))
              .filter(Boolean)
              .slice(0, 4)
          : undefined,
      answers,
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
