import OpenAI from "openai";
import {
  ELIORA_SUMMARY_MODEL,
  dailyTasksPrompt,
  dateSuggestionsPrompt,
  todoSuggestionsPrompt,
  toolSuggestionsPrompt,
  weekPlanPrompt,
  type LearnerProfile,
} from "@eliora/shared";

// A family of AI "suggestion" helpers behind one route, chosen by `kind`:
//   "daily" → { items: [{title, why, subject}] }           (today's fresh tasks)
//   "week"  → { items: [{title, why, when}] }              (this-week focus plan)
//   "dates" → { suggestions: [{title, date, kind, why}] }  (dates to add)
//   "todos" → { suggestions: [{title, subject, due}] }     (prep to-dos)
//   "tools" → { suggestions: [{type, topic, why}] }        (flashcards/quizzes)
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Kind = "daily" | "week" | "dates" | "todos" | "tools";
type EventLike = { title?: string; date?: string; kind?: string };
type GoalLike = { specific?: string; statement?: string; timeBound?: string };
type AsgLike = { title?: string; subject?: string; due?: string };

type SuggestRequest = {
  kind?: Kind;
  career?: string;
  classes?: string;
  grade?: string;
  goals?: GoalLike[];
  events?: EventLike[];
  assignments?: AsgLike[];
  plan?: string[]; // the learner's current plan milestones (unchecked next steps)
  missed?: string[];
  existing?: string[];
  profile?: LearnerProfile;
};

const TOOLS: Record<Kind, OpenAI.Chat.Completions.ChatCompletionTool> = {
  daily: {
    type: "function",
    function: {
      name: "plan_day",
      description: "Return a short list of small tasks to do today.",
      parameters: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                why: { type: "string" },
                subject: { type: "string", description: "Subject, optional." },
              },
              required: ["title"],
            },
          },
        },
        required: ["items"],
      },
    },
  },
  week: {
    type: "function",
    function: {
      name: "plan_week",
      description: "Return a short prioritized plan for this week.",
      parameters: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                why: { type: "string" },
                when: { type: "string", description: "Suggested day, optional." },
              },
              required: ["title"],
            },
          },
        },
        required: ["items"],
      },
    },
  },
  dates: {
    type: "function",
    function: {
      name: "suggest_dates",
      description: "Return important dates to add to the calendar.",
      parameters: {
        type: "object",
        properties: {
          suggestions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                date: { type: "string", description: "YYYY-MM-DD" },
                kind: {
                  type: "string",
                  enum: ["exam", "final", "quiz", "assignment", "other"],
                },
                why: { type: "string" },
              },
              required: ["title", "date"],
            },
          },
        },
        required: ["suggestions"],
      },
    },
  },
  todos: {
    type: "function",
    function: {
      name: "suggest_todos",
      description: "Return prep to-dos to add to the assignments list.",
      parameters: {
        type: "object",
        properties: {
          suggestions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                subject: { type: "string" },
                due: { type: "string", description: "YYYY-MM-DD, optional." },
              },
              required: ["title"],
            },
          },
        },
        required: ["suggestions"],
      },
    },
  },
  tools: {
    type: "function",
    function: {
      name: "suggest_tools",
      description: "Return study tools (flashcards/quizzes) to make.",
      parameters: {
        type: "object",
        properties: {
          suggestions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["flashcards", "quiz"] },
                topic: { type: "string" },
                why: { type: "string" },
              },
              required: ["type", "topic"],
            },
          },
        },
        required: ["suggestions"],
      },
    },
  },
};

const TOOL_NAMES: Record<Kind, string> = {
  daily: "plan_day",
  week: "plan_week",
  dates: "suggest_dates",
  todos: "suggest_todos",
  tools: "suggest_tools",
};

const PROMPTS: Record<Kind, (p?: LearnerProfile) => string> = {
  daily: dailyTasksPrompt,
  week: weekPlanPrompt,
  dates: dateSuggestionsPrompt,
  todos: todoSuggestionsPrompt,
  tools: toolSuggestionsPrompt,
};

const str = (v: unknown) =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;
const isDate = (v: unknown): v is string =>
  typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

export async function POST(req: Request) {
  let body: SuggestRequest;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  const kind = body.kind ?? "week";
  if (!TOOLS[kind]) return Response.json({ error: "bad_kind" }, { status: 400 });

  const today = new Date().toISOString().slice(0, 10);
  const goals = (body.goals ?? [])
    .map((g) => (g.statement || g.specific || "").trim())
    .filter(Boolean)
    .slice(0, 15);
  const events = (body.events ?? [])
    .filter((e) => (e.title ?? "").trim() && isDate(e.date) && e.date! >= today)
    .sort((a, b) => a.date!.localeCompare(b.date!))
    .slice(0, 12)
    .map((e) => `- ${e.date} (${e.kind ?? "event"}): ${e.title!.trim()}`);
  const assignments = (body.assignments ?? [])
    .map((a) => (a.title ?? "").trim())
    .filter(Boolean)
    .slice(0, 15);
  const missed = (body.missed ?? [])
    .filter((m) => typeof m === "string" && m.trim())
    .slice(0, 15);
  const existing = (body.existing ?? [])
    .filter((s) => typeof s === "string" && s.trim())
    .slice(0, 30);
  const plan = (body.plan ?? [])
    .filter((s) => typeof s === "string" && s.trim())
    .map((s) => s.trim())
    .slice(0, 20);

  const detail = [
    `Today is ${today}.`,
    str(body.career) ? `Career goal: ${body.career!.trim()}` : "",
    str(body.classes) || str(body.profile?.klass)
      ? `Classes: ${str(body.classes) ?? body.profile!.klass!.trim()}`
      : "",
    str(body.grade) || str(body.profile?.gradeYear)
      ? `Grade/year: ${str(body.grade) ?? body.profile!.gradeYear!.trim()}`
      : "",
    plan.length
      ? `Current plan — next unchecked steps:\n${plan.map((p) => `- ${p}`).join("\n")}`
      : "",
    goals.length ? `Goals:\n${goals.map((g) => `- ${g}`).join("\n")}` : "",
    events.length ? `Upcoming calendar events:\n${events.join("\n")}` : "",
    assignments.length
      ? `Current assignments:\n${assignments.map((a) => `- ${a}`).join("\n")}`
      : "",
    missed.length ? `Weak topics (got wrong): ${missed.join("; ")}` : "",
    existing.length ? `Already have (don't repeat): ${existing.join("; ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const client = new OpenAI(); // reads OPENAI_API_KEY; throws if missing
    const completion = await client.chat.completions.create({
      model: ELIORA_SUMMARY_MODEL,
      max_completion_tokens: 800,
      messages: [
        { role: "system", content: PROMPTS[kind](body.profile) },
        { role: "user", content: detail || "Make suggestions." },
      ],
      tools: [TOOLS[kind]],
      tool_choice: {
        type: "function",
        function: { name: TOOL_NAMES[kind] },
      },
    });
    const call = completion.choices[0]?.message?.tool_calls?.[0];
    const args =
      call && "function" in call
        ? JSON.parse(call.function.arguments || "{}")
        : {};

    if (kind === "daily") {
      const items = (Array.isArray(args.items) ? args.items : [])
        .filter((it: { title?: unknown }) => str(it?.title))
        .slice(0, 5)
        .map((it: { title?: unknown; why?: unknown; subject?: unknown }) => ({
          title: String(it.title).trim(),
          why: str(it.why),
          subject: str(it.subject),
        }));
      return items.length
        ? Response.json({ items })
        : Response.json({ error: "none" }, { status: 200 });
    }

    if (kind === "week") {
      const items = (Array.isArray(args.items) ? args.items : [])
        .filter((it: { title?: unknown }) => str(it?.title))
        .slice(0, 6)
        .map((it: { title?: unknown; why?: unknown; when?: unknown }) => ({
          title: String(it.title).trim(),
          why: str(it.why),
          when: str(it.when),
        }));
      return items.length
        ? Response.json({ items })
        : Response.json({ error: "none" }, { status: 200 });
    }

    const raw = Array.isArray(args.suggestions) ? args.suggestions : [];
    let suggestions: unknown[] = [];
    if (kind === "dates") {
      suggestions = raw
        .filter((s: { title?: unknown }) => str(s?.title))
        .slice(0, 8)
        .map((s: { title?: unknown; date?: unknown; kind?: unknown; why?: unknown }) => ({
          title: String(s.title).trim(),
          date: isDate(s.date) ? s.date : undefined,
          kind: ["exam", "final", "quiz", "assignment", "other"].includes(
            s.kind as string,
          )
            ? (s.kind as string)
            : "other",
          why: str(s.why),
        }))
        .filter((s: { date?: string }) => s.date);
    } else if (kind === "todos") {
      suggestions = raw
        .filter((s: { title?: unknown }) => str(s?.title))
        .slice(0, 8)
        .map((s: { title?: unknown; subject?: unknown; due?: unknown }) => ({
          title: String(s.title).trim(),
          subject: str(s.subject),
          due: isDate(s.due) ? s.due : undefined,
        }));
    } else {
      // tools
      suggestions = raw
        .filter((s: { topic?: unknown }) => str(s?.topic))
        .slice(0, 6)
        .map((s: { type?: unknown; topic?: unknown; why?: unknown }) => ({
          type: s.type === "quiz" ? "quiz" : "flashcards",
          topic: String(s.topic).trim(),
          why: str(s.why),
        }));
    }
    return suggestions.length
      ? Response.json({ suggestions })
      : Response.json({ error: "none" }, { status: 200 });
  } catch {
    return Response.json({ error: "failed" }, { status: 200 });
  }
}
