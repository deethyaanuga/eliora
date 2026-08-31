import OpenAI from "openai";
import {
  ELIORA_SUMMARY_MODEL,
  helpPrompt,
  type HelpAnswer,
  type HelpMode,
  type HelpRequest,
  type HelpStep,
  type QuizQuestion,
} from "@eliora/shared";

// The help desk: one endpoint behind three doors — homework help (guided, never
// the answer), test prep (a dated study plan), and learning a topic from zero.
// Forced tool call so the client always gets the same structured shape back.
// gpt-4o-mini like the other forced-tool endpoints (a reasoning model spends its
// budget thinking and emits no tool call), and it reads photos/PDFs too.
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
      description: "One line on why the correct answer is right.",
    },
    topic: { type: "string" },
  },
  required: ["question", "options", "answerIndex"],
} as const;

const HELP_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "give_help",
    description:
      "Return the help as ordered do-able steps, plus key points, a worked example and quick checks.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title for this help." },
        summary: {
          type: "string",
          description: "1–2 sentences: what you're going to do together.",
        },
        steps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "The step, in a few words." },
              detail: {
                type: "string",
                description: "What to do and why, in plain words (markdown ok).",
              },
              hint: {
                type: "string",
                description:
                  "A concrete nudge, hidden until the learner asks for it.",
              },
            },
            required: ["title", "detail"],
          },
        },
        keyPoints: {
          type: "array",
          items: { type: "string" },
          description: "2–5 one-line things worth remembering.",
        },
        example: {
          type: "object",
          description:
            "A worked example of a SIMILAR problem (never the learner's own answer).",
          properties: {
            title: { type: "string" },
            body: { type: "string" },
          },
          required: ["title", "body"],
        },
        checks: {
          type: "array",
          items: CHECK_SCHEMA,
          description: "1–3 quick multiple-choice checks on the idea.",
        },
        nextStep: {
          type: "string",
          description: "ONE tiny thing to do in the next five minutes.",
        },
        note: { type: "string", description: "One warm sentence from Eliora." },
      },
      required: ["title", "summary", "steps"],
    },
  },
};

const MODES: HelpMode[] = ["homework", "test", "learn"];
const str = (v: unknown) =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

function normalizeChecks(raw: unknown): QuizQuestion[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (q: { question?: string; options?: unknown; answerIndex?: unknown }) =>
        str(q?.question) &&
        Array.isArray(q.options) &&
        q.options.length >= 2 &&
        typeof q.answerIndex === "number" &&
        q.answerIndex >= 0 &&
        q.answerIndex < q.options.length,
    )
    .slice(0, 3)
    .map((q: {
      question: string;
      options: unknown[];
      answerIndex: number;
      explanation?: unknown;
      topic?: unknown;
    }) => ({
      question: q.question.trim(),
      options: q.options.map(String),
      answerIndex: q.answerIndex,
      explanation: str(q.explanation),
      topic: str(q.topic),
    }));
}

export async function POST(req: Request) {
  let body: HelpRequest;
  try {
    body = (await req.json()) as HelpRequest;
  } catch {
    return Response.json({ error: "Bad request." }, { status: 400 });
  }

  const mode: HelpMode = MODES.includes(body.mode) ? body.mode : "homework";
  const ask = (body.ask ?? "").trim();
  const hasFile = !!body.fileBase64;
  if (!ask && !hasFile) {
    return Response.json(
      {
        error:
          mode === "test"
            ? "Tell me what the test covers first."
            : mode === "learn"
              ? "Tell me what you want to understand first."
              : "Paste the question you're stuck on first.",
      },
      { status: 200 },
    );
  }

  const intro =
    mode === "homework"
      ? `Here's what I'm stuck on:\n${ask}`
      : mode === "test"
        ? `Here's what my test covers:\n${ask}`
        : `Here's what I want to understand:\n${ask}`;

  type UserContent =
    OpenAI.Chat.Completions.ChatCompletionUserMessageParam["content"];
  let userContent: UserContent = intro;
  if (hasFile) {
    const media = body.fileMediaType ?? "";
    const parts: Exclude<UserContent, string> = [
      { type: "text", text: ask ? intro : "Help me with the attached work." },
    ];
    if (media === "application/pdf") {
      parts.push({
        type: "file",
        file: {
          filename: body.fileName || "material.pdf",
          file_data: `data:application/pdf;base64,${body.fileBase64}`,
        },
      });
    } else if (media.startsWith("image/")) {
      parts.push({
        type: "image_url",
        image_url: { url: `data:${media};base64,${body.fileBase64}` },
      });
    } else {
      const text = Buffer.from(body.fileBase64 || "", "base64").toString("utf8");
      parts.push({ type: "text", text: `The material:\n${text.slice(0, 12000)}` });
    }
    userContent = parts;
  }

  try {
    const client = new OpenAI();
    const completion = await client.chat.completions.create({
      model: ELIORA_SUMMARY_MODEL,
      max_completion_tokens: 2600,
      messages: [
        { role: "system", content: helpPrompt({ ...body, mode, ask }) },
        { role: "user", content: userContent },
      ],
      tools: [HELP_TOOL],
      tool_choice: { type: "function", function: { name: "give_help" } },
    });

    const call = completion.choices[0]?.message?.tool_calls?.[0];
    const args = JSON.parse(
      (call && "function" in call ? call.function.arguments : "") || "{}",
    );

    const steps: HelpStep[] = (Array.isArray(args.steps) ? args.steps : [])
      .filter((s: { title?: unknown; detail?: unknown }) => str(s?.title) && str(s?.detail))
      .slice(0, 8)
      .map((s: { title: string; detail: string; hint?: unknown }) => ({
        title: s.title.trim(),
        detail: s.detail.trim(),
        hint: str(s.hint),
      }));

    const note = str(args.note);
    if (!steps.length) {
      // The model bailed (usually: the ask was too vague). Its own note is the
      // most useful thing to show — it names what's missing.
      return Response.json(
        {
          error:
            note ||
            "I couldn't work with that yet — try adding a bit more detail.",
        },
        { status: 200 },
      );
    }

    const exampleTitle = str(args.example?.title);
    const exampleBody = str(args.example?.body);
    const help: HelpAnswer = {
      mode,
      title: str(args.title) || ask.slice(0, 60),
      summary: str(args.summary) || "",
      steps,
      keyPoints: (Array.isArray(args.keyPoints) ? args.keyPoints : [])
        .map((k: unknown) => str(k))
        .filter(Boolean)
        .slice(0, 5) as string[],
      example:
        exampleBody != null
          ? { title: exampleTitle || "Worked example", body: exampleBody }
          : undefined,
      checks: normalizeChecks(args.checks),
      nextStep: str(args.nextStep),
      note,
    };

    return Response.json({ help });
  } catch {
    return Response.json(
      { error: "Sorry, I couldn't put that together. Please try again." },
      { status: 200 },
    );
  }
}
