import OpenAI from "openai";
import {
  ELIORA_CHAT_MODEL,
  feedbackSystemPrompt,
  type LearnerProfile,
} from "@eliora/shared";

// Gives structured, quality-based feedback on a student's assignment (pasted text
// or an uploaded PDF/image/text file). Returns { feedback: {overall, strengths[],
// improve[{point,how}], score?, grade?, nextStep?} }. Forced tool for clean output.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FEEDBACK_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "give_feedback",
    description: "Return warm, specific quality feedback on the assignment.",
    parameters: {
      type: "object",
      properties: {
        overall: {
          type: "string",
          description: "1–2 sentence overall impression of the work.",
        },
        strengths: {
          type: "array",
          items: { type: "string" },
          description: "What the student did well.",
        },
        improve: {
          type: "array",
          items: {
            type: "object",
            properties: {
              point: { type: "string", description: "What to improve." },
              how: { type: "string", description: "How to improve it." },
            },
            required: ["point"],
          },
          description: "The most important things to improve, each with a how.",
        },
        issues: {
          type: "array",
          description:
            "Specific line-level writing issues found (like a proofreader): grammar, spelling, punctuation, word choice, and style.",
          items: {
            type: "object",
            properties: {
              type: {
                type: "string",
                enum: [
                  "grammar",
                  "spelling",
                  "punctuation",
                  "word choice",
                  "style",
                ],
              },
              text: {
                type: "string",
                description: "The exact problematic phrase from their work.",
              },
              suggestion: {
                type: "string",
                description: "How to fix it (a corrected version or advice).",
              },
            },
            required: ["type", "suggestion"],
          },
        },
        rationale: {
          type: "string",
          description:
            "1–2 sentences justifying the score/grade: the specific evidence in " +
            "the work (and the rubric, if one was given) that drives the number. " +
            "Decide this BEFORE the score.",
        },
        score: {
          type: "integer",
          description:
            "Rough quality estimate 0–100 (a friendly gauge), following from the " +
            "rationale.",
        },
        grade: { type: "string", description: "Matching letter grade (A–F)." },
        nextStep: {
          type: "string",
          description: "ONE tiny next step to improve it now.",
        },
      },
      required: ["overall"],
    },
  },
};

type UploadDoc = { base64?: string; mediaType?: string; name?: string };
type FeedbackRequest = {
  text?: string; // the student's work
  prompt?: string; // the assignment instructions / rubric
  subject?: string;
  doc?: UploadDoc; // uploaded assignment file
  profile?: LearnerProfile;
};

const num = (v: unknown) =>
  typeof v === "number" && isFinite(v) ? Math.max(0, Math.min(100, v)) : undefined;
const str = (v: unknown) =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

export async function POST(req: Request) {
  let body: FeedbackRequest;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const work = (body.text ?? "").trim();
  const hasDoc = !!body.doc?.base64;
  if (!work && !hasDoc) {
    return Response.json({ error: "missing_work" }, { status: 400 });
  }

  const intro = [
    body.subject?.trim() ? `Subject: ${body.subject.trim()}` : "",
    body.prompt?.trim()
      ? `The assignment / rubric was:\n${body.prompt.trim()}`
      : "",
    "Give feedback on the quality of the student's work below.",
  ]
    .filter(Boolean)
    .join("\n");

  type UserContent =
    OpenAI.Chat.Completions.ChatCompletionUserMessageParam["content"];
  let userContent: UserContent;
  const d = body.doc;
  if (hasDoc && d) {
    const media = d.mediaType ?? "";
    const parts: Exclude<UserContent, string> = [{ type: "text", text: intro }];
    if (media === "application/pdf") {
      parts.push({
        type: "file",
        file: {
          filename: d.name || "assignment.pdf",
          file_data: `data:application/pdf;base64,${d.base64}`,
        },
      });
    } else if (media.startsWith("image/")) {
      parts.push({
        type: "image_url",
        image_url: { url: `data:${media};base64,${d.base64}` },
      });
    } else {
      const text = Buffer.from(d.base64 || "", "base64").toString("utf8");
      parts.push({ type: "text", text: `Their work:\n${text.slice(0, 12000)}` });
    }
    if (work) parts.push({ type: "text", text: `Also / instead:\n${work}` });
    userContent = parts;
  } else {
    userContent = `${intro}\n\nTheir work:\n${work}`;
  }

  try {
    const client = new OpenAI(); // reads OPENAI_API_KEY; throws if missing
    const completion = await client.chat.completions.create({
      // Grading is reasoning-heavy, so use the stronger chat model (a reasoning
      // model) rather than the summary model. Its hidden reasoning tokens also
      // draw from max_completion_tokens, so the budget is raised.
      model: ELIORA_CHAT_MODEL,
      max_completion_tokens: 2500,
      messages: [
        { role: "system", content: feedbackSystemPrompt(body.profile) },
        { role: "user", content: userContent },
      ],
      tools: [FEEDBACK_TOOL],
      tool_choice: { type: "function", function: { name: "give_feedback" } },
    });
    const call = completion.choices[0]?.message?.tool_calls?.[0];
    const args =
      call && "function" in call
        ? JSON.parse(call.function.arguments || "{}")
        : {};
    const overall = str(args.overall);
    if (!overall) {
      return Response.json(
        { error: "Couldn't read that — try pasting the full work." },
        { status: 200 },
      );
    }
    const feedback = {
      overall,
      strengths: (Array.isArray(args.strengths) ? args.strengths : [])
        .map((s: unknown) => str(s))
        .filter(Boolean)
        .slice(0, 6),
      improve: (Array.isArray(args.improve) ? args.improve : [])
        .filter((it: { point?: unknown }) => str(it?.point))
        .slice(0, 6)
        .map((it: { point?: unknown; how?: unknown }) => ({
          point: String(it.point).trim(),
          how: str(it.how),
        })),
      issues: (Array.isArray(args.issues) ? args.issues : [])
        .filter((it: { suggestion?: unknown }) => str(it?.suggestion))
        .slice(0, 15)
        .map((it: { type?: unknown; text?: unknown; suggestion?: unknown }) => ({
          type: str(it.type) ?? "style",
          text: str(it.text),
          suggestion: String(it.suggestion).trim(),
        })),
      rationale: str(args.rationale),
      score: num(args.score),
      grade: str(args.grade),
      nextStep: str(args.nextStep),
    };
    return Response.json({ feedback });
  } catch {
    return Response.json(
      { error: "Couldn't get feedback right now — try again." },
      { status: 200 },
    );
  }
}
