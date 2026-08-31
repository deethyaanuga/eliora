import OpenAI from "openai";
import { ELIORA_SUMMARY_MODEL } from "@eliora/shared";

// Pre-submission essay assessor: strict structured payload — predicted grade,
// four 0–100 metrics, critical fixes, and a short written analysis. Distinct
// from /api/review (teacher-style rubric marking): this one is the objective
// "engine" shape, no persona. Forced tool call so the payload always parses,
// and the client receives exactly the documented JSON shape.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type AssessRequest = {
  draft?: string;
  /** Assignment brief / rubric, if the student has one. */
  instructions?: string;
  subject?: string;
  gradeLevel?: string;
};

export type CriticalFix = {
  id: number;
  category: string;
  title: string;
  description: string;
  how_to_fix: string;
};

export type Assessment = {
  predicted_grade: string;
  metrics: {
    argument_strength: number;
    structure_flow: number;
    grammar_mechanics: number;
    vocabulary_style: number;
  };
  critical_fixes: CriticalFix[];
  detailed_analysis: {
    thesis_assessment: string;
    organization_assessment: string;
    style_and_tone: string;
  };
};

const ASSESS_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "assess_paper",
    description:
      "Return the strict assessment payload: predicted grade, metrics, critical fixes, and detailed analysis.",
    parameters: {
      type: "object",
      properties: {
        predicted_grade: {
          type: "string",
          description: "Honest predicted grade, e.g. 'B+' or '86%'. Never inflated.",
        },
        metrics: {
          type: "object",
          properties: {
            argument_strength: { type: "integer", minimum: 0, maximum: 100 },
            structure_flow: { type: "integer", minimum: 0, maximum: 100 },
            grammar_mechanics: { type: "integer", minimum: 0, maximum: 100 },
            vocabulary_style: { type: "integer", minimum: 0, maximum: 100 },
          },
          required: [
            "argument_strength",
            "structure_flow",
            "grammar_mechanics",
            "vocabulary_style",
          ],
        },
        critical_fixes: {
          type: "array",
          description:
            "The urgent issues, most damaging first. Every flaw carries its correction strategy.",
          items: {
            type: "object",
            properties: {
              category: {
                type: "string",
                description: "e.g. 'Thesis', 'Structure', 'Grammar', 'Evidence'.",
              },
              title: { type: "string", description: "Short title of the issue." },
              description: {
                type: "string",
                description: "1–2 sentences on what is wrong, pointing at their draft.",
              },
              how_to_fix: {
                type: "string",
                description:
                  "Direct, actionable instruction or a template example — guiding steps, NEVER a rewritten passage of their paper.",
              },
            },
            required: ["category", "title", "description", "how_to_fix"],
          },
        },
        detailed_analysis: {
          type: "object",
          properties: {
            thesis_assessment: {
              type: "string",
              description: "Punchy assessment of the central argument and its evidence.",
            },
            organization_assessment: {
              type: "string",
              description: "Paragraph transitions and overall flow.",
            },
            style_and_tone: {
              type: "string",
              description:
                "Passive voice, word-choice redundancy, tone appropriateness.",
            },
          },
          required: [
            "thesis_assessment",
            "organization_assessment",
            "style_and_tone",
          ],
        },
      },
      required: [
        "predicted_grade",
        "metrics",
        "critical_fixes",
        "detailed_analysis",
      ],
    },
  },
};

const SYSTEM_PROMPT = `You are an elite, objective academic essay assessor and \
writing coach, grading a student's draft BEFORE they hand it in.

Rules:
1. Grade with absolute honesty. Do not inflate the grade or the metrics — a \
score of 85+ means genuinely strong work at this level, and the four metrics \
must each reflect the draft in front of you, not each other.
2. Every flaw you flag must carry a specific correction strategy the student \
can act on.
3. NEVER rewrite the paper for them. No replacement sentences, no rewritten \
passages — give the guiding steps or a generic template so they do the work.
4. Ground every observation in their actual draft: quote the first few words \
of the sentence or name the paragraph you mean.

Call the assess_paper tool exactly once with your full assessment. Order \
critical_fixes by grade impact, most damaging first.`;

const str = (v: unknown) =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;
// Metrics arrive as "integer 0–100" by schema, but clamp anyway — a payload
// the client renders as a progress bar must never leave the range.
const metric = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v)
    ? Math.min(100, Math.max(0, Math.round(v)))
    : 0;

// Same floor as /api/review: below this the model invents a grade out of
// politeness, which is exactly what an honest assessor must not do.
const MIN_DRAFT = 40;
const MAX_DRAFT = 24_000;
const MAX_FIXES = 6;

export async function POST(req: Request) {
  let body: AssessRequest;
  try {
    body = (await req.json()) as AssessRequest;
  } catch {
    return Response.json({ error: "Bad request." }, { status: 400 });
  }

  const draft = (body.draft ?? "").trim().slice(0, MAX_DRAFT);
  if (draft.length < MIN_DRAFT) {
    return Response.json(
      { error: "Paste the full draft — there isn't enough here to assess." },
      { status: 200 },
    );
  }

  const context = [
    str(body.subject) && `Subject: ${str(body.subject)}`,
    str(body.gradeLevel) && `Grade level: ${str(body.gradeLevel)}`,
    str(body.instructions) &&
      `Assignment instructions / rubric:\n${str(body.instructions)!.slice(0, 6000)}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  try {
    const client = new OpenAI();
    const completion = await client.chat.completions.create({
      model: ELIORA_SUMMARY_MODEL,
      max_completion_tokens: 2200,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [context, `The draft:\n${draft}`]
            .filter(Boolean)
            .join("\n\n---\n\n"),
        },
      ],
      tools: [ASSESS_TOOL],
      tool_choice: { type: "function", function: { name: "assess_paper" } },
    });

    const call = completion.choices[0]?.message?.tool_calls?.[0];
    const args = JSON.parse(
      (call && "function" in call ? call.function.arguments : "") || "{}",
    );

    const predicted_grade = str(args.predicted_grade);
    if (!predicted_grade) {
      return Response.json(
        { error: "The assessor couldn't grade that draft. Please try again." },
        { status: 200 },
      );
    }

    // ids are assigned here, not by the model — they exist so the client can
    // key the list, and the model reordering or skipping numbers isn't a signal.
    const critical_fixes: CriticalFix[] = (Array.isArray(args.critical_fixes)
      ? args.critical_fixes
      : []
    )
      .filter(
        (f: Record<string, unknown>) =>
          str(f?.title) && str(f?.description) && str(f?.how_to_fix),
      )
      .slice(0, MAX_FIXES)
      .map((f: Record<string, unknown>, i: number) => ({
        id: i + 1,
        category: str(f.category) || "General",
        title: str(f.title)!,
        description: str(f.description)!,
        how_to_fix: str(f.how_to_fix)!,
      }));

    const assessment: Assessment = {
      predicted_grade,
      metrics: {
        argument_strength: metric(args.metrics?.argument_strength),
        structure_flow: metric(args.metrics?.structure_flow),
        grammar_mechanics: metric(args.metrics?.grammar_mechanics),
        vocabulary_style: metric(args.metrics?.vocabulary_style),
      },
      critical_fixes,
      detailed_analysis: {
        thesis_assessment: str(args.detailed_analysis?.thesis_assessment) || "",
        organization_assessment:
          str(args.detailed_analysis?.organization_assessment) || "",
        style_and_tone: str(args.detailed_analysis?.style_and_tone) || "",
      },
    };

    return Response.json(assessment);
  } catch {
    return Response.json(
      { error: "Sorry, the assessment failed. Please try again." },
      { status: 200 },
    );
  }
}
