import OpenAI from "openai";
import {
  ELIORA_SUMMARY_MODEL,
  practiceQuizPrompt,
  type PracticeQuizRequest,
  type QuizQuestion,
} from "@eliora/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Force a structured multiple-choice quiz. Same shape the summarize route uses
// so the client's <QuizView> can render either interchangeably.
const QUIZ_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "make_quiz",
    description: "Return a multiple-choice practice quiz on the requested topic.",
    parameters: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              question: { type: "string" },
              options: { type: "array", items: { type: "string" } },
              answerIndex: { type: "integer" },
              explanation: { type: "string" },
              topic: { type: "string" },
            },
            required: ["question", "options", "answerIndex"],
          },
        },
      },
      required: ["questions"],
    },
  },
};

export async function POST(req: Request) {
  let body: PracticeQuizRequest;
  try {
    body = (await req.json()) as PracticeQuizRequest;
  } catch {
    return Response.json({ error: "Bad request." }, { status: 400 });
  }

  const topic = body.topic?.trim();
  if (!topic) {
    return Response.json(
      { error: "Tell me what to quiz you on first." },
      { status: 200 },
    );
  }

  const count = Math.min(10, Math.max(3, body.count ?? 5));

  try {
    const client = new OpenAI();
    const completion = await client.chat.completions.create({
      model: ELIORA_SUMMARY_MODEL,
      max_completion_tokens: 2200,
      messages: [
        { role: "system", content: practiceQuizPrompt({ ...body, topic, count }) },
        {
          role: "user",
          content: `Make me a ${count}-question practice quiz on: ${topic}`,
        },
      ],
      tools: [QUIZ_TOOL],
      tool_choice: { type: "function", function: { name: "make_quiz" } },
    });

    const call = completion.choices[0]?.message?.tool_calls?.[0];
    const args = JSON.parse(
      (call && "function" in call ? call.function.arguments : "") || "{}",
    );

    const quiz: QuizQuestion[] = (args.questions ?? [])
      .filter(
        (q: { question?: string; options?: string[]; answerIndex?: number }) =>
          q?.question?.trim() &&
          Array.isArray(q.options) &&
          q.options.length >= 2 &&
          typeof q.answerIndex === "number" &&
          q.answerIndex >= 0 &&
          q.answerIndex < q.options.length,
      )
      .map(
        (q: {
          question: string;
          options: string[];
          answerIndex: number;
          explanation?: string;
          topic?: string;
        }) => ({
          question: q.question.trim(),
          options: q.options.map(String),
          answerIndex: q.answerIndex,
          explanation: q.explanation?.trim() || undefined,
          topic: q.topic?.trim() || undefined,
        }),
      );

    if (!quiz.length) {
      return Response.json(
        { error: "I couldn't write a quiz on that. Try naming a clearer topic." },
        { status: 200 },
      );
    }

    return Response.json({ quiz });
  } catch {
    return Response.json(
      { error: "Sorry, I couldn't create that quiz. Please try again." },
      { status: 200 },
    );
  }
}
