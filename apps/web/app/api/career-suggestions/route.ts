import OpenAI from "openai";
import {
  ELIORA_SUMMARY_MODEL,
  careerSuggestionsPrompt,
  type LearnerProfile,
} from "@eliora/shared";

// Helps a student who isn't sure what career they want: from their interests,
// strengths, subjects and work-style, suggests a few careers that fit. Returns
// { suggestions: [{title, why?, path?}] }. Forces a tool call for clean output.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SUGGEST_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "suggest_careers",
    description: "Return 5–6 career suggestions that fit the student.",
    parameters: {
      type: "object",
      properties: {
        suggestions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "The job / career title." },
              why: {
                type: "string",
                description: "Warm one-liner tying it to their answers.",
              },
              path: {
                type: "string",
                description: "Typical route in (degree, trade, certificate…).",
              },
            },
            required: ["title"],
          },
        },
      },
      required: ["suggestions"],
    },
  },
};

type RawSug = { title?: unknown; why?: unknown; path?: unknown };

type CareerRequest = {
  subjects?: string;
  strengths?: string;
  interests?: string;
  workStyle?: string;
  values?: string;
  education?: string;
  dislikes?: string;
  environment?: string;
  curious?: string;
  impact?: string;
  structure?: string;
  admire?: string;
  income?: string;
  // Post-survey refinement (second round): which of the last suggestions they
  // liked, what they want more/less of, and what was already suggested.
  liked?: string;
  refine?: string;
  previous?: string[];
  profile?: LearnerProfile;
};

export async function POST(req: Request) {
  let body: CareerRequest;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const detail = [
    body.subjects?.trim() ? `Favorite subjects: ${body.subjects.trim()}` : "",
    body.strengths?.trim() ? `Strengths / good at: ${body.strengths.trim()}` : "",
    body.interests?.trim()
      ? `Interests, hobbies & activities: ${body.interests.trim()}`
      : "",
    body.workStyle?.trim() ? `How they like to work: ${body.workStyle.trim()}` : "",
    body.values?.trim() ? `What matters to them in a job: ${body.values.trim()}` : "",
    body.dislikes?.trim()
      ? `Subjects/tasks they want to AVOID: ${body.dislikes.trim()}`
      : "",
    body.environment?.trim()
      ? `Where they picture working: ${body.environment.trim()}`
      : "",
    body.curious?.trim()
      ? `Could learn/talk about for hours: ${body.curious.trim()}`
      : "",
    body.impact?.trim()
      ? `Problems they want to help solve: ${body.impact.trim()}`
      : "",
    body.structure?.trim()
      ? `Routine vs. variety preference: ${body.structure.trim()}`
      : "",
    body.admire?.trim()
      ? `Jobs/people whose work they admire: ${body.admire.trim()}`
      : "",
    body.income?.trim()
      ? `How much a high income matters: ${body.income.trim()}`
      : "",
    body.education?.trim()
      ? `Education appetite after high school: ${body.education.trim()}`
      : "",
    body.profile?.interests?.trim()
      ? `Profile interests: ${body.profile.interests.trim()}`
      : "",
    body.liked?.trim()
      ? `REFINE — careers from the last round they LIKED (lean toward this vibe): ${body.liked.trim()}`
      : "",
    body.refine?.trim()
      ? `REFINE — they want the next round to lean: ${body.refine.trim()}`
      : "",
    Array.isArray(body.previous) && body.previous.length
      ? `Already suggested last round (offer mostly DIFFERENT ones this time; you may keep a liked one): ${body.previous
          .filter((s) => typeof s === "string" && s.trim())
          .join(", ")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const client = new OpenAI(); // reads OPENAI_API_KEY; throws if missing
    const completion = await client.chat.completions.create({
      model: ELIORA_SUMMARY_MODEL,
      max_completion_tokens: 800,
      messages: [
        { role: "system", content: careerSuggestionsPrompt(body.profile) },
        {
          role: "user",
          content: detail || "I'm not sure what career I want — suggest some.",
        },
      ],
      tools: [SUGGEST_TOOL],
      tool_choice: { type: "function", function: { name: "suggest_careers" } },
    });
    const call = completion.choices[0]?.message?.tool_calls?.[0];
    const args =
      call && "function" in call
        ? JSON.parse(call.function.arguments || "{}")
        : {};
    const str = (v: unknown) =>
      typeof v === "string" && v.trim() ? v.trim() : undefined;
    const suggestions = (
      Array.isArray(args.suggestions) ? (args.suggestions as RawSug[]) : []
    )
      .filter((s) => String(s?.title ?? "").trim())
      .slice(0, 6)
      .map((s) => ({
        title: String(s.title).trim(),
        why: str(s.why),
        path: str(s.path),
      }));
    if (!suggestions.length) {
      return Response.json(
        { error: "Couldn't suggest careers — try again." },
        { status: 200 },
      );
    }
    return Response.json({ suggestions });
  } catch {
    return Response.json(
      { error: "Couldn't suggest careers — try again." },
      { status: 200 },
    );
  }
}
