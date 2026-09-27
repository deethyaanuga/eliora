import OpenAI from "openai";
import {
  ELIORA_SUMMARY_MODEL,
  normalizeFlashcardStyle,
  outputSystemPrompt,
  type SummarizeRequest,
} from "@eliora/shared";
import {
  condenseTranscript,
  extractVideoId,
  fetchTranscript,
  TRANSCRIPT_SINGLE_PASS_MAX,
} from "../_lib/youtube-transcript";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Tools to force structured flashcards / quiz from the material.
const FLASHCARDS_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "make_flashcards",
    description: "Return flashcards built from the material.",
    parameters: {
      type: "object",
      properties: {
        cards: {
          type: "array",
          items: {
            type: "object",
            properties: {
              front: { type: "string" },
              back: { type: "string" },
              style: {
                type: "string",
                enum: ["basic", "reversed", "qa", "cloze", "example"],
              },
            },
            required: ["front", "back"],
          },
        },
      },
      required: ["cards"],
    },
  },
};
const QUIZ_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "make_quiz",
    description: "Return a multiple-choice quiz built from the material.",
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
  let body: SummarizeRequest;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const encoder = new TextEncoder();
  const plain = (msg: string) =>
    new Response(msg, {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });

  const output = body.output ?? "summary";
  const wantsVideoNotes = output === "videonotes";

  // Build the user message content based on the source.
  let content: OpenAI.Chat.Completions.ChatCompletionUserMessageParam["content"];
  // Video notes work off the raw transcript, which may need condensing first —
  // that happens inside the stream so the learner only waits on one request.
  let transcriptForNotes: string | null = null;

  if (body.source === "text") {
    const text = body.text?.trim();
    if (!text || text.length < 20)
      return plain("Please paste a bit more text for me to summarize.");
    // The learner pasted the transcript themselves (the fallback when YouTube
    // blocks caption fetching), so treat it as one.
    if (wantsVideoNotes) transcriptForNotes = text;
    content = `Summarize these notes:\n\n${text}`;
  } else if (body.source === "video") {
    const id = body.url ? extractVideoId(body.url) : null;
    if (!id)
      return plain("That doesn't look like a YouTube link. Please check it.");
    const transcript = await fetchTranscript(id, wantsVideoNotes);
    if (!transcript)
      return plain(
        "I couldn't pull this video's transcript automatically — YouTube blocks " +
          "fetching captions from a server. Here's the quick workaround:\n\n" +
          '1. On the video, click "…more" under the title → "Show transcript".\n' +
          "2. Select all the transcript text and copy it.\n" +
          '3. Paste it into the "Notes / text" tab here, and I\'ll summarize it.',
      );
    if (wantsVideoNotes) transcriptForNotes = transcript;
    content = `Summarize this video transcript:\n\n${transcript}`;
  } else if (body.source === "doc") {
    const media = body.fileMediaType ?? "";
    if (media === "application/pdf" && body.fileBase64) {
      content = [
        { type: "text", text: "Summarize this document." },
        {
          type: "file",
          file: {
            filename: body.fileName || "document.pdf",
            file_data: `data:application/pdf;base64,${body.fileBase64}`,
          },
        },
      ];
    } else if (media.startsWith("image/") && body.fileBase64) {
      content = [
        { type: "text", text: "Summarize the notes in this image." },
        {
          type: "image_url",
          image_url: { url: `data:${media};base64,${body.fileBase64}` },
        },
      ];
    } else if (body.text?.trim()) {
      content = `Summarize this document:\n\n${body.text.trim()}`;
    } else {
      return plain("I couldn't read that file. Try a PDF, image, or text file.");
    }
  } else {
    return plain("Unknown source.");
  }

  // Flashcards / quiz → structured JSON (a forced tool call), grounded in material.
  if (output === "flashcards" || output === "quiz") {
    try {
      const client = new OpenAI();
      const tool = output === "flashcards" ? FLASHCARDS_TOOL : QUIZ_TOOL;
      const completion = await client.chat.completions.create({
        model: ELIORA_SUMMARY_MODEL,
        max_completion_tokens: 1800,
        messages: [
          {
            role: "system",
            content: outputSystemPrompt(
              output,
              body.profile,
              normalizeFlashcardStyle(body.flashcardStyle),
            ),
          },
          { role: "user", content },
        ],
        tools: [tool],
        tool_choice: {
          type: "function",
          function: {
            name: tool.type === "function" ? tool.function.name : "",
          },
        },
      });
      const call = completion.choices[0]?.message?.tool_calls?.[0];
      const args = JSON.parse(
        (call && "function" in call ? call.function.arguments : "") || "{}",
      );
      if (output === "flashcards") {
        const cards = (args.cards ?? [])
          .filter(
            (c: { front?: string; back?: string }) =>
              c?.front?.trim() && c?.back?.trim(),
          )
          .map((c: { front: string; back: string; style?: string }) => ({
            front: c.front.trim(),
            back: c.back.trim(),
            style: normalizeFlashcardStyle(c.style),
          }));
        return Response.json({ flashcards: cards });
      }
      const quiz = (args.questions ?? [])
        .filter(
          (q: { question?: string; options?: string[]; answerIndex?: number }) =>
            q?.question?.trim() &&
            Array.isArray(q.options) &&
            q.options.length >= 2 &&
            typeof q.answerIndex === "number",
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
      return Response.json({ quiz });
    } catch {
      return Response.json(
        { error: "Sorry, I couldn't create that. Please try again." },
        { status: 200 },
      );
    }
  }

  // Summary / study guide → streamed text.
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const client = new OpenAI(); // reads OPENAI_API_KEY; throws if missing

        // A feature-length transcript won't yield complete notes in one pass, so
        // extract each chunk first and write the notes from the joined extracts.
        let material = content;
        if (transcriptForNotes) {
          const source =
            transcriptForNotes.length > TRANSCRIPT_SINGLE_PASS_MAX
              ? (await condenseTranscript(client, transcriptForNotes)) ||
                transcriptForNotes.slice(0, TRANSCRIPT_SINGLE_PASS_MAX)
              : transcriptForNotes;
          material = `Take notes from this video transcript:\n\n${source}`;
        }

        const completion = await client.chat.completions.create({
          model: ELIORA_SUMMARY_MODEL,
          // In-depth notes / study guides run longer, so give room to finish.
          // Modules repeat a full sub-structure per topic, so they run longer still.
          max_completion_tokens:
            output === "modules" || output === "videonotes" ? 3800 : 2800,
          messages: [
            { role: "system", content: outputSystemPrompt(output, body.profile) },
            { role: "user", content: material },
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
          encoder.encode(`Sorry, I couldn't do that${status}. Please try again.`),
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
