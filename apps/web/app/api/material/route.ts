import OpenAI from "openai";
import {
  ELIORA_SUMMARY_MODEL,
  materialDigestPrompt,
  type MaterialRequest,
  type MaterialTerm,
  type MaterialTopic,
  type StudyMaterial,
} from "@eliora/shared";

// "Teach from my textbook": the learner uploads a chapter (PDF), photographs a
// page, or pastes text, and the model indexes it into a compact digest —
// sections + key terms in the material's own words. That digest is what the
// tutor carries in its system prompt from then on (see materialContext), so the
// heavy file is read exactly once instead of on every message.
//
// Forced tool call so the shape is always structured. Uses the summary model
// (gpt-4o-mini) — it reads PDFs and photos of pages directly, same as the
// lesson and notes-polish routes.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A chapter's worth of pasted text. Beyond this the digest gets vague anyway.
const TEXT_MAX = 16000;

const MATERIAL_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "index_material",
    description:
      "Return a teachable index of the learner's material: what it covers, its sections, and the terms it defines.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description:
            'Subject + chapter/topic, e.g. "Biology — Ch. 4: Photosynthesis".',
        },
        subject: {
          type: "string",
          description: 'The school subject, e.g. "Biology". Omit if unclear.',
        },
        overview: {
          type: "string",
          description: "2–3 sentences on what this material covers overall.",
        },
        topics: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: {
                type: "string",
                description:
                  "The section's own heading/number where the material has one.",
              },
              summary: {
                type: "string",
                description:
                  "What this section actually says — the definition, rule, " +
                  "steps, or example — in enough detail to teach from.",
              },
            },
            required: ["title", "summary"],
          },
          description: "The material's sections, in the order it teaches them.",
        },
        terms: {
          type: "array",
          items: {
            type: "object",
            properties: {
              term: { type: "string" },
              definition: {
                type: "string",
                description: "Defined the way THIS material defines it.",
              },
            },
            required: ["term", "definition"],
          },
          description: "Key terms the material defines.",
        },
      },
      required: ["title", "overview", "topics"],
    },
  },
};

const str = (v: unknown) =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

export async function POST(req: Request) {
  let body: MaterialRequest;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const text = (body.text ?? "").trim();
  const hasFile = !!body.fileBase64;
  if (!text && !hasFile) {
    return Response.json({ error: "missing_material" }, { status: 400 });
  }

  const intro =
    "Index the study material below so a tutor can teach from it later.";

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
      parts.push({ type: "text", text: `Material:\n${decoded.slice(0, TEXT_MAX)}` });
    }
    if (text) parts.push({ type: "text", text: `Also:\n${text}` });
    userContent = parts;
  } else {
    userContent = `${intro}\n\nMaterial:\n${text.slice(0, TEXT_MAX)}`;
  }

  try {
    const client = new OpenAI(); // reads OPENAI_API_KEY; throws if missing
    const completion = await client.chat.completions.create({
      model: ELIORA_SUMMARY_MODEL,
      max_completion_tokens: 4000,
      messages: [
        { role: "system", content: materialDigestPrompt(body.profile) },
        { role: "user", content: userContent },
      ],
      tools: [MATERIAL_TOOL],
      tool_choice: { type: "function", function: { name: "index_material" } },
    });
    const call = completion.choices[0]?.message?.tool_calls?.[0];
    const args =
      call && "function" in call
        ? JSON.parse(call.function.arguments || "{}")
        : {};

    const topics: MaterialTopic[] = (Array.isArray(args.topics) ? args.topics : [])
      .filter(
        (t: { title?: unknown; summary?: unknown }) =>
          str(t?.title) && str(t?.summary),
      )
      .slice(0, 20)
      .map((t: { title?: unknown; summary?: unknown }) => ({
        title: String(t.title).trim(),
        summary: String(t.summary).trim(),
      }));
    const terms: MaterialTerm[] = (Array.isArray(args.terms) ? args.terms : [])
      .filter(
        (t: { term?: unknown; definition?: unknown }) =>
          str(t?.term) && str(t?.definition),
      )
      .slice(0, 30)
      .map((t: { term?: unknown; definition?: unknown }) => ({
        term: String(t.term).trim(),
        definition: String(t.definition).trim(),
      }));

    // Nothing teachable came back — a blank page, an unreadable photo, or a
    // scanned PDF with no text layer. Say so instead of saving an empty shell
    // that would quietly ground the tutor in nothing.
    if (!topics.length) {
      return Response.json({
        error:
          "I couldn't read anything teachable in that. Try a clearer photo, a " +
          "text-based PDF, or paste the text straight in.",
      });
    }

    const material: StudyMaterial = {
      id: `m${Date.now().toString(36)}`,
      title: str(args.title) ?? body.fileName ?? "Study material",
      subject: str(args.subject) ?? str(body.subject),
      source: str(body.fileName) ?? "Pasted text",
      overview: str(args.overview) ?? "",
      topics,
      terms,
      addedAt: new Date().toISOString().slice(0, 10),
    };
    return Response.json({ material });
  } catch {
    return Response.json(
      { error: "Couldn't read that material right now — try again." },
      { status: 200 },
    );
  }
}
