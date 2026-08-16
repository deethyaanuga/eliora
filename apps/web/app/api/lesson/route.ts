import OpenAI from "openai";
import {
  ELIORA_SUMMARY_MODEL,
  lessonPrompt,
  type Lesson,
  type LessonRequest,
  type LessonSize,
  type LessonStep,
  type QuizQuestion,
} from "@eliora/shared";

// Lessons from your own material: the learner pastes notes or uploads a PDF /
// photo / text file, picks a size ("mini" ~5–10 min or "regular" ~20–30 min),
// and gets back a structured Lesson — teaching sections, key terms, and check
// questions — grounded in that material. Forced tool call so the output is
// always structured. Uses the summary model (gpt-4o-mini) — it supports
// vision, so it can read a photo of a handout or handwritten notes.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CHECK_SCHEMA = {
  type: "object",
  properties: {
    question: { type: "string" },
    options: { type: "array", items: { type: "string" } },
    answerIndex: {
      type: "integer",
      description: "0-based index of the one correct option.",
    },
    explanation: {
      type: "string",
      description: "One line on why the correct answer is right (shown as feedback).",
    },
    topic: { type: "string" },
  },
  required: ["question", "options", "answerIndex"],
} as const;

const LESSON_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "make_lesson",
    description:
      "Return the lesson built from the user's material as teach-then-check steps, plus key terms and a recap.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Short, motivating lesson title.",
        },
        intro: {
          type: "string",
          description:
            "1–2 sentences: what the learner will learn and why it matters.",
        },
        steps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              heading: { type: "string" },
              body: {
                type: "string",
                description:
                  "Short teaching text for this step as markdown (- bullets, " +
                  "**bold**, ==highlight== on the single most important phrase).",
              },
              check: {
                ...CHECK_SCHEMA,
                description:
                  "One multiple-choice question testing JUST this step, answered before advancing.",
              },
            },
            required: ["heading", "body", "check"],
          },
          description:
            "The teach-then-check steps, in learning order (simplest first).",
        },
        keyTerms: {
          type: "array",
          items: {
            type: "object",
            properties: {
              term: { type: "string" },
              definition: { type: "string" },
            },
            required: ["term", "definition"],
          },
          description:
            "Important terms from the material, each with a plain definition.",
        },
        recap: {
          type: "string",
          description: "1–2 sentence wrap-up shown after the last step.",
        },
        note: {
          type: "string",
          description: "ONE short, warm sentence about the lesson.",
        },
      },
      required: ["title", "steps"],
    },
  },
};

const str = (v: unknown) =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

export async function POST(req: Request) {
  let body: LessonRequest;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const size: LessonSize = body.size === "mini" ? "mini" : "regular";
  const text = (body.text ?? "").trim();
  const hasFile = !!body.fileBase64;
  if (!text && !hasFile) {
    return Response.json({ error: "missing_material" }, { status: 400 });
  }

  const intro = `Build a ${size} lesson from the material below.`;

  type UserContent =
    OpenAI.Chat.Completions.ChatCompletionUserMessageParam["content"];
  let userContent: UserContent;
  if (hasFile) {
    const media = body.fileMediaType ?? "";
    const b64 = body.fileBase64 ?? "";
    const parts: Exclude<UserContent, string> = [{ type: "text", text: intro }];
    if (media === "application/pdf") {
      parts.push({
        type: "file",
        file: {
          filename: body.fileName || "material.pdf",
          file_data: `data:application/pdf;base64,${b64}`,
        },
      });
    } else if (media.startsWith("image/")) {
      parts.push({
        type: "image_url",
        image_url: { url: `data:${media};base64,${b64}` },
      });
    } else {
      const decoded = Buffer.from(b64, "base64").toString("utf8");
      parts.push({ type: "text", text: `Material:\n${decoded.slice(0, 16000)}` });
    }
    if (text) parts.push({ type: "text", text: `Also:\n${text}` });
    userContent = parts;
  } else {
    userContent = `${intro}\n\nMaterial:\n${text.slice(0, 16000)}`;
  }

  try {
    const client = new OpenAI(); // reads OPENAI_API_KEY; throws if missing
    const completion = await client.chat.completions.create({
      model: ELIORA_SUMMARY_MODEL,
      max_completion_tokens: size === "mini" ? 2200 : 4500,
      messages: [
        { role: "system", content: lessonPrompt(size, body.profile) },
        { role: "user", content: userContent },
      ],
      tools: [LESSON_TOOL],
      tool_choice: { type: "function", function: { name: "make_lesson" } },
    });
    const call = completion.choices[0]?.message?.tool_calls?.[0];
    const args =
      call && "function" in call
        ? JSON.parse(call.function.arguments || "{}")
        : {};

    // Validate a nested check question; returns undefined if it's malformed so
    // the step can still teach even without a usable question.
    const parseCheck = (q: unknown): QuizQuestion | undefined => {
      if (!q || typeof q !== "object") return undefined;
      const c = q as {
        question?: unknown;
        options?: unknown;
        answerIndex?: unknown;
        explanation?: unknown;
        topic?: unknown;
      };
      if (
        !str(c.question) ||
        !Array.isArray(c.options) ||
        c.options.length < 2 ||
        typeof c.answerIndex !== "number" ||
        c.answerIndex < 0 ||
        c.answerIndex >= c.options.length
      )
        return undefined;
      return {
        question: String(c.question).trim(),
        options: c.options.map((o) => String(o).trim()),
        answerIndex: c.answerIndex,
        explanation: str(c.explanation),
        topic: str(c.topic),
      };
    };

    const steps: LessonStep[] = (Array.isArray(args.steps) ? args.steps : [])
      .filter((s: { heading?: unknown; body?: unknown }) =>
        str(s?.heading) && str(s?.body),
      )
      .slice(0, 8)
      .map((s: { heading?: unknown; body?: unknown; check?: unknown }) => ({
        heading: String(s.heading).trim(),
        body: String(s.body).trim(),
        check: parseCheck(s.check),
      }));
    const keyTerms = (Array.isArray(args.keyTerms) ? args.keyTerms : [])
      .filter((t: { term?: unknown; definition?: unknown }) =>
        str(t?.term) && str(t?.definition),
      )
      .slice(0, 20)
      .map((t: { term?: unknown; definition?: unknown }) => ({
        term: String(t.term).trim(),
        definition: String(t.definition).trim(),
      }));

    const lesson: Lesson = {
      title: str(args.title) ?? "Your lesson",
      size,
      minutes: size === "mini" ? 8 : 25,
      intro: str(args.intro) ?? "",
      steps,
      keyTerms,
      recap: str(args.recap),
      note: str(args.note),
    };
    if (steps.length === 0) {
      return Response.json({
        lesson: {
          ...lesson,
          note:
            lesson.note ||
            "I couldn't make a lesson from that — try uploading a bit more material, or a clearer photo.",
        },
      });
    }
    return Response.json({ lesson });
  } catch {
    return Response.json(
      { error: "Couldn't build a lesson right now — try again." },
      { status: 200 },
    );
  }
}
