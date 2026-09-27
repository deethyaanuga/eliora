import OpenAI from "openai";
import {
  ELIORA_SUMMARY_MODEL,
  FLASHCARD_STYLES,
  flashcardsPrompt,
  normalizeFlashcardStyle,
  type DeckCard,
  type FlashcardRequest,
} from "@eliora/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Force a structured two-sided deck. The client renders these straight into
// editable cards, so the shape has to be predictable — never free prose.
const FLASHCARD_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "make_flashcards",
    description: "Return a deck of two-sided flashcards for the learner to study.",
    parameters: {
      type: "object",
      properties: {
        cards: {
          type: "array",
          items: {
            type: "object",
            properties: {
              front: { type: "string", description: "The prompt side: a term or a question." },
              back: { type: "string", description: "The answer side." },
              style: {
                type: "string",
                enum: FLASHCARD_STYLES.map((s) => s.key),
                description: "Which card style this one is written in.",
              },
              hint: { type: "string", description: "Optional nudge, never the answer." },
              topic: { type: "string", description: "Short sub-concept tag." },
            },
            required: ["front", "back"],
          },
        },
      },
      required: ["cards"],
    },
  },
};

export async function POST(req: Request) {
  let body: FlashcardRequest;
  try {
    body = (await req.json()) as FlashcardRequest;
  } catch {
    return Response.json({ error: "Bad request." }, { status: 400 });
  }

  const topic = body.topic?.trim();
  const material = body.material?.trim();
  const hasFile = !!body.fileBase64;
  if (!topic && !material && !hasFile) {
    return Response.json(
      { error: "Tell me a topic, or paste the material you want cards from." },
      { status: 200 },
    );
  }

  const count = Math.min(30, Math.max(4, body.count ?? 12));
  const grounded = !!material || hasFile;
  const ask = grounded
    ? `Make me ${count} flashcards from the material I gave you.`
    : `Make me ${count} flashcards on: ${topic}`;

  // An upload rides along as extra user-message parts, same as the lesson
  // route: PDFs and photos go to the model natively, anything else is decoded
  // as text.
  type UserContent =
    OpenAI.Chat.Completions.ChatCompletionUserMessageParam["content"];
  let userContent: UserContent = ask;
  if (hasFile) {
    const media = body.fileMediaType ?? "";
    const b64 = body.fileBase64 ?? "";
    const parts: Exclude<UserContent, string> = [{ type: "text", text: ask }];
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
    userContent = parts;
  }

  try {
    const client = new OpenAI();
    const completion = await client.chat.completions.create({
      model: ELIORA_SUMMARY_MODEL,
      // Decks run longer than a quiz — 30 cards of two sides each.
      max_completion_tokens: 4000,
      messages: [
        {
          role: "system",
          content: flashcardsPrompt({ ...body, topic, material, count }),
        },
        { role: "user", content: userContent },
      ],
      tools: [FLASHCARD_TOOL],
      tool_choice: { type: "function", function: { name: "make_flashcards" } },
    });

    const call = completion.choices[0]?.message?.tool_calls?.[0];
    const args = JSON.parse(
      (call && "function" in call ? call.function.arguments : "") || "{}",
    );

    // A card is only useful if BOTH sides say something. Drop the rest rather
    // than handing the learner a deck with blank backs to clean up.
    const seen = new Set<string>();
    const cards: DeckCard[] = (args.cards ?? [])
      .filter(
        (c: { front?: string; back?: string }) =>
          c?.front?.trim() && c?.back?.trim(),
      )
      .filter((c: { front: string }) => {
        // The model repeats itself on long decks; keep the first of each front.
        const key = c.front.trim().toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, count)
      .map(
        (
          c: {
            front: string;
            back: string;
            style?: string;
            hint?: string;
            topic?: string;
          },
          i: number,
        ) => ({
          id: `c${Date.now().toString(36)}${i}`,
          front: c.front.trim(),
          back: c.back.trim(),
          // Only a style we actually know how to label; anything else falls
          // back to "basic" at render time.
          style: normalizeFlashcardStyle(c.style) ?? body.style,
          hint: c.hint?.trim() || undefined,
          topic: c.topic?.trim() || undefined,
          source: "ai" as const,
        }),
      );

    if (!cards.length) {
      return Response.json(
        {
          error: grounded
            ? "I couldn't find enough in that material to make cards from."
            : "I couldn't write cards on that. Try naming a clearer topic.",
        },
        { status: 200 },
      );
    }

    return Response.json({ cards });
  } catch {
    return Response.json(
      { error: "Sorry, I couldn't make that deck. Please try again." },
      { status: 200 },
    );
  }
}
