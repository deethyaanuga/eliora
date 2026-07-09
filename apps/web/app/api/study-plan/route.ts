import OpenAI from "openai";
import {
  ELIORA_SUMMARY_MODEL,
  studyPlanPrompt,
  type LearnerProfile,
} from "@eliora/shared";

// Turns a short study-plan survey into an ordered list of small milestones (with
// checkpoints). Returns { milestones: [{title, detail?, checkpoint?}] }. Forces a
// tool call so the output is always a clean plan.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAKE_PLAN_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "make_plan",
    description: "Return the study plan as ordered milestones.",
    parameters: {
      type: "object",
      properties: {
        milestones: {
          type: "array",
          description: "10–14 small, ordered study milestones.",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              detail: {
                type: "string",
                description:
                  "One-line detail stating what to do AND the time, e.g. \"Spend about 10 minutes …\".",
              },
              checkpoint: {
                type: "boolean",
                description: "True for a review/quiz checkpoint step.",
              },
            },
            required: ["title", "detail"],
          },
        },
      },
      required: ["milestones"],
    },
  },
};

type RawM = { title?: unknown; detail?: unknown; checkpoint?: unknown };

type StudyPlanRequest = {
  subject?: string;
  working?: string; // what they're working on / stuck on
  goal?: string; // what they want to accomplish
  deadline?: string; // YYYY-MM-DD
  learningStyle?: string;
  time?: string; // how much time per week
  profile?: LearnerProfile;
};

export async function POST(req: Request) {
  let body: StudyPlanRequest;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const subject = (body.subject ?? "").trim() || (body.profile?.klass ?? "").trim();
  if (!subject) {
    return Response.json({ error: "missing_subject" }, { status: 400 });
  }

  const today = new Date().toISOString().slice(0, 10);
  const style =
    (body.learningStyle ?? "").trim() ||
    (body.profile?.learningStyle ?? "").trim();
  const detail = [
    `Subject / class: ${subject}`,
    body.working?.trim() ? `Working on / stuck on: ${body.working.trim()}` : "",
    body.goal?.trim() ? `Goal — what to accomplish: ${body.goal.trim()}` : "",
    body.deadline?.trim()
      ? `Deadline: ${body.deadline.trim()} (today is ${today})`
      : "",
    style ? `Likes to learn by: ${style}` : "",
    body.time?.trim() ? `Time available: ${body.time.trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const client = new OpenAI(); // reads OPENAI_API_KEY; throws if missing
    const completion = await client.chat.completions.create({
      model: ELIORA_SUMMARY_MODEL,
      max_completion_tokens: 1200,
      messages: [
        { role: "system", content: studyPlanPrompt(body.profile) },
        { role: "user", content: detail },
      ],
      tools: [MAKE_PLAN_TOOL],
      tool_choice: { type: "function", function: { name: "make_plan" } },
    });
    const call = completion.choices[0]?.message?.tool_calls?.[0];
    const args =
      call && "function" in call
        ? JSON.parse(call.function.arguments || "{}")
        : {};
    // Prefix each step with the subject so plans for different subjects stay
    // distinct (and don't collide when merged into one list).
    const prefix = `${subject}: `;
    const milestones = (Array.isArray(args.milestones) ? (args.milestones as RawM[]) : [])
      .filter((m) => String(m?.title ?? "").trim())
      .slice(0, 16)
      .map((m) => {
        const raw = String(m.title).trim();
        const title = raw.toLowerCase().startsWith(subject.toLowerCase())
          ? raw
          : prefix + raw;
        return {
          title,
          detail: m.detail ? String(m.detail).trim() || undefined : undefined,
          checkpoint: m.checkpoint === true || undefined,
        };
      });
    if (!milestones.length) {
      return Response.json(
        { error: "Couldn't build that plan — try again." },
        { status: 200 },
      );
    }
    return Response.json({ milestones });
  } catch {
    return Response.json(
      { error: "Couldn't build that plan — try again." },
      { status: 200 },
    );
  }
}
