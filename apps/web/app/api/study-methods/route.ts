import OpenAI from "openai";
import {
  ELIORA_SUMMARY_MODEL,
  STUDY_HORIZONS,
  studyAdvicePrompt,
  type StudyAdvice,
  type StudyAdviceRequest,
  type StudyHorizon,
  type StudyMethod,
} from "@eliora/shared";

// "How should I be studying this?" — the question under the help desk. Returns
// 2–4 techniques matched to the material, the time left and the way this learner
// keeps failing, each with the first rep already written out.
// Forced tool call for a stable shape; gpt-4o-mini like the other forced-tool
// endpoints, and it reads the attached notes/syllabus too.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ADVICE_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "give_study_advice",
    description:
      "Return the study techniques that fit this material and this learner, with the first rep written out.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title — what they're studying." },
        summary: {
          type: "string",
          description: "1–2 sentences: how they should be studying this, and why.",
        },
        methods: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "The technique, in plain words." },
              fit: {
                type: "string",
                description:
                  "Why THIS technique for this material and this learner.",
              },
              minutes: {
                type: "integer",
                description: "How long one round of it takes.",
              },
              steps: {
                type: "array",
                items: { type: "string" },
                description: "2–5 do-able moves.",
              },
              starter: {
                type: "string",
                description:
                  "The actual first rep, written against their own material.",
              },
              trap: {
                type: "string",
                description:
                  "How people do this one wrong and lose the benefit.",
              },
            },
            required: ["name", "fit", "steps"],
          },
        },
        session: {
          type: "object",
          description: "What one study block looks like.",
          properties: {
            minutes: { type: "integer" },
            blocks: {
              type: "array",
              items: { type: "string" },
              description: "3–5 lines like “0–10 min · blurt everything on X”.",
            },
          },
          required: ["minutes", "blocks"],
        },
        stopDoing: {
          type: "array",
          items: { type: "string" },
          description: "1–3 low-yield habits to drop, each with the reason.",
        },
        nextStep: {
          type: "string",
          description: "ONE tiny thing to do in the next five minutes.",
        },
        note: { type: "string", description: "One warm sentence from Eliora." },
      },
      required: ["title", "summary", "methods"],
    },
  },
};

const str = (v: unknown) =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

const lines = (raw: unknown, limit: number): string[] =>
  (Array.isArray(raw) ? raw : [])
    .map((v: unknown) => str(v))
    .filter(Boolean)
    .slice(0, limit) as string[];

function normalizeMethods(raw: unknown): StudyMethod[] {
  return (Array.isArray(raw) ? raw : [])
    .filter(
      (m: { name?: unknown; fit?: unknown; steps?: unknown }) =>
        str(m?.name) && str(m?.fit) && Array.isArray(m.steps) && m.steps.length,
    )
    .slice(0, 4)
    .map((m: {
      name: string;
      fit: string;
      steps: unknown;
      minutes?: unknown;
      starter?: unknown;
      trap?: unknown;
    }) => ({
      name: m.name.trim(),
      fit: m.fit.trim(),
      minutes:
        typeof m.minutes === "number" && m.minutes > 0
          ? Math.round(m.minutes)
          : undefined,
      steps: lines(m.steps, 5),
      starter: str(m.starter),
      trap: str(m.trap),
    }))
    .filter((m) => m.steps.length > 0);
}

export async function POST(req: Request) {
  let body: StudyAdviceRequest;
  try {
    body = (await req.json()) as StudyAdviceRequest;
  } catch {
    return Response.json({ error: "Bad request." }, { status: 400 });
  }

  const horizon: StudyHorizon = STUDY_HORIZONS.some((h) => h.id === body.horizon)
    ? body.horizon
    : "tonight";
  const ask = (body.ask ?? "").trim();
  const hasFile = !!body.fileBase64;
  if (!ask && !hasFile) {
    return Response.json(
      { error: "Tell me what you're studying first." },
      { status: 200 },
    );
  }

  const blockers = (body.blockers ?? [])
    .map((b) => (typeof b === "string" ? b.trim() : ""))
    .filter(Boolean)
    .slice(0, 8);

  const intro = `Here's what I'm studying:\n${ask}`;
  type UserContent =
    OpenAI.Chat.Completions.ChatCompletionUserMessageParam["content"];
  let userContent: UserContent = intro;
  if (hasFile) {
    const media = body.fileMediaType ?? "";
    const parts: Exclude<UserContent, string> = [
      {
        type: "text",
        text: ask ? intro : "Here's the material I need to study.",
      },
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
      max_completion_tokens: 2400,
      messages: [
        {
          role: "system",
          content: studyAdvicePrompt({ ...body, horizon, ask, blockers }),
        },
        { role: "user", content: userContent },
      ],
      tools: [ADVICE_TOOL],
      tool_choice: { type: "function", function: { name: "give_study_advice" } },
    });

    const call = completion.choices[0]?.message?.tool_calls?.[0];
    const args = JSON.parse(
      (call && "function" in call ? call.function.arguments : "") || "{}",
    );

    const methods = normalizeMethods(args.methods);
    const note = str(args.note);
    if (!methods.length) {
      // The model bailed — usually the ask was too thin to match a method to.
      // Its own note names what's missing, so that's the most useful thing to show.
      return Response.json(
        {
          error:
            note ||
            "I couldn't tell what would help yet — say a bit more about what you're studying.",
        },
        { status: 200 },
      );
    }

    const blocks = lines(args.session?.blocks, 5);
    const advice: StudyAdvice = {
      title: str(args.title) || ask.slice(0, 60),
      summary: str(args.summary) || "",
      methods,
      session:
        blocks.length && typeof args.session?.minutes === "number"
          ? { minutes: Math.round(args.session.minutes), blocks }
          : undefined,
      stopDoing: lines(args.stopDoing, 3),
      nextStep: str(args.nextStep),
      note,
    };

    return Response.json({ advice });
  } catch {
    return Response.json(
      { error: "Sorry, I couldn't put that together. Please try again." },
      { status: 200 },
    );
  }
}
