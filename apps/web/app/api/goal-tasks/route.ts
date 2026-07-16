import OpenAI from "openai";
import {
  ELIORA_SUMMARY_MODEL,
  goalTasksPrompt,
  type LearnerProfile,
  type SmartGoal,
} from "@eliora/shared";

// Breaks a SMART goal into a short ordered checklist of steps to achieve it.
// Returns { tasks: string[] }. Forces a tool call so the output is always a
// clean list (no model variance about whether/how to format it).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAKE_TASKS_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "make_tasks",
    description: "Return the ordered checklist of steps to achieve the goal.",
    parameters: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          items: { type: "string" },
          description: "3–6 short, ordered, concrete step titles.",
        },
      },
      required: ["tasks"],
    },
  },
};

type GoalTasksRequest = {
  goal: Partial<SmartGoal>;
  profile?: LearnerProfile;
};

export async function POST(req: Request) {
  let body: GoalTasksRequest;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const g = body.goal ?? {};
  const specific = (g.specific ?? "").trim();
  const headline = (g.statement ?? "").trim() || specific;
  if (!headline) {
    return Response.json({ error: "missing_goal" }, { status: 400 });
  }

  const today = new Date().toISOString().slice(0, 10);
  const detail = [
    `Goal: ${headline}`,
    g.measurable?.trim() ? `Measured by: ${g.measurable.trim()}` : "",
    g.subject?.trim() ? `Subject: ${g.subject.trim()}` : "",
    g.timeBound ? `Target date: ${g.timeBound} (today is ${today})` : "",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const client = new OpenAI(); // reads OPENAI_API_KEY; throws if missing
    const completion = await client.chat.completions.create({
      model: ELIORA_SUMMARY_MODEL,
      max_completion_tokens: 500,
      messages: [
        { role: "system", content: goalTasksPrompt(body.profile) },
        { role: "user", content: detail },
      ],
      tools: [MAKE_TASKS_TOOL],
      tool_choice: {
        type: "function",
        function: { name: "make_tasks" },
      },
    });
    const call = completion.choices[0]?.message?.tool_calls?.[0];
    const args =
      call && "function" in call
        ? JSON.parse(call.function.arguments || "{}")
        : {};
    const tasks: string[] = (args.tasks ?? [])
      .map((t: unknown) => String(t).trim())
      .filter((t: string) => t.length > 0)
      .slice(0, 8);
    if (!tasks.length) {
      return Response.json(
        { error: "Couldn't break that down — try again." },
        { status: 200 },
      );
    }
    return Response.json({ tasks });
  } catch {
    return Response.json(
      { error: "Couldn't break that down — try again." },
      { status: 200 },
    );
  }
}
