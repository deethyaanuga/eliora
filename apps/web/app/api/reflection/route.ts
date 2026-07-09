import OpenAI from "openai";
import {
  ELIORA_SUMMARY_MODEL,
  reflectionPrompt,
  reflectionSummaryPrompt,
  type LearnerProfile,
} from "@eliora/shared";

// Turns an end-of-semester reflection survey (grades/GPA + how it felt + wins /
// challenges / what to change) into a warm reflection + a few forward focuses.
// Returns { message, focus: string[] }. Forces a tool call for clean output.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REFLECT_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "give_reflection",
    description: "Return a warm end-of-semester reflection.",
    parameters: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "3–4 warm, specific sentences reflecting on the semester.",
        },
        focus: {
          type: "array",
          description: "2–4 concrete focus items for next semester.",
          items: { type: "string" },
        },
      },
      required: ["message", "focus"],
    },
  },
};

type Grade = { title?: unknown; grade?: unknown };
type PastReflection = { yearLabel?: unknown; gpa?: unknown; message?: unknown };
type ReflectionRequest = {
  yearLabel?: string;
  career?: string;
  gpa?: number;
  grades?: Grade[];
  feel?: string;
  wins?: string;
  hard?: string;
  change?: string;
  note?: string;
  // Summary mode: synthesize several past reflections into one journey summary.
  summary?: boolean;
  reflections?: PastReflection[];
  profile?: LearnerProfile;
};

export async function POST(req: Request) {
  let body: ReflectionRequest;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const isSummary = body.summary === true;
  let detail: string;
  if (isSummary) {
    // Summary mode: fold every past reflection into one journey overview.
    const past = (Array.isArray(body.reflections) ? body.reflections : [])
      .filter((r) => String(r?.message ?? "").trim())
      .map((r) => {
        const label = String(r.yearLabel ?? "").trim() || "A semester";
        const gpa =
          typeof r.gpa === "number" ? ` (GPA ${r.gpa.toFixed(2)})` : "";
        return `— ${label}${gpa}: ${String(r.message).trim()}`;
      });
    detail = [
      body.career?.trim() ? `Career goal: ${body.career.trim()}` : "",
      past.length
        ? `Their semester reflections so far (oldest first):\n${past.join("\n")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
  } else {
    const grades = (Array.isArray(body.grades) ? body.grades : [])
      .filter((g) => String(g?.title ?? "").trim())
      .map(
        (g) =>
          `${String(g.title).trim()}${
            String(g.grade ?? "").trim() ? `: ${String(g.grade).trim()}` : ""
          }`,
      );
    detail = [
      body.yearLabel?.trim() ? `Semester / year: ${body.yearLabel.trim()}` : "",
      body.career?.trim() ? `Career goal: ${body.career.trim()}` : "",
      typeof body.gpa === "number" ? `GPA this year: ${body.gpa.toFixed(2)}` : "",
      grades.length ? `Grades: ${grades.join(", ")}` : "",
      body.feel?.trim() ? `How it felt: ${body.feel.trim()}` : "",
      body.wins?.trim() ? `What went well: ${body.wins.trim()}` : "",
      body.hard?.trim() ? `What was hardest: ${body.hard.trim()}` : "",
      body.change?.trim()
        ? `What they want to do differently: ${body.change.trim()}`
        : "",
      body.note?.trim() ? `In their words: ${body.note.trim()}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  try {
    const client = new OpenAI(); // reads OPENAI_API_KEY; throws if missing
    const completion = await client.chat.completions.create({
      model: ELIORA_SUMMARY_MODEL,
      max_completion_tokens: 500,
      messages: [
        {
          role: "system",
          content: isSummary
            ? reflectionSummaryPrompt(body.profile)
            : reflectionPrompt(body.profile),
        },
        {
          role: "user",
          content:
            detail ||
            (isSummary ? "Summarize my journey." : "Reflect on my semester."),
        },
      ],
      tools: [REFLECT_TOOL],
      tool_choice: { type: "function", function: { name: "give_reflection" } },
    });
    const call = completion.choices[0]?.message?.tool_calls?.[0];
    const args =
      call && "function" in call
        ? JSON.parse(call.function.arguments || "{}")
        : {};
    const message = String(args.message ?? "").trim();
    const focus = (Array.isArray(args.focus) ? (args.focus as unknown[]) : [])
      .filter((f) => typeof f === "string" && f.trim())
      .map((f) => (f as string).trim())
      .slice(0, 4);
    if (!message) {
      return Response.json(
        { error: "Couldn't write that reflection — try again." },
        { status: 200 },
      );
    }
    return Response.json({ message, focus });
  } catch {
    return Response.json(
      { error: "Couldn't write that reflection — try again." },
      { status: 200 },
    );
  }
}
