import OpenAI from "openai";
import {
  ELIORA_SUMMARY_MODEL,
  joinSuggestionsPrompt,
  type LearnerProfile,
} from "@eliora/shared";

// Suggests real clubs / teams / competitions / organizations / volunteering the
// learner could JOIN to build toward their career. Returns { suggestions:
// [{title, why, yearIndex}] }. Forces a tool call for clean, structured output.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SUGGEST_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "suggest_joins",
    description:
      "Return clubs / teams / competitions / organizations / volunteer opportunities to join.",
    parameters: {
      type: "object",
      properties: {
        suggestions: {
          type: "array",
          description: "5–8 things the student could join.",
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "What to join." },
              why: {
                type: "string",
                description: "One line on why it fits the career/interests.",
              },
              yearIndex: {
                type: "integer",
                description: "0 = first year … 3 = last year, when to start.",
              },
            },
            required: ["title", "why"],
          },
        },
      },
      required: ["suggestions"],
    },
  },
};

type RawSug = { title?: unknown; why?: unknown; yearIndex?: unknown };

type JoinRequest = {
  career?: string;
  grade?: string;
  interests?: string;
  existing?: string[]; // milestones already in the plan, to avoid duplicates
  profile?: LearnerProfile;
};

export async function POST(req: Request) {
  let body: JoinRequest;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const career = (body.career ?? "").trim();
  if (!career) {
    return Response.json({ error: "missing_career" }, { status: 400 });
  }

  const interests =
    (body.interests ?? "").trim() ||
    (body.profile?.interests ?? "").trim() ||
    (body.profile?.hobbies ?? "").trim();
  const grade =
    (body.grade ?? "").trim() || (body.profile?.gradeYear ?? "").trim();
  const existing = Array.isArray(body.existing)
    ? body.existing.filter((s) => typeof s === "string" && s.trim()).slice(0, 30)
    : [];
  const detail = [
    `Target career: ${career}`,
    grade ? `Current grade / year: ${grade}` : "",
    interests ? `Interests: ${interests}` : "",
    existing.length
      ? `Already in their plan (don't repeat these): ${existing.join("; ")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const client = new OpenAI(); // reads OPENAI_API_KEY; throws if missing
    const completion = await client.chat.completions.create({
      model: ELIORA_SUMMARY_MODEL,
      max_completion_tokens: 700,
      messages: [
        { role: "system", content: joinSuggestionsPrompt(body.profile) },
        { role: "user", content: detail },
      ],
      tools: [SUGGEST_TOOL],
      tool_choice: { type: "function", function: { name: "suggest_joins" } },
    });
    const call = completion.choices[0]?.message?.tool_calls?.[0];
    const args =
      call && "function" in call
        ? JSON.parse(call.function.arguments || "{}")
        : {};
    const suggestions = (
      Array.isArray(args.suggestions) ? (args.suggestions as RawSug[]) : []
    )
      .filter((s) => String(s?.title ?? "").trim())
      .slice(0, 8)
      .map((s) => {
        const yi = Number(s.yearIndex);
        return {
          title: String(s.title).trim(),
          why: s.why ? String(s.why).trim() || undefined : undefined,
          yearIndex: Number.isInteger(yi) && yi >= 0 && yi <= 3 ? yi : 0,
        };
      });
    if (!suggestions.length) {
      return Response.json(
        { error: "Couldn't find suggestions — try again." },
        { status: 200 },
      );
    }
    return Response.json({ suggestions });
  } catch {
    return Response.json(
      { error: "Couldn't find suggestions — try again." },
      { status: 200 },
    );
  }
}
