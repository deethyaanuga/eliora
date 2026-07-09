import OpenAI from "openai";
import {
  ELIORA_SUMMARY_MODEL,
  goalSuggestionsPrompt,
  type LearnerProfile,
} from "@eliora/shared";

// Suggests a few SMART goals across horizons (short / mid / long) the learner
// could set. Returns { suggestions: [{specific, horizon, measurable?,
// timeBound?, subject?}] }. Forces a tool call for clean output.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SUGGEST_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "suggest_goals",
    description: "Return 4–6 SMART goal suggestions across time horizons.",
    parameters: {
      type: "object",
      properties: {
        suggestions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              specific: {
                type: "string",
                description: "The goal — what exactly to achieve.",
              },
              horizon: {
                type: "string",
                enum: ["short", "mid", "long"],
                description: "short = days–weeks, mid = a term, long = a year+.",
              },
              measurable: { type: "string", description: "How success is measured." },
              timeBound: { type: "string", description: "Target date YYYY-MM-DD." },
              subject: { type: "string", description: "Class/subject, if relevant." },
            },
            required: ["specific", "horizon"],
          },
        },
      },
      required: ["suggestions"],
    },
  },
};

type RawSug = {
  specific?: unknown;
  horizon?: unknown;
  measurable?: unknown;
  timeBound?: unknown;
  subject?: unknown;
};

type EventLike = { title?: string; date?: string; kind?: string };
type SuggestRequest = {
  career?: string;
  existing?: string[];
  events?: EventLike[];
  reflection?: string; // end-of-semester reflection to ground goals in
  profile?: LearnerProfile;
};

export async function POST(req: Request) {
  let body: SuggestRequest;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const today = new Date().toISOString().slice(0, 10);
  const existing = Array.isArray(body.existing)
    ? body.existing.filter((s) => typeof s === "string" && s.trim()).slice(0, 30)
    : [];
  // Upcoming calendar events (future-dated), soonest first, for grounding goals.
  const events = (Array.isArray(body.events) ? body.events : [])
    .filter(
      (e) =>
        (e?.title ?? "").trim() &&
        /^\d{4}-\d{2}-\d{2}$/.test((e?.date ?? "").trim()) &&
        (e!.date as string) >= today,
    )
    .sort((a, b) => (a.date as string).localeCompare(b.date as string))
    .slice(0, 12)
    .map((e) => `- ${e.date} (${e.kind ?? "event"}): ${e.title!.trim()}`);
  const detail = [
    (body.career ?? "").trim() ? `Career goal: ${body.career!.trim()}` : "",
    body.profile?.klass?.trim() ? `Class: ${body.profile.klass.trim()}` : "",
    body.profile?.interests?.trim()
      ? `Interests: ${body.profile.interests.trim()}`
      : "",
    body.profile?.struggles?.trim()
      ? `Struggles with: ${body.profile.struggles.trim()}`
      : "",
    `Today is ${today} (resolve any dates to YYYY-MM-DD yourself).`,
    (body.reflection ?? "").trim()
      ? `GROUND THE GOALS IN THIS end-of-semester reflection — build goals that act \
on what went well and what to improve:\n${body.reflection!.trim()}`
      : "",
    events.length
      ? `Upcoming calendar events (base short/mid goals on these; use their dates):\n${events.join("\n")}`
      : "",
    existing.length
      ? `Goals they already have (don't repeat): ${existing.join("; ")}`
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
        { role: "system", content: goalSuggestionsPrompt(body.profile) },
        { role: "user", content: detail || "Suggest some goals." },
      ],
      tools: [SUGGEST_TOOL],
      tool_choice: { type: "function", function: { name: "suggest_goals" } },
    });
    const call = completion.choices[0]?.message?.tool_calls?.[0];
    const args =
      call && "function" in call
        ? JSON.parse(call.function.arguments || "{}")
        : {};
    const horizons = ["short", "mid", "long"];
    const str = (v: unknown) =>
      typeof v === "string" && v.trim() ? v.trim() : undefined;
    const suggestions = (
      Array.isArray(args.suggestions) ? (args.suggestions as RawSug[]) : []
    )
      .filter((s) => String(s?.specific ?? "").trim())
      .slice(0, 6)
      .map((s) => {
        const tb = typeof s.timeBound === "string" ? s.timeBound.trim() : "";
        return {
          specific: String(s.specific).trim(),
          horizon: horizons.includes(s.horizon as string)
            ? (s.horizon as string)
            : "short",
          measurable: str(s.measurable),
          timeBound: /^\d{4}-\d{2}-\d{2}$/.test(tb) ? tb : undefined,
          subject: str(s.subject),
        };
      });
    if (!suggestions.length) {
      return Response.json(
        { error: "Couldn't suggest goals — try again." },
        { status: 200 },
      );
    }
    return Response.json({ suggestions });
  } catch {
    return Response.json(
      { error: "Couldn't suggest goals — try again." },
      { status: 200 },
    );
  }
}
