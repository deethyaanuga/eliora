import OpenAI from "openai";
import {
  ELIORA_CHAT_MODEL,
  projectFeedbackPrompt,
  type ProjectFeedbackRequest,
  type UploadDoc,
} from "@eliora/shared";

// Grades a student's uploaded project against an uploaded rubric. The rubric is
// the grading standard; Eliora returns a score + strengths + gaps per criterion,
// an overall estimated grade, and prioritized next steps. Forces a tool call so
// the shape is always clean. Returns { feedback } or { error }.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FEEDBACK_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "give_project_feedback",
    description:
      "Return the project's grade and feedback, scored against every criterion " +
      "in the rubric.",
    parameters: {
      type: "object",
      properties: {
        overallGrade: {
          type: "string",
          description:
            "Estimated overall grade, consistent with the per-criterion scores " +
            '(e.g. "B+ (87%)", "42/50", "Proficient").',
        },
        summary: {
          type: "string",
          description:
            "2–3 sentence overview of how the project measures up to the rubric.",
        },
        criteria: {
          type: "array",
          description:
            "One entry per rubric criterion — cover EVERY criterion the rubric " +
            "lists, and none it doesn't.",
          items: {
            type: "object",
            properties: {
              criterion: {
                type: "string",
                description: "The rubric line item, worded as on the rubric.",
              },
              evidence: {
                type: "string",
                description:
                  "The exact part(s) of the project that decide this criterion " +
                  "— a short quote, section name, or 'not found in the project'. " +
                  "Find this BEFORE settling on the score.",
              },
              estimatedScore: {
                type: "string",
                description:
                  "Score in the rubric's own scale (points / level / percent), " +
                  "following from the evidence.",
              },
              strengths: {
                type: "string",
                description: "What the project does well on this criterion.",
              },
              gaps: {
                type: "string",
                description:
                  "What's missing or weak here, and how to improve it.",
              },
            },
            required: [
              "criterion",
              "evidence",
              "estimatedScore",
              "strengths",
              "gaps",
            ],
          },
        },
        topNextSteps: {
          type: "array",
          description: "Highest-impact improvements first (3–5 items).",
          items: { type: "string" },
        },
      },
      required: ["overallGrade", "summary", "criteria", "topNextSteps"],
    },
  },
};

const toStr = (v: unknown): string =>
  typeof v === "string" ? v.trim() : "";

// Turn one uploaded doc into a content part the model can read. PDFs go as a
// file part, images as an image_url, everything else is decoded to text.
function docParts(
  docs: UploadDoc[],
  label: string,
): Exclude<
  OpenAI.Chat.Completions.ChatCompletionUserMessageParam["content"],
  string
> {
  const parts: Exclude<
    OpenAI.Chat.Completions.ChatCompletionUserMessageParam["content"],
    string
  > = [];
  for (const d of docs) {
    const media = d.mediaType ?? "";
    if (media === "application/pdf") {
      parts.push({
        type: "file",
        file: {
          filename: d.name || `${label}.pdf`,
          file_data: `data:application/pdf;base64,${d.base64}`,
        },
      });
    } else if (media.startsWith("image/")) {
      parts.push({
        type: "image_url",
        image_url: { url: `data:${media};base64,${d.base64}` },
      });
    } else {
      try {
        const text = Buffer.from(d.base64 || "", "base64").toString("utf8");
        if (text.trim())
          parts.push({
            type: "text",
            text: `${label} "${d.name || label}":\n${text.slice(0, 16000)}`,
          });
      } catch {
        /* skip unreadable */
      }
    }
  }
  return parts;
}

export async function POST(req: Request) {
  let body: ProjectFeedbackRequest;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const clean = (v: unknown): UploadDoc[] =>
    (Array.isArray(v) ? (v as UploadDoc[]) : [])
      .filter((d) => d && (d.base64 || "").length)
      .slice(0, 4);
  const rubricDocs = clean(body.rubricDocs);
  const projectDocs = clean(body.projectDocs);
  const rubricText = toStr(body.rubricText);
  const projectText = toStr(body.projectText);

  const hasRubric = rubricDocs.length > 0 || rubricText.length > 0;
  const hasProject = projectDocs.length > 0 || projectText.length > 0;
  if (!hasRubric || !hasProject) {
    return Response.json({ error: "missing_input" }, { status: 400 });
  }

  const parts: Exclude<
    OpenAI.Chat.Completions.ChatCompletionUserMessageParam["content"],
    string
  > = [
    {
      type: "text",
      text:
        "Grade the PROJECT below against the RUBRIC below. Use the rubric as the " +
        "only grading standard.",
    },
    { type: "text", text: "===== RUBRIC =====" },
  ];
  if (rubricText) parts.push({ type: "text", text: rubricText });
  parts.push(...docParts(rubricDocs, "Rubric"));
  parts.push({ type: "text", text: "===== PROJECT =====" });
  if (projectText) parts.push({ type: "text", text: projectText });
  parts.push(...docParts(projectDocs, "Project"));

  try {
    const client = new OpenAI(); // reads OPENAI_API_KEY; throws if missing
    const completion = await client.chat.completions.create({
      // Rubric grading is reasoning-heavy, so use the stronger chat model (a
      // reasoning model) rather than the summary model. Its hidden reasoning
      // tokens also draw from max_completion_tokens, so the budget is raised.
      model: ELIORA_CHAT_MODEL,
      max_completion_tokens: 4000,
      messages: [
        { role: "system", content: projectFeedbackPrompt(body.profile) },
        { role: "user", content: parts },
      ],
      tools: [FEEDBACK_TOOL],
      tool_choice: {
        type: "function",
        function: { name: "give_project_feedback" },
      },
    });
    const call = completion.choices[0]?.message?.tool_calls?.[0];
    const args =
      call && "function" in call
        ? JSON.parse(call.function.arguments || "{}")
        : {};

    const criteria = (Array.isArray(args.criteria) ? args.criteria : [])
      .map((c: Record<string, unknown>) => ({
        criterion: toStr(c?.criterion),
        evidence: toStr(c?.evidence),
        estimatedScore: toStr(c?.estimatedScore),
        strengths: toStr(c?.strengths),
        gaps: toStr(c?.gaps),
      }))
      .filter((c: { criterion: string }) => c.criterion);
    const topNextSteps = (
      Array.isArray(args.topNextSteps) ? args.topNextSteps : []
    )
      .map(toStr)
      .filter(Boolean)
      .slice(0, 6);

    if (!criteria.length) {
      return Response.json({ error: "no_feedback" }, { status: 502 });
    }

    return Response.json({
      feedback: {
        overallGrade: toStr(args.overallGrade),
        summary: toStr(args.summary),
        criteria,
        topNextSteps,
      },
    });
  } catch (err) {
    const status = err instanceof OpenAI.APIError ? err.status : 500;
    return Response.json({ error: "server_error" }, { status: status ?? 500 });
  }
}
