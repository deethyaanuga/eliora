import OpenAI from "openai";
import {
  ELIORA_BOT_ID,
  ELIORA_BOT_NAME,
  ELIORA_SUMMARY_MODEL,
  doubtAnswerPrompt,
  doubtKind,
  type Doubt,
} from "@eliora/shared";
import { replyToDoubt } from "@/lib/doubts";

// Eliora as a board member: given a freshly posted question, write the answer
// (a few lines, plus a short parallel worked example) and hang it on the thread
// under her own identity. Called fire-and-forget from the ask route — clients
// poll the feed anyway, so her answer just appears like any other reply.
// gpt-4o-mini forced-tool, same as the other structured endpoints.

const ANSWER_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "answer_doubt",
    description:
      "Post the answer: short and sweet, plus a brief parallel worked example.",
    parameters: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description:
            "The answer in at most 5 short lines, plain text, result first.",
        },
        work: {
          type: "string",
          description:
            "A worked example of a different but parallel problem, at most 5 lines, one step per line.",
        },
      },
      required: ["text"],
    },
  },
};

export async function answerDoubtAsEliora(
  scope: string,
  doubt: Doubt,
): Promise<void> {
  if (doubtKind(doubt) !== "question") return;
  try {
    const client = new OpenAI();
    const parts = [
      `Title: ${doubt.title}`,
      doubt.body ? `The question:\n${doubt.body}` : "",
      doubt.work ? `What I've tried:\n${doubt.work}` : "",
    ].filter(Boolean);
    const completion = await client.chat.completions.create({
      model: ELIORA_SUMMARY_MODEL,
      max_completion_tokens: 600,
      messages: [
        { role: "system", content: doubtAnswerPrompt(doubt.subject) },
        { role: "user", content: parts.join("\n\n") },
      ],
      tools: [ANSWER_TOOL],
      tool_choice: { type: "function", function: { name: "answer_doubt" } },
    });

    const call = completion.choices[0]?.message?.tool_calls?.[0];
    const args = JSON.parse(
      (call && "function" in call ? call.function.arguments : "") || "{}",
    ) as { text?: unknown; work?: unknown };
    const text = typeof args.text === "string" ? args.text.trim() : "";
    const work = typeof args.work === "string" ? args.work.trim() : "";
    if (!text) return;

    await replyToDoubt({
      scope,
      doubtId: doubt.id,
      authorId: ELIORA_BOT_ID,
      authorName: ELIORA_BOT_NAME,
      text,
      work: work || undefined,
    });
  } catch {
    // No API key, a model hiccup, or the doubt vanished — the board works
    // without her; the post just stays an ordinary unanswered question.
  }
}
