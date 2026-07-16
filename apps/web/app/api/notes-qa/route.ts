import OpenAI from "openai";
import {
  ELIORA_SUMMARY_MODEL,
  notesQaPrompt,
  type NotesQaRequest,
} from "@eliora/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Answer follow-up questions about the study notes Eliora just generated. The
// notes are pinned into the system prompt as the source of truth; the answer is
// streamed back as plain text (same shape as /api/summarize).
export async function POST(req: Request) {
  let body: NotesQaRequest;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const notes = body.notes?.trim();
  const question = body.question?.trim();
  if (!notes)
    return new Response("There are no notes to ask about yet.", {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  if (!question)
    return new Response("Please type a question about your notes.", {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });

  // Keep only the last few turns of this notes thread — the notes themselves
  // carry the context, so old turns add cost without adding much.
  const history = (body.history ?? []).slice(-8);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const client = new OpenAI(); // reads OPENAI_API_KEY; throws if missing
        const completion = await client.chat.completions.create({
          model: ELIORA_SUMMARY_MODEL,
          max_completion_tokens: 1200,
          messages: [
            { role: "system", content: notesQaPrompt(notes, body.profile) },
            ...history.map((m) => ({ role: m.role, content: m.content })),
            { role: "user", content: question },
          ],
          stream: true,
        });
        for await (const chunk of completion) {
          const text = chunk.choices[0]?.delta?.content;
          if (text) controller.enqueue(encoder.encode(text));
        }
        controller.close();
      } catch (err) {
        const status = err instanceof OpenAI.APIError ? ` (${err.status})` : "";
        controller.enqueue(
          encoder.encode(`Sorry, I couldn't answer that${status}. Please try again.`),
        );
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
    },
  });
}
