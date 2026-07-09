import OpenAI from "openai";
import {
  ELIORA_SUMMARY_MODEL,
  interestAlignmentPrompt,
  type LearnerProfile,
} from "@eliora/shared";

// Shows how a student's interests connect to their ultimate goal (career).
// Returns { alignments: [{interest, connection}], overall }. Forces a tool call.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALIGN_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "align_interests",
    description: "Return how each interest connects to the ultimate goal.",
    parameters: {
      type: "object",
      properties: {
        alignments: {
          type: "array",
          description:
            "EXACTLY one entry per interest listed (3 interests → 3 entries).",
          items: {
            type: "object",
            properties: {
              interest: { type: "string" },
              connection: {
                type: "string",
                description: "How it links to the goal + a way to leverage it.",
              },
            },
            required: ["interest", "connection"],
          },
        },
        overall: {
          type: "string",
          description: "1–2 sentence throughline tying interests to the goal.",
        },
      },
      required: ["alignments"],
    },
  },
};

type RawAlign = { interest?: unknown; connection?: unknown };
type AlignRequest = {
  goal?: string;
  interests?: string;
  profile?: LearnerProfile;
};

export async function POST(req: Request) {
  let body: AlignRequest;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const goal = (body.goal ?? "").trim();
  const interests =
    (body.interests ?? "").trim() ||
    (body.profile?.interests ?? "").trim() ||
    (body.profile?.hobbies ?? "").trim();
  if (!goal || !interests) {
    return Response.json({ error: "missing_goal_or_interests" }, { status: 400 });
  }

  // Split into a numbered list so the model returns exactly one entry per interest.
  const list = interests
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 10);
  const detail = [
    `Ultimate goal (career): ${goal}`,
    `Their ${list.length} interests — return EXACTLY one alignment entry for EACH, in this order:`,
    ...list.map((s, i) => `${i + 1}. ${s}`),
  ].join("\n");

  try {
    const client = new OpenAI(); // reads OPENAI_API_KEY; throws if missing
    const completion = await client.chat.completions.create({
      model: ELIORA_SUMMARY_MODEL,
      max_completion_tokens: 800,
      messages: [
        { role: "system", content: interestAlignmentPrompt(body.profile) },
        { role: "user", content: detail },
      ],
      tools: [ALIGN_TOOL],
      tool_choice: { type: "function", function: { name: "align_interests" } },
    });
    const call = completion.choices[0]?.message?.tool_calls?.[0];
    const args =
      call && "function" in call
        ? JSON.parse(call.function.arguments || "{}")
        : {};
    const alignments = (
      Array.isArray(args.alignments) ? (args.alignments as RawAlign[]) : []
    )
      .filter((a) => String(a?.interest ?? "").trim() && String(a?.connection ?? "").trim())
      .slice(0, 10)
      .map((a) => ({
        interest: String(a.interest).trim(),
        connection: String(a.connection).trim(),
      }));
    const overall =
      typeof args.overall === "string" ? args.overall.trim() : undefined;
    if (!alignments.length) {
      return Response.json(
        { error: "Couldn't map that out — try again." },
        { status: 200 },
      );
    }
    return Response.json({ alignments, overall });
  } catch {
    return Response.json(
      { error: "Couldn't map that out — try again." },
      { status: 200 },
    );
  }
}
