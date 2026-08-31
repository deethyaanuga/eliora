import OpenAI from "openai";
import {
  ELIORA_SUMMARY_MODEL,
  PRIORITY_DEFAULT_MIN_PER_DAY,
  PRIORITY_HORIZON_DAYS,
  prioritiesPrompt,
  type PriorityBlock,
  type PriorityItem,
  type PriorityLevel,
  type PriorityPlan,
  type PriorityRequest,
  type PrioritySlot,
} from "@eliora/shared";

// The priority list: takes everything the learner has on their plate, ranks it
// honestly, works out what each item actually NEEDS, and lays those minutes out
// across real days. Forced tool call so the client always gets the same shape.
// gpt-4o-mini like the other forced-tool endpoints.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PLAN_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "rank_and_schedule",
    description:
      "Rank every item by priority, break down what each one needs, then spread the work across days.",
    parameters: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "1–2 sentences on the shape of the workload.",
        },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: {
                type: "string",
                description: "The id you were given for this item. Copy exactly.",
              },
              priority: { type: "string", enum: ["high", "med", "low"] },
              why: {
                type: "string",
                description:
                  "One line: the real reason it ranks here (deadline, exam, size, their worry).",
              },
              needs: {
                type: "array",
                items: { type: "string" },
                description:
                  "2–5 concrete sub-steps this item takes, in order, each starting with a verb.",
              },
              estMin: {
                type: "integer",
                description: "Honest total minutes, a multiple of 5.",
              },
              planDate: {
                type: "string",
                description: "YYYY-MM-DD — the day to do it.",
              },
              startBy: {
                type: "string",
                description:
                  "YYYY-MM-DD — start by here so it isn't a last-night scramble.",
              },
            },
            required: ["id", "priority", "why", "needs", "estMin", "planDate"],
          },
        },
        schedule: {
          type: "array",
          description: "One entry per working day, soonest first.",
          items: {
            type: "object",
            properties: {
              date: { type: "string", description: "YYYY-MM-DD" },
              slots: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string", description: "The item's id." },
                    min: { type: "integer", description: "Minutes in this block." },
                    focus: {
                      type: "string",
                      description: "Which sub-step this block is for.",
                    },
                  },
                  required: ["id", "min"],
                },
              },
            },
            required: ["date", "slots"],
          },
        },
        warning: {
          type: "string",
          description:
            "Said out loud only when the work genuinely doesn't fit the time available.",
        },
        note: { type: "string", description: "One warm sentence from Eliora." },
      },
      required: ["summary", "items", "schedule"],
    },
  },
};

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const str = (v: unknown) =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;
const iso = (v: unknown) => {
  const s = str(v);
  return s && ISO.test(s) ? s : undefined;
};
const LEVELS: PriorityLevel[] = ["high", "med", "low"];
const RANK: Record<PriorityLevel, number> = { high: 0, med: 1, low: 2 };

export async function POST(req: Request) {
  let body: PriorityRequest;
  try {
    body = (await req.json()) as PriorityRequest;
  } catch {
    return Response.json({ error: "Bad request." }, { status: 400 });
  }

  const today = iso(body.today) ?? new Date().toISOString().slice(0, 10);
  // Only rank what's real: an item needs an id and a title, and we cap the pile
  // so one very long list can't blow the token budget.
  const inputs = (Array.isArray(body.items) ? body.items : [])
    .filter((i) => str(i?.id) && str(i?.title))
    .slice(0, 30)
    .map((i) => ({
      id: i.id.trim(),
      title: i.title.trim(),
      subject: str(i.subject),
      due: iso(i.due),
      kind: i.kind,
      concern: str(i.concern),
      estMin:
        typeof i.estMin === "number" && i.estMin > 0
          ? Math.round(i.estMin)
          : undefined,
    }));

  if (!inputs.length) {
    return Response.json(
      { error: "Add what's on your plate first — then I'll sort it out." },
      { status: 200 },
    );
  }

  const byId = new Map(inputs.map((i) => [i.id, i]));
  const minutesPerDay =
    typeof body.minutesPerDay === "number" && body.minutesPerDay > 0
      ? Math.round(body.minutesPerDay)
      : PRIORITY_DEFAULT_MIN_PER_DAY;
  const busyDates = (Array.isArray(body.busyDates) ? body.busyDates : [])
    .map((d) => iso(d))
    .filter(Boolean) as string[];
  const horizon = new Date(
    `${today}T00:00:00Z`,
  );
  horizon.setUTCDate(horizon.getUTCDate() + PRIORITY_HORIZON_DAYS);
  const horizonISO = horizon.toISOString().slice(0, 10);

  const plate = inputs
    .map((i) =>
      [
        `- id: ${i.id}`,
        `  what: ${i.title}`,
        i.kind ? `  type: ${i.kind}` : "",
        i.subject ? `  subject: ${i.subject}` : "",
        i.due ? `  due: ${i.due}` : "  due: no deadline given",
        i.estMin ? `  their own estimate: ${i.estMin} min` : "",
        i.concern ? `  they're worried about: ${i.concern}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n");

  try {
    const client = new OpenAI();
    const completion = await client.chat.completions.create({
      model: ELIORA_SUMMARY_MODEL,
      max_completion_tokens: 3000,
      messages: [
        {
          role: "system",
          content: prioritiesPrompt({
            ...body,
            items: inputs,
            today,
            minutesPerDay,
            busyDates,
          }),
        },
        {
          role: "user",
          content: `Here's everything on my plate:\n${plate}\n\nSchedule me between ${today} and ${horizonISO}.`,
        },
      ],
      tools: [PLAN_TOOL],
      tool_choice: { type: "function", function: { name: "rank_and_schedule" } },
    });

    const call = completion.choices[0]?.message?.tool_calls?.[0];
    const args = JSON.parse(
      (call && "function" in call ? call.function.arguments : "") || "{}",
    );

    // Titles and due dates come from the learner's own list, never the model —
    // it only supplies the judgement. An unknown id means a hallucinated item.
    const items: PriorityItem[] = (Array.isArray(args.items) ? args.items : [])
      .filter((it: { id?: unknown }) => byId.has(str(it?.id) ?? ""))
      .map((it: {
        id: string;
        priority?: unknown;
        why?: unknown;
        needs?: unknown;
        estMin?: unknown;
        planDate?: unknown;
        startBy?: unknown;
      }) => {
        const src = byId.get(it.id.trim())!;
        const level = LEVELS.includes(it.priority as PriorityLevel)
          ? (it.priority as PriorityLevel)
          : "med";
        const est =
          typeof it.estMin === "number" && it.estMin > 0
            ? Math.min(Math.max(5, Math.round(it.estMin / 5) * 5), 600)
            : (src.estMin ?? 30);
        // Clamp the day into the window we asked for: never in the past, never
        // past the horizon, never after the thing is due.
        let plan = iso(it.planDate);
        if (plan && plan < today) plan = today;
        if (plan && plan > horizonISO) plan = horizonISO;
        if (plan && src.due && plan > src.due) plan = src.due;
        return {
          id: src.id,
          title: src.title,
          priority: level,
          why: str(it.why) || "",
          needs: (Array.isArray(it.needs) ? it.needs : [])
            .map((n: unknown) => str(n))
            .filter(Boolean)
            .slice(0, 5) as string[],
          estMin: est,
          planDate: plan,
          startBy: iso(it.startBy),
        };
      });

    if (!items.length) {
      return Response.json(
        {
          error:
            str(args.note) ||
            "I couldn't rank that yet — try adding a due date or two.",
        },
        { status: 200 },
      );
    }

    const known = new Map(items.map((i) => [i.id, i]));
    const schedule: PriorityBlock[] = (
      Array.isArray(args.schedule) ? args.schedule : []
    )
      .map((b: { date?: unknown; slots?: unknown }) => {
        const date = iso(b?.date);
        if (!date || date < today || date > horizonISO) return null;
        if (busyDates.includes(date)) return null;
        const slots: PrioritySlot[] = (Array.isArray(b.slots) ? b.slots : [])
          .filter((s: { id?: unknown }) => {
            const id = str(s?.id) ?? "";
            if (!known.has(id)) return false;
            // Working on something the day after it's due helps nobody — and
            // for an exam, revising after the paper is worse than useless.
            const due = byId.get(id)?.due;
            return !due || date <= due;
          })
          .map((s: { id: string; min?: unknown; focus?: unknown }) => {
            const item = known.get(s.id.trim())!;
            return {
              id: item.id,
              title: item.title,
              min:
                typeof s.min === "number" && s.min > 0
                  ? Math.min(Math.round(s.min), item.estMin)
                  : item.estMin,
              focus: str(s.focus),
            };
          });
        if (!slots.length) return null;
        return {
          date,
          slots,
          totalMin: slots.reduce((n, s) => n + s.min, 0),
        };
      })
      .filter(Boolean)
      .sort((a: PriorityBlock, b: PriorityBlock) => a.date.localeCompare(b.date))
      .slice(0, PRIORITY_HORIZON_DAYS);

    // The day an item is worked on is what lands on the learner's calendar, so
    // don't lose it when the model names the day only in the schedule.
    for (const block of schedule)
      for (const slot of block.slots) {
        const item = known.get(slot.id);
        if (item && !item.planDate) item.planDate = block.date;
      }
    items.sort(
      (a, b) =>
        RANK[a.priority] - RANK[b.priority] ||
        (a.planDate ?? "9999").localeCompare(b.planDate ?? "9999"),
    );

    const plan: PriorityPlan = {
      summary: str(args.summary) || "",
      items,
      schedule,
      warning: str(args.warning),
      note: str(args.note),
    };

    return Response.json({ plan });
  } catch {
    return Response.json(
      { error: "Sorry, I couldn't sort that out. Please try again." },
      { status: 200 },
    );
  }
}
