import OpenAI from "openai";
import {
  BREAKDOWN_MAX_STEPS,
  breakdownPrompt,
  ELIORA_SUMMARY_MODEL,
  type BreakdownRequest,
  type TaskBreakdown,
  type TaskStep,
} from "@eliora/shared";

// Breaks ONE thing on the learner's plate into the steps it actually takes,
// each with an honest time estimate. Used by the "Break it down" button that
// sits on assignments, priority items and events. Forces a tool call so the
// shape is always the same — the UI renders these as tickable checkboxes.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BREAKDOWN_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "break_it_down",
    description:
      "Return the ordered steps this task actually takes, each with honest minutes.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Short title for the task being broken down.",
        },
        steps: {
          type: "array",
          description: `3–${BREAKDOWN_MAX_STEPS} steps, in the order to do them.`,
          items: {
            type: "object",
            properties: {
              title: {
                type: "string",
                description: "Action-first step title, one sitting.",
              },
              estMin: {
                type: "integer",
                description: "Honest minutes for this step, a multiple of 5.",
              },
              detail: {
                type: "string",
                description:
                  "One short line on what it means / when to stop. Omit when the title is enough.",
              },
            },
            required: ["title", "estMin"],
          },
        },
        firstMove: {
          type: "string",
          description: "The tiniest action for the next five minutes.",
        },
        note: { type: "string", description: "One warm sentence from Eliora." },
      },
      required: ["title", "steps"],
    },
  },
};

const str = (v: unknown) =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;
const iso = (v: unknown) =>
  typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined;

// Clamp to a sane sitting: 5 minutes at the low end, 120 at the high end, and
// always a round multiple of 5 so the totals read cleanly.
function minutes(v: unknown): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : 0;
  if (n <= 0) return 15;
  return Math.min(Math.max(5, Math.round(n / 5) * 5), 120);
}

export async function POST(req: Request) {
  let body: BreakdownRequest;
  try {
    body = (await req.json()) as BreakdownRequest;
  } catch {
    return Response.json({ error: "Bad request." }, { status: 400 });
  }

  const task = (body.task ?? "").trim();
  if (!task) {
    return Response.json(
      { error: "Tell me what you have to do first." },
      { status: 200 },
    );
  }

  const today = iso(body.today) ?? new Date().toISOString().slice(0, 10);
  const due = iso(body.due);
  const est =
    typeof body.minutes === "number" && body.minutes > 0
      ? Math.round(body.minutes)
      : undefined;

  const detail = [
    `What I have to do: ${task}`,
    str(body.subject) ? `Subject: ${str(body.subject)}` : "",
    due ? `Due: ${due}` : "",
    est ? `My own estimate: about ${est} minutes` : "",
    str(body.context) ? `More about it:\n${str(body.context)!.slice(0, 4000)}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const client = new OpenAI(); // reads OPENAI_API_KEY; throws if missing
    const completion = await client.chat.completions.create({
      model: ELIORA_SUMMARY_MODEL,
      max_completion_tokens: 1200,
      messages: [
        {
          role: "system",
          content: breakdownPrompt({ ...body, task, today, due, minutes: est }),
        },
        { role: "user", content: detail },
      ],
      tools: [BREAKDOWN_TOOL],
      tool_choice: {
        type: "function",
        function: { name: "break_it_down" },
      },
    });

    const call = completion.choices[0]?.message?.tool_calls?.[0];
    const args = JSON.parse(
      (call && "function" in call ? call.function.arguments : "") || "{}",
    );

    const steps: TaskStep[] = (Array.isArray(args.steps) ? args.steps : [])
      .map((s: { title?: unknown; estMin?: unknown; detail?: unknown }) => {
        const title = str(s?.title);
        if (!title) return null;
        return {
          title,
          estMin: minutes(s?.estMin),
          detail: str(s?.detail),
          done: false,
        };
      })
      .filter(Boolean)
      .slice(0, BREAKDOWN_MAX_STEPS) as TaskStep[];

    if (!steps.length) {
      return Response.json(
        {
          error:
            str(args.note) || "I couldn't break that one down — try again?",
        },
        { status: 200 },
      );
    }

    const breakdown: TaskBreakdown = {
      title: str(args.title) || task.slice(0, 80),
      steps,
      totalMin: steps.reduce((n, s) => n + s.estMin, 0),
      firstMove: str(args.firstMove),
      note: str(args.note),
    };

    return Response.json({ breakdown });
  } catch {
    return Response.json(
      { error: "Sorry, I couldn't break that down. Please try again." },
      { status: 200 },
    );
  }
}
