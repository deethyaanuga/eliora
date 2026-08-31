import OpenAI from "openai";
import {
  ELIORA_SUMMARY_MODEL,
  dailyTasksPrompt,
  daySchedulePrompt,
  dateSuggestionsPrompt,
  focusSuggestionsPrompt,
  studySessionPrompt,
  todoSuggestionsPrompt,
  toolSuggestionsPrompt,
  weekPlanPrompt,
  type LearnerProfile,
  type StudyMaterial,
} from "@eliora/shared";

// A family of AI "suggestion" helpers behind one route, chosen by `kind`:
//   "daily"    → { items: [{title, why, subject}] }        (today's fresh tasks)
//   "schedule" → { blocks: [{hour, kind, text}] }          (after-school day plan)
//   "week"     → { items: [{title, why, when}] }           (this-week focus plan)
//   "dates"    → { suggestions: [{title, date, kind, why}] } (dates to add)
//   "todos"    → { suggestions: [{title, subject, due}] }   (prep to-dos)
//   "tools"    → { suggestions: [{type, topic, why}] }      (flashcards/quizzes)
//   "focus"    → { suggestions: [{topic, why, subject}] }   (what to study next)
//   "session"  → { steps: [{title, minutes, kind, from, how}] } (one sit-down session
//                                                    over their material + mistakes)
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Kind =
  | "daily"
  | "schedule"
  | "week"
  | "dates"
  | "todos"
  | "tools"
  | "focus"
  | "session";
type EventLike = { title?: string; date?: string; kind?: string };
type GoalLike = { specific?: string; statement?: string; timeBound?: string };
type AsgLike = { title?: string; subject?: string; due?: string };
// A logged mistake, as the client stores it (page.tsx `Mistake`). Only the parts
// worth spending prompt tokens on.
type MistakeLike = {
  concept?: string;
  subject?: string;
  why?: string;
  fix?: string;
  count?: number;
  resolved?: boolean;
};

type SuggestRequest = {
  kind?: Kind;
  career?: string;
  classes?: string;
  grade?: string;
  goals?: GoalLike[];
  events?: EventLike[];
  assignments?: AsgLike[];
  plan?: string[]; // the learner's current plan milestones (unchecked next steps)
  tasks?: string[]; // today's open daily tasks (~10–20 min each), in priority order
  homeHour?: number; // hour (24h) the learner gets home / is free to study
  budgetMin?: number; // scheduled study minutes today — cap for the tasks' estMin total
  needMin?: number; // minutes today's open tasks add up to — how much the day must hold
  focusNote?: string; // free-form "what today's schedule should prioritize" (from the setup survey)
  missed?: string[];
  mistakes?: MistakeLike[]; // logged mistakes (concept + misconception + fix)
  materials?: StudyMaterial[]; // the PDFs / pasted material they've uploaded
  sessionMin?: number; // how long the study session should run (kind "session")
  existing?: string[];
  profile?: LearnerProfile;
};

const TOOLS: Record<Kind, OpenAI.Chat.Completions.ChatCompletionTool> = {
  schedule: {
    type: "function",
    function: {
      name: "plan_day_schedule",
      description:
        "Return an after-school study schedule as 1-hour blocks (9–20).",
      parameters: {
        type: "object",
        properties: {
          blocks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                hour: {
                  type: "integer",
                  description: "Start hour, 9–20 (24-hour).",
                },
                kind: {
                  type: "string",
                  enum: ["study", "break", "class", "other"],
                },
                text: { type: "string" },
                min: {
                  type: "integer",
                  description:
                    "How many minutes of actual work this block holds — the sum of its tasks' estimates. Multiple of 5, 5–60. Size it by the work, not by the hour.",
                },
              },
              required: ["hour", "text", "min"],
            },
          },
        },
        required: ["blocks"],
      },
    },
  },
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
                priority: {
                  type: "string",
                  enum: ["high", "med", "low"],
                  description:
                    "How important/urgent this task is. high = must-do (soonest deadline, biggest leverage), low = nice-to-have.",
                },
                estMin: {
                  type: "integer",
                  description:
                    "Estimated minutes to finish (multiple of 5, usually 10–30).",
                },
              },
              required: ["title", "priority"],
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
  focus: {
    type: "function",
    function: {
      name: "suggest_focus",
      description:
        "Return the topics the student should study next, weakest/most-urgent first.",
      parameters: {
        type: "object",
        properties: {
          suggestions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                topic: {
                  type: "string",
                  description: "Specific topic to study next (lesson-sized).",
                },
                why: {
                  type: "string",
                  description: "One line naming the weak spot or grade it addresses.",
                },
                subject: { type: "string", description: "Subject, optional." },
              },
              required: ["topic"],
            },
          },
        },
        required: ["suggestions"],
      },
    },
  },
  session: {
    type: "function",
    function: {
      name: "plan_study_session",
      description:
        "Return one ordered study session built from the learner's uploaded material and logged mistakes.",
      parameters: {
        type: "object",
        properties: {
          steps: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: {
                  type: "string",
                  description: "Short name for the step, e.g. \"Redo: mole ratios\".",
                },
                minutes: {
                  type: "integer",
                  description: "Minutes for this step — multiple of 5, 5–30.",
                },
                kind: {
                  type: "string",
                  enum: ["read", "redo", "practice", "recap"],
                },
                from: {
                  type: "string",
                  description:
                    "What this step is anchored to: the material title + section, or the exact mistake/weak topic. Must come from what the learner provided.",
                },
                how: {
                  type: "string",
                  description: "One line telling them exactly what to do.",
                },
              },
              required: ["title", "minutes", "kind"],
            },
          },
        },
        required: ["steps"],
      },
    },
  },
};

const TOOL_NAMES: Record<Kind, string> = {
  schedule: "plan_day_schedule",
  daily: "plan_day",
  week: "plan_week",
  dates: "suggest_dates",
  todos: "suggest_todos",
  tools: "suggest_tools",
  focus: "suggest_focus",
  session: "plan_study_session",
};

const PROMPTS: Record<Kind, (p?: LearnerProfile) => string> = {
  schedule: daySchedulePrompt,
  daily: dailyTasksPrompt,
  week: weekPlanPrompt,
  dates: dateSuggestionsPrompt,
  todos: todoSuggestionsPrompt,
  tools: toolSuggestionsPrompt,
  focus: focusSuggestionsPrompt,
  session: studySessionPrompt,
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
  const tasks = (body.tasks ?? [])
    .filter((s) => typeof s === "string" && s.trim())
    .map((s) => s.trim())
    .slice(0, 8);

  const homeHour =
    typeof body.homeHour === "number" &&
    body.homeHour >= 6 &&
    body.homeHour <= 21
      ? Math.round(body.homeHour)
      : undefined;

  const budgetMin =
    typeof body.budgetMin === "number" && body.budgetMin >= 15
      ? Math.min(720, Math.round(body.budgetMin))
      : undefined;

  // Total minutes today's open tasks need — what the schedule has to hold.
  const needMin =
    typeof body.needMin === "number" && body.needMin >= 5
      ? Math.min(720, Math.round(body.needMin))
      : undefined;

  // How long the study session should run (kind "session").
  const sessionMin =
    typeof body.sessionMin === "number" && body.sessionMin >= 10
      ? Math.min(180, Math.round(body.sessionMin))
      : undefined;

  const materials = (body.materials ?? [])
    .filter((m) => str(m?.title))
    .slice(0, 5)
    .map((m) => {
      const sections = (Array.isArray(m.topics) ? m.topics : [])
        .map((t) => str(t?.title))
        .filter(Boolean)
        .slice(0, 12);
      return `- ${m.title!.trim()}${
        str(m.overview) ? ` — ${m.overview!.trim()}` : ""
      }${sections.length ? ` (sections: ${sections.join("; ")})` : ""}`;
    });

  const mistakes = (body.mistakes ?? [])
    .filter((m) => str(m?.concept) && !m.resolved)
    .slice(0, 10)
    .map(
      (m) =>
        `- ${m.concept!.trim()}${str(m.subject) ? ` (${m.subject!.trim()})` : ""}${
          str(m.why) ? ` — why it went wrong: ${m.why!.trim()}` : ""
        }${str(m.fix) ? ` — the fix: ${m.fix!.trim()}` : ""}${
          typeof m.count === "number" && m.count > 1 ? ` (×${m.count})` : ""
        }`,
    );

  const detail = [
    `Today is ${today}.`,
    homeHour != null
      ? `Gets home / free to study at ${homeHour}:00 (24-hour). Schedule from then until 9 PM.`
      : "",
    budgetMin != null
      ? `Scheduled study time today: ${budgetMin} minutes (from their schedule). Size the tasks so their estMin together come close to this but never exceed it.`
      : "",
    needMin != null
      ? `Today's open tasks need ${needMin} minutes of work in total. Give the day exactly that much study time — no more (don't pad blocks to fill the clock), no less (don't drop work).${
          budgetMin != null && needMin > budgetMin
            ? ` That is more than their ${budgetMin}-minute budget, so schedule the highest-priority tasks first and say in the last block's text what is being pushed to tomorrow.`
            : ""
        }`
      : "",
    str(body.focusNote)
      ? `What the learner wants today's schedule to PRIORITIZE (from their setup survey): ${body.focusNote!.trim()}. Weight the study blocks toward this.`
      : "",
    str(body.career) ? `Career goal: ${body.career!.trim()}` : "",
    str(body.classes) || str(body.profile?.klass)
      ? `Classes: ${str(body.classes) ?? body.profile!.klass!.trim()}`
      : "",
    str(body.grade) || str(body.profile?.gradeYear)
      ? `Grade/year: ${str(body.grade) ?? body.profile!.gradeYear!.trim()}`
      : "",
    tasks.length
      ? `Today's tasks — the learner's chosen focus for today (in priority order, ~10–20 min each). SCHEDULE THESE FIRST, in order:\n${tasks
          .map((t) => `- ${t}`)
          .join("\n")}`
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
    kind === "session" && sessionMin != null
      ? `Session length: ${sessionMin} minutes. The steps' minutes must add up to this and never exceed it.`
      : "",
    kind === "session" && materials.length
      ? `Their uploaded material — anchor steps to these:\n${materials.join("\n")}`
      : "",
    kind === "session" && mistakes.length
      ? `Their logged mistakes — at least one step should redo one:\n${mistakes.join("\n")}`
      : "",
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

    if (kind === "schedule") {
      const seen = new Set<number>();
      const blocks = (Array.isArray(args.blocks) ? args.blocks : [])
        .map(
          (b: { hour?: unknown; kind?: unknown; text?: unknown; min?: unknown }) => {
            const m = typeof b?.min === "number" ? b.min : Number(b?.min);
            return {
              hour:
                typeof b?.hour === "number"
                  ? Math.round(b.hour)
                  : Number(b?.hour),
              kind: ["study", "break", "class", "other"].includes(
                b?.kind as string,
              )
                ? (b!.kind as string)
                : "study",
              text: str(b?.text) ?? "",
              min:
                Number.isFinite(m) && m > 0
                  ? Math.min(60, Math.max(5, Math.round(m)))
                  : undefined,
            };
          },
        )
        .filter(
          (b: { hour: number; text: string }) =>
            Number.isInteger(b.hour) &&
            b.hour >= 9 &&
            b.hour <= 20 &&
            b.text &&
            !seen.has(b.hour) &&
            (seen.add(b.hour), true),
        )
        .sort((a: { hour: number }, b: { hour: number }) => a.hour - b.hour);
      return blocks.length
        ? Response.json({ blocks })
        : Response.json({ error: "none" }, { status: 200 });
    }

    if (kind === "daily") {
      const items = (Array.isArray(args.items) ? args.items : [])
        .filter((it: { title?: unknown }) => str(it?.title))
        .slice(0, 5)
        .map(
          (it: {
            title?: unknown;
            why?: unknown;
            subject?: unknown;
            priority?: unknown;
            estMin?: unknown;
          }) => {
            const m =
              typeof it.estMin === "number" ? it.estMin : Number(it.estMin);
            const p = it.priority;
            return {
              title: String(it.title).trim(),
              why: str(it.why),
              subject: str(it.subject),
              priority:
                p === "high" || p === "med" || p === "low" ? p : "med",
              estMin:
                Number.isFinite(m) && m > 0
                  ? Math.min(120, Math.round(m))
                  : undefined,
            };
          },
        );
      // Fit the estimates to the scheduled study budget: shave 5-minute chunks
      // off the biggest tasks until the total fits (floor of 5 min per task).
      if (budgetMin) {
        type Item = { estMin?: number };
        let total = (items as Item[]).reduce(
          (n: number, it: Item) => n + (it.estMin ?? 0),
          0,
        );
        while (total > budgetMin) {
          const biggest = (items as Item[]).reduce(
            (best: Item | null, it: Item) =>
              (it.estMin ?? 0) > (best?.estMin ?? 0) ? it : best,
            null,
          );
          if (!biggest?.estMin || biggest.estMin <= 5) break;
          biggest.estMin -= 5;
          total -= 5;
        }
      }
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

    if (kind === "session") {
      const steps = (Array.isArray(args.steps) ? args.steps : [])
        .filter((s: { title?: unknown }) => str(s?.title))
        .slice(0, 6)
        .map(
          (s: {
            title?: unknown;
            minutes?: unknown;
            kind?: unknown;
            from?: unknown;
            how?: unknown;
          }) => {
            const m =
              typeof s.minutes === "number" ? s.minutes : Number(s.minutes);
            return {
              title: String(s.title).trim(),
              minutes:
                Number.isFinite(m) && m > 0
                  ? Math.min(30, Math.max(5, Math.round(m / 5) * 5))
                  : 10,
              kind: ["read", "redo", "practice", "recap"].includes(
                s.kind as string,
              )
                ? (s.kind as string)
                : "practice",
              from: str(s.from),
              how: str(s.how),
            };
          },
        );
      return steps.length
        ? Response.json({ steps })
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
    } else if (kind === "focus") {
      suggestions = raw
        .filter((s: { topic?: unknown }) => str(s?.topic))
        .slice(0, 5)
        .map((s: { topic?: unknown; why?: unknown; subject?: unknown }) => ({
          topic: String(s.topic).trim(),
          why: str(s.why),
          subject: str(s.subject),
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
