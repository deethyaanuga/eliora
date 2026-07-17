import OpenAI from "openai";
import {
  ELIORA_SUMMARY_MODEL,
  notesPolishSystemPrompt,
  type NotesPolishMode,
  type LearnerProfile,
} from "@eliora/shared";

// Smart-notes helper: cleans up messy notes, transcribes a photo of handwriting,
// and auto-highlights the key ideas. Takes pasted text OR an uploaded image/PDF/
// text file and returns { result: { cleaned, keyIdeas[], keyTerms[], note } }.
// Forced tool call so the output is always structured. Uses the summary model
// (gpt-4o-mini) — it supports vision, so it can read handwriting from a photo.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const POLISH_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "polish_notes",
    description:
      "Return the cleaned-up notes plus the key ideas and terms pulled from them.",
    parameters: {
      type: "object",
      properties: {
        cleaned: {
          type: "string",
          description:
            "The tidied notes as markdown (## headings, - bullets, **bold**), " +
            "with the most important phrase in each section wrapped in " +
            "==double equals== to highlight it.",
        },
        keyIdeas: {
          type: "array",
          items: { type: "string" },
          description: "The 3–7 most important takeaways as short standalone lines.",
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
          description: "Important terms from the notes, each with a plain definition.",
        },
        note: {
          type: "string",
          description: "ONE short, warm sentence about what was cleaned/transcribed.",
        },
      },
      required: ["cleaned"],
    },
  },
};

type NotesPolishBody = {
  mode?: NotesPolishMode;
  text?: string;
  fileBase64?: string;
  fileMediaType?: string;
  fileName?: string;
  profile?: LearnerProfile;
};

const str = (v: unknown) =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

export async function POST(req: Request) {
  let body: NotesPolishBody;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const mode: NotesPolishMode =
    body.mode === "handwriting" || body.mode === "highlight"
      ? body.mode
      : "clean";
  const text = (body.text ?? "").trim();
  const hasFile = !!body.fileBase64;
  if (!text && !hasFile) {
    return Response.json({ error: "missing_notes" }, { status: 400 });
  }

  const intro =
    mode === "handwriting"
      ? "Transcribe and tidy up the handwritten notes below."
      : "Clean up and organize the notes below.";

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
          filename: body.fileName || "notes.pdf",
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
      parts.push({ type: "text", text: `Notes:\n${decoded.slice(0, 12000)}` });
    }
    if (text) parts.push({ type: "text", text: `Also / instead:\n${text}` });
    userContent = parts;
  } else {
    userContent = `${intro}\n\nNotes:\n${text}`;
  }

  try {
    const client = new OpenAI(); // reads OPENAI_API_KEY; throws if missing
    const completion = await client.chat.completions.create({
      model: ELIORA_SUMMARY_MODEL,
      max_completion_tokens: 2500,
      messages: [
        { role: "system", content: notesPolishSystemPrompt(mode, body.profile) },
        { role: "user", content: userContent },
      ],
      tools: [POLISH_TOOL],
      tool_choice: { type: "function", function: { name: "polish_notes" } },
    });
    const call = completion.choices[0]?.message?.tool_calls?.[0];
    const args =
      call && "function" in call
        ? JSON.parse(call.function.arguments || "{}")
        : {};
    const cleaned = str(args.cleaned);
    const keyIdeas = (Array.isArray(args.keyIdeas) ? args.keyIdeas : [])
      .map((s: unknown) => str(s))
      .filter(Boolean)
      .slice(0, 8);
    const keyTerms = (Array.isArray(args.keyTerms) ? args.keyTerms : [])
      .filter((t: { term?: unknown; definition?: unknown }) =>
        str(t?.term) && str(t?.definition),
      )
      .slice(0, 20)
      .map((t: { term?: unknown; definition?: unknown }) => ({
        term: String(t.term).trim(),
        definition: String(t.definition).trim(),
      }));
    const note = str(args.note);
    if (!cleaned && keyIdeas.length === 0) {
      return Response.json(
        {
          result: {
            cleaned: "",
            keyIdeas: [],
            keyTerms: [],
            note:
              note ||
              "I couldn't make much of that — try pasting a bit more, or a clearer photo.",
          },
        },
        { status: 200 },
      );
    }
    return Response.json({
      result: { cleaned: cleaned ?? "", keyIdeas, keyTerms, note },
    });
  } catch {
    return Response.json(
      { error: "Couldn't tidy those notes right now — try again." },
      { status: 200 },
    );
  }
}
