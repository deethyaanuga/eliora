import OpenAI from "openai";
import {
  ELIORA_SUMMARY_MODEL,
  goalSentencePrompt,
  type LearnerProfile,
  type SmartGoal,
} from "@eliora/shared";

// Turns a learner's SMART goal survey answers into one polished, first-person
// goal sentence. Returns { statement }. Falls back to a plain local sentence if
// the model is unavailable, so saving a goal never fails on this account.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type GoalSentenceRequest = {
  goal: Partial<SmartGoal>;
  profile?: LearnerProfile;
};

// Deterministic fallback used when the model can't be reached.
function localSentence(g: Partial<SmartGoal>): string {
  const parts = [g.specific?.trim()].filter(Boolean) as string[];
  let s = parts.join("");
  if (g.timeBound) s += ` by ${g.timeBound}`;
  if (g.measurable?.trim()) s += ` (${g.measurable.trim()})`;
  if (g.relevant?.trim()) s += ` — so ${g.relevant.trim()}`;
  return s || (g.specific?.trim() ?? "");
}

export async function POST(req: Request) {
  let body: GoalSentenceRequest;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const g = body.goal ?? {};
  const specific = (g.specific ?? "").trim();
  if (!specific) {
    return Response.json({ error: "missing_specific" }, { status: 400 });
  }

  // Compose the answers into a labeled block for the model to rewrite.
  const today = new Date().toISOString().slice(0, 10);
  const lines = [
    `What (specific): ${specific}`,
    g.measurable?.trim() ? `How it's measured: ${g.measurable.trim()}` : "",
    typeof g.target === "number" ? `Numeric target: ${g.target}` : "",
    g.achievable?.trim() ? `First step / why realistic: ${g.achievable.trim()}` : "",
    g.relevant?.trim() ? `Why it matters: ${g.relevant.trim()}` : "",
    g.timeBound ? `Target date: ${g.timeBound} (today is ${today})` : "",
    g.subject?.trim() ? `Subject: ${g.subject.trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const client = new OpenAI(); // reads OPENAI_API_KEY; throws if missing
    const completion = await client.chat.completions.create({
      model: ELIORA_SUMMARY_MODEL,
      max_completion_tokens: 120,
      messages: [
        { role: "system", content: goalSentencePrompt(body.profile) },
        { role: "user", content: lines },
      ],
    });
    const statement =
      completion.choices[0]?.message?.content?.trim() || localSentence(g);
    // Strip any stray wrapping quotes the model might add.
    return Response.json({
      statement: statement.replace(/^["“]|["”]$/g, "").trim(),
    });
  } catch {
    // No key / model error — still return a usable sentence.
    return Response.json({ statement: localSentence(g) });
  }
}
