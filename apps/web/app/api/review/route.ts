import OpenAI from "openai";
import {
  ELIORA_SUMMARY_MODEL,
  draftReviewPrompt,
  gradePoint,
  parseScore,
  type DraftFix,
  type DraftReview,
  type DraftReviewRequest,
  type RubricCheck,
  type RubricVerdict,
} from "@eliora/shared";

// Pre-submission draft review: mark the draft as the teacher would, grade first,
// then the three fixes worth making. Forced tool call so the client always gets
// the same shape, and gpt-4o-mini like the other forced-tool endpoints (it also
// reads a photo or PDF of the draft).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REVIEW_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "grade_draft",
    description:
      "Grade the draft as the teacher would, check it against the rubric, and name the highest-impact fixes.",
    parameters: {
      type: "object",
      properties: {
        grade: {
          type: "string",
          description:
            "Honest estimated grade — a letter (A+…F), or the score for a point rubric. Leave empty if you can't grade it yet.",
        },
        gradeWhy: {
          type: "string",
          description: "ONE sentence: the biggest single factor behind the grade.",
        },
        score: {
          type: "number",
          description: "Points earned — only for a point rubric.",
        },
        outOf: {
          type: "number",
          description: "Points available — only for a point rubric.",
        },
        rubric: {
          type: "array",
          description: "One entry per requirement, in the rubric's order.",
          items: {
            type: "object",
            properties: {
              requirement: {
                type: "string",
                description: "The requirement, in the rubric's own wording.",
              },
              verdict: { type: "string", enum: ["met", "partial", "missing"] },
              note: {
                type: "string",
                description:
                  "ONE line on what earns or costs it, pointing at their actual draft.",
              },
              points: {
                type: "number",
                description:
                  "Points awarded for this requirement — required when the rubric puts points on it.",
              },
              outOf: {
                type: "number",
                description: "Points available for this requirement.",
              },
            },
            required: ["requirement", "verdict", "note"],
          },
        },
        fixes: {
          type: "array",
          description: "At most 3 changes, the highest-impact one first.",
          items: {
            type: "object",
            properties: {
              where: {
                type: "string",
                description:
                  "The exact place in their draft — a paragraph, a heading, or the first few words of the sentence.",
              },
              what: {
                type: "string",
                description:
                  "The action to take. Never a rewrite or a replacement sentence.",
              },
              why: { type: "string", description: "The grade it buys back." },
            },
            required: ["where", "what"],
          },
        },
        strengths: {
          type: "array",
          items: { type: "string" },
          description: "1–2 genuine strengths, specific enough to keep.",
        },
        askFor: {
          type: "string",
          description:
            "Set INSTEAD of a grade when the draft or the brief is too thin: the one thing you need.",
        },
        note: { type: "string", description: "One warm sentence from Eliora." },
      },
      required: ["rubric", "fixes"],
    },
  },
};

const VERDICTS: RubricVerdict[] = ["met", "partial", "missing"];
const str = (v: unknown) =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;
const num = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;

// Enough of a draft to be worth marking. Below this the model will invent a
// grade out of politeness, which is exactly what we don't want.
const MIN_DRAFT = 40;
const MAX_DRAFT = 24_000;

export async function POST(req: Request) {
  let body: DraftReviewRequest;
  try {
    body = (await req.json()) as DraftReviewRequest;
  } catch {
    return Response.json({ error: "Bad request." }, { status: 400 });
  }

  const draft = (body.draft ?? "").trim().slice(0, MAX_DRAFT);
  const hasFile = !!body.fileBase64;
  if (!hasFile && draft.length < MIN_DRAFT) {
    return Response.json(
      {
        error:
          "Paste your draft (or upload it) and I'll mark it like your teacher would.",
      },
      { status: 200 },
    );
  }

  const instructions = str(body.instructions)?.slice(0, 6000);
  const prevGrade = str(body.previous?.grade);
  const previous = prevGrade
    ? {
        grade: prevGrade,
        fixes: (Array.isArray(body.previous?.fixes) ? body.previous!.fixes : [])
          .map((f) => str(f))
          .filter(Boolean)
          .slice(0, 3) as string[],
        rubric: (Array.isArray(body.previous?.rubric)
          ? body.previous!.rubric
          : []
        )
          .filter(
            (r) =>
              str(r?.requirement) && VERDICTS.includes(r?.verdict as RubricVerdict),
          )
          .slice(0, 12)
          .map((r) => ({
            requirement: String(r.requirement).trim(),
            verdict: r.verdict as RubricVerdict,
          })),
      }
    : undefined;

  const intro = [
    instructions ? `The assignment instructions / rubric:\n${instructions}` : "",
    draft ? `My draft:\n${draft}` : "",
  ]
    .filter(Boolean)
    .join("\n\n---\n\n");

  type UserContent =
    OpenAI.Chat.Completions.ChatCompletionUserMessageParam["content"];
  let userContent: UserContent = intro;
  if (hasFile) {
    const media = body.fileMediaType ?? "";
    const parts: Exclude<UserContent, string> = [
      {
        type: "text",
        text: intro || "My draft is attached — mark it before I hand it in.",
      },
    ];
    if (media === "application/pdf") {
      parts.push({
        type: "file",
        file: {
          filename: body.fileName || "draft.pdf",
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
      parts.push({
        type: "text",
        text: `My draft:\n${text.slice(0, MAX_DRAFT)}`,
      });
    }
    userContent = parts;
  }

  try {
    const client = new OpenAI();
    const completion = await client.chat.completions.create({
      model: ELIORA_SUMMARY_MODEL,
      max_completion_tokens: 2600,
      messages: [
        {
          role: "system",
          content: draftReviewPrompt({ ...body, draft, instructions, previous }),
        },
        { role: "user", content: userContent },
      ],
      tools: [REVIEW_TOOL],
      tool_choice: { type: "function", function: { name: "grade_draft" } },
    });

    const call = completion.choices[0]?.message?.tool_calls?.[0];
    const args = JSON.parse(
      (call && "function" in call ? call.function.arguments : "") || "{}",
    );

    const grade = str(args.grade);
    const askFor = str(args.askFor);
    // She's allowed to refuse to grade — a half-page of notes isn't an essay.
    // Saying what she needs beats guessing a letter.
    if (!grade && askFor) {
      return Response.json({ review: null, askFor });
    }

    const rubric: RubricCheck[] = (Array.isArray(args.rubric) ? args.rubric : [])
      .filter((r: { requirement?: unknown }) => str(r?.requirement))
      .slice(0, 12)
      .map((r: {
        requirement: string;
        verdict?: unknown;
        note?: unknown;
        points?: unknown;
        outOf?: unknown;
      }) => {
        const outOf = num(r.outOf);
        const points = num(r.points);
        return {
          requirement: r.requirement.trim(),
          // An unrecognised verdict is treated as "partial": the safe direction
          // is the one that makes them look again, not the one saying it's fine.
          verdict: VERDICTS.includes(r.verdict as RubricVerdict)
            ? (r.verdict as RubricVerdict)
            : "partial",
          note: str(r.note) || "",
          // Points only mean anything as a pair, and never more than available.
          points: outOf && points != null ? Math.min(points, outOf) : undefined,
          outOf: outOf && points != null ? outOf : undefined,
        };
      });

    // When the rubric carries points, the grade IS the sum of the lines — do the
    // addition here rather than trusting the model's own total, so the number
    // always matches the marks shown right underneath it.
    const scored = rubric.filter((r) => r.outOf != null);
    const tally =
      scored.length === rubric.length && scored.length > 0
        ? {
            score: scored.reduce((n, r) => n + (r.points ?? 0), 0),
            outOf: scored.reduce((n, r) => n + (r.outOf ?? 0), 0),
          }
        : undefined;

    const fixes: DraftFix[] = (Array.isArray(args.fixes) ? args.fixes : [])
      .filter((f: { what?: unknown }) => str(f?.what))
      .slice(0, 3)
      .map((f: { where?: unknown; what: string; why?: unknown }) => ({
        where: str(f.where) || "",
        what: f.what.trim(),
        why: str(f.why) || "",
      }));

    if (!grade && !fixes.length) {
      return Response.json(
        {
          error:
            askFor ||
            str(args.note) ||
            "I couldn't mark that yet — send me the whole draft and the instructions.",
        },
        { status: 200 },
      );
    }

    const modelScore = num(args.score);
    const modelOutOf = num(args.outOf);
    const score = tally ? tally.score : modelOutOf ? modelScore : undefined;
    const outOf = tally ? tally.outOf : modelScore != null ? modelOutOf : undefined;
    const review: DraftReview = {
      // A point rubric grades in points; the model's own letter is dropped
      // rather than shown next to a total that disagrees with it.
      grade: outOf ? `${score}/${outOf}` : grade || "",
      gradeWhy: str(args.gradeWhy) || "",
      score,
      outOf,
      rubric,
      fixes,
      strengths: (Array.isArray(args.strengths) ? args.strengths : [])
        .map((s: unknown) => str(s))
        .filter(Boolean)
        .slice(0, 2) as string[],
      askFor,
      note: str(args.note),
    };

    // The delta is arithmetic, not judgement — work it out here so the model
    // can't award itself an improvement it didn't earn.
    if (previous) {
      const from = gradePoint(previous.grade);
      const to = gradePoint(review.grade, review.score, review.outOf);
      if (from != null && to != null) {
        const delta = { from: previous.grade, steps: to - from };
        // The letter is re-estimated each pass and drifts; met/not-met is
        // countable, so it's the part of the delta the learner can rely on.
        // Only requirements marked BOTH times can be compared — the model
        // sometimes renames one, and a rename isn't progress either way.
        const was = new Map(
          previous.rubric.map((r) => [r.requirement.toLowerCase(), r.verdict]),
        );
        const shared = rubric.filter((r) =>
          was.has(r.requirement.toLowerCase()),
        );
        if (shared.length)
          Object.assign(delta, {
            total: shared.length,
            metBefore: shared.filter(
              (r) => was.get(r.requirement.toLowerCase()) === "met",
            ).length,
            metNow: shared.filter((r) => r.verdict === "met").length,
          });
        // Same points available both times means the same rubric was applied,
        // so the point movement is a fair comparison. A different total means
        // the model re-read the rubric differently and the numbers aren't.
        const before = parseScore(previous.grade);
        if (before && review.outOf === before.outOf)
          Object.assign(delta, {
            pointsBefore: before.score,
            pointsNow: review.score,
            pointsOutOf: before.outOf,
          });
        review.delta = delta;
      }
    }

    return Response.json({ review });
  } catch {
    return Response.json(
      { error: "Sorry, I couldn't mark that. Please try again." },
      { status: 200 },
    );
  }
}
