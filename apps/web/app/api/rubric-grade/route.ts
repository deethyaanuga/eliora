import OpenAI from "openai";
import {
  ELIORA_SUMMARY_MODEL,
  letterForPercent,
  rubricComparePrompt,
  rubricGradePrompt,
  type DraftChange,
  type DraftComparison,
  type RubricCriterion,
  type RubricGrade,
  type RubricGradeRequest,
  type RubricRevision,
  type RubricUpload,
} from "@eliora/shared";

// Grade an assignment against the learner's OWN rubric, and — when they send an
// earlier version — say what the revision actually bought. Forced tool call so
// the client always gets the same shape, and gpt-4o-mini like the other
// forced-tool endpoints (it also reads a photo or PDF of the marking sheet,
// which is how a rubric usually arrives).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GRADE_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "grade_by_rubric",
    description:
      "Grade the assignment against the student's rubric, line by line, and rank the edits that buy back the most points.",
    parameters: {
      type: "object",
      properties: {
        criteria: {
          type: "array",
          description:
            "One entry per rubric criterion, in the rubric's order. Never a criterion the rubric doesn't have.",
          items: {
            type: "object",
            properties: {
              criterion: {
                type: "string",
                description: "The criterion, in the rubric's own wording.",
              },
              points: {
                type: "number",
                description: "Points this work earned on this criterion.",
              },
              outOf: {
                type: "number",
                description:
                  "Points this criterion is worth, exactly as the rubric states.",
              },
              level: {
                type: "string",
                description:
                  "The performance level it landed on, if the rubric defines levels.",
              },
              evidence: {
                type: "string",
                description:
                  "A SHORT direct quote from the student's own writing that earned or cost the marks.",
              },
              why: {
                type: "string",
                description:
                  "Why this score — must account for every point not awarded.",
              },
              toFullMarks: {
                type: "string",
                description: "What would earn the remaining points.",
              },
            },
            required: ["criterion", "points", "outOf", "why"],
          },
        },
        headline: {
          type: "string",
          description: "ONE sentence: the biggest single factor behind the score.",
        },
        strengths: {
          type: "array",
          items: { type: "string" },
          description: "2–3 genuine strengths, each tied to a rubric criterion.",
        },
        weaknesses: {
          type: "array",
          items: { type: "string" },
          description: "Where the marks were actually lost, worst first.",
        },
        revisions: {
          type: "array",
          description:
            "The edits worth making, ranked by the points each one buys back — highest impact first.",
          items: {
            type: "object",
            properties: {
              criterion: {
                type: "string",
                description: "The rubric criterion this edit lifts.",
              },
              what: {
                type: "string",
                description:
                  "The action to take. Never a rewrite or a replacement sentence.",
              },
              why: { type: "string", description: "Why it moves that criterion." },
              points: {
                type: "number",
                description: "Estimated points it recovers.",
              },
            },
            required: ["what"],
          },
        },
        askFor: {
          type: "string",
          description:
            "Set INSTEAD of grading when the rubric is missing what you'd need to mark fairly: the one thing you need.",
        },
        note: { type: "string", description: "One warm sentence from Eliora." },
      },
      required: ["criteria"],
    },
  },
};

// Second pass, only when an earlier draft came with the request. Everything the
// comparison needs is required here — as one more optional field on the grader
// above it was simply never filled in.
const CHANGE_ITEM = {
  type: "object",
  properties: {
    criterion: {
      type: "string",
      description: "The rubric criterion this change affects.",
    },
    what: { type: "string", description: "What changed between the drafts." },
    why: { type: "string", description: "Why that gains or costs marks." },
    points: {
      type: "number",
      description: "Points this change was worth on that criterion.",
    },
  },
  required: ["what", "why"],
} as const;

const COMPARE_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "compare_drafts",
    description:
      "Score the earlier draft on the same rubric lines and say what the revision changed.",
    parameters: {
      type: "object",
      properties: {
        previous: {
          type: "array",
          description:
            "What the EARLIER draft scored on each criterion — one per criterion, same order, same wording.",
          items: {
            type: "object",
            properties: {
              criterion: {
                type: "string",
                description: "The criterion, worded exactly as it was graded.",
              },
              points: {
                type: "number",
                description: "Points the EARLIER draft earned on this criterion.",
              },
            },
            required: ["criterion", "points"],
          },
        },
        summary: {
          type: "string",
          description: "1–2 sentences on how the revision went overall.",
        },
        improved: {
          type: "array",
          description: "What genuinely got better.",
          items: CHANGE_ITEM,
        },
        regressed: {
          type: "array",
          description:
            "What got worse. Empty if nothing did — never invent a regression.",
          items: CHANGE_ITEM,
        },
        rewritten: {
          type: "array",
          items: { type: "string" },
          description: "Sections they substantially rewrote.",
        },
        nextEdits: {
          type: "array",
          items: { type: "string" },
          description: "What to do next, highest impact first.",
        },
      },
      required: ["previous", "summary", "improved", "regressed", "nextEdits"],
    },
  },
};

const str = (v: unknown) =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;
// Evidence is rendered inside quotation marks, so it has to actually be a
// quote. Asked for one on a line it marked full, the model fills the field with
// a dash or an ellipsis, which comes out as an empty “–” under the feedback.
const quote = (v: unknown) => {
  const s = str(v);
  return s && s.replace(/[^\p{L}\p{N}]/gu, "").length >= 4 ? s : undefined;
};
const num = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
// Points gained or lost, so a regression can come back negative.
const signed = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

// Enough of an assignment to be worth marking. Below this the model will grade
// out of politeness, which is exactly what we don't want.
const MIN_WORK = 40;
const MAX_WORK = 24_000;
const MAX_RUBRIC = 8_000;

// A rubric usually arrives as a photo of a handout or a PDF, and the assignment
// as a document — so every slot takes a file, and each is labelled going in so
// the model can't confuse the marking sheet with the work being marked.
function attach(
  parts: OpenAI.Chat.Completions.ChatCompletionContentPart[],
  file: RubricUpload | undefined,
  label: string,
) {
  if (!file?.base64) return;
  const media = file.mediaType || "";
  parts.push({ type: "text", text: label });
  if (media === "application/pdf") {
    parts.push({
      type: "file",
      file: {
        filename: file.name || "document.pdf",
        file_data: `data:application/pdf;base64,${file.base64}`,
      },
    });
  } else if (media.startsWith("image/")) {
    parts.push({
      type: "image_url",
      image_url: { url: `data:${media};base64,${file.base64}` },
    });
  } else {
    const text = Buffer.from(file.base64, "base64").toString("utf8");
    parts.push({ type: "text", text: text.slice(0, MAX_WORK) });
  }
}

export async function POST(req: Request) {
  let body: RubricGradeRequest;
  try {
    body = (await req.json()) as RubricGradeRequest;
  } catch {
    return Response.json({ error: "Bad request." }, { status: 400 });
  }

  const assignment = (body.assignment ?? "").trim().slice(0, MAX_WORK);
  const rubric = str(body.rubric)?.slice(0, MAX_RUBRIC);
  const previousDraft = str(body.previousDraft)?.slice(0, MAX_WORK);

  if (!assignment && !body.assignmentFile) {
    return Response.json(
      { error: "Paste your assignment (or upload it) and I'll grade it." },
      { status: 200 },
    );
  }
  if (assignment && !body.assignmentFile && assignment.length < MIN_WORK) {
    return Response.json(
      { error: "That's too short to mark — send me the whole assignment." },
      { status: 200 },
    );
  }
  // Without the sheet there is nothing to grade against, and guessing at
  // criteria is the one thing this feature promises never to do.
  if (!rubric && !body.rubricFile) {
    return Response.json(
      {
        error:
          "I need the rubric before I can grade this — paste it or upload a photo of the marking sheet.",
      },
      { status: 200 },
    );
  }

  const hasPrevious = !!(previousDraft || body.previousFile);

  const parts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
  if (rubric)
    parts.push({ type: "text", text: `THE RUBRIC — grade only against this:\n${rubric}` });
  attach(parts, body.rubricFile, "THE RUBRIC (attached) — grade only against this:");
  if (assignment)
    parts.push({ type: "text", text: `MY ASSIGNMENT — grade this one:\n${assignment}` });
  attach(parts, body.assignmentFile, "MY ASSIGNMENT (attached) — grade this one:");
  if (previousDraft)
    parts.push({
      type: "text",
      text: `MY EARLIER DRAFT — for comparison only, do not grade this one:\n${previousDraft}`,
    });
  attach(
    parts,
    body.previousFile,
    "MY EARLIER DRAFT (attached) — for comparison only, do not grade this one:",
  );

  try {
    const client = new OpenAI();
    const completion = await client.chat.completions.create({
      model: ELIORA_SUMMARY_MODEL,
      // A rubric line carries a quote, an explanation and a route to full marks,
      // and a comparison doubles the work — this needs more room than a review.
      max_completion_tokens: hasPrevious ? 4200 : 3200,
      messages: [
        {
          role: "system",
          content: rubricGradePrompt({ ...body, assignment, rubric, previousDraft }),
        },
        { role: "user", content: parts },
      ],
      tools: [GRADE_TOOL],
      tool_choice: { type: "function", function: { name: "grade_by_rubric" } },
    });

    const call = completion.choices[0]?.message?.tool_calls?.[0];
    const args = JSON.parse(
      (call && "function" in call ? call.function.arguments : "") || "{}",
    );

    const criteria: RubricCriterion[] = (
      Array.isArray(args.criteria) ? args.criteria : []
    )
      .filter(
        (c: { criterion?: unknown; outOf?: unknown }) =>
          str(c?.criterion) && num(c?.outOf),
      )
      .slice(0, 20)
      .map(
        (c: {
          criterion: string;
          points?: unknown;
          outOf: number;
          level?: unknown;
          evidence?: unknown;
          why?: unknown;
          toFullMarks?: unknown;
        }) => {
          const outOf = num(c.outOf)!;
          return {
            criterion: c.criterion.trim(),
            // Never more than the line is worth — a model that awards 7/5
            // makes the total, the percentage and the letter all wrong at once.
            points: Math.min(num(c.points) ?? 0, outOf),
            outOf,
            level: str(c.level),
            evidence: quote(c.evidence),
            why: str(c.why) || "",
            toFullMarks: str(c.toFullMarks),
          };
        },
      );

    const askFor = str(args.askFor);
    // She's allowed to refuse: a rubric with no point values, or a photo she
    // can't read, is a question to ask — not a sheet to invent.
    if (!criteria.length) {
      return Response.json(
        askFor
          ? { grade: null, askFor }
          : {
              error:
                str(args.note) ||
                "I couldn't read that rubric — try pasting the criteria as text.",
            },
        { status: 200 },
      );
    }

    // Told to ask when the sheet has no point values, the model sometimes gives
    // every criterion one point instead and returns a percentage the teacher
    // never set. The signature is unmistakable — a flat 1-point scale off a
    // rubric whose text never mentions points at all — so it's caught here
    // rather than shown to the student as a grade. Only checkable on a pasted
    // rubric; an uploaded photo has to rely on the prompt.
    if (
      rubric &&
      criteria.every((c) => c.outOf === 1) &&
      !/\d+\s*(?:pts?|points?|marks?)|\/\s*\d+|\d+\s*%/i.test(rubric)
    ) {
      return Response.json({
        grade: null,
        askFor:
          askFor ||
          "Your rubric doesn't say what each criterion is worth — how many points is each one? I don't want to invent a scale your teacher didn't set.",
      });
    }

    // The total is the sum of the lines, worked out here rather than taken from
    // the model, so the headline number always matches the marks shown under it.
    const score = criteria.reduce((n, c) => n + c.points, 0);
    const outOf = criteria.reduce((n, c) => n + c.outOf, 0);
    const percent = outOf > 0 ? Math.round((score / outOf) * 1000) / 10 : 0;

    const revisions: RubricRevision[] = (
      Array.isArray(args.revisions) ? args.revisions : []
    )
      .filter((r: { what?: unknown }) => str(r?.what))
      .slice(0, 5)
      .map(
        (r: {
          criterion?: unknown;
          what: string;
          why?: unknown;
          points?: unknown;
        }) => ({
          criterion: str(r.criterion),
          what: r.what.trim(),
          why: str(r.why) || "",
          points: num(r.points),
        }),
      )
      // The ranking IS the feature — priority is the points recovered, not the
      // order the model happened to write them in. Unscored edits sink.
      .sort(
        (a: RubricRevision, b: RubricRevision) =>
          (b.points ?? -1) - (a.points ?? -1),
      );

    const strings = (v: unknown, n: number) =>
      (Array.isArray(v) ? v : [])
        .map((s: unknown) => str(s))
        .filter(Boolean)
        .slice(0, n) as string[];

    const changes = (v: unknown): DraftChange[] =>
      (Array.isArray(v) ? v : [])
        .filter((c: { what?: unknown }) => str(c?.what))
        .slice(0, 5)
        .map(
          (c: {
            criterion?: unknown;
            what: string;
            why?: unknown;
            points?: unknown;
          }) => ({
            criterion: str(c.criterion),
            what: c.what.trim(),
            why: str(c.why) || "",
            points: signed(c.points),
          }),
        );

    const grade: RubricGrade = {
      score,
      outOf,
      percent,
      letter: letterForPercent(percent),
      headline: str(args.headline) || "",
      criteria,
      strengths: strings(args.strengths, 3),
      weaknesses: strings(args.weaknesses, 4),
      revisions,
      askFor,
      note: str(args.note),
    };

    // Second pass: mark the earlier draft on the lines just awarded, and say
    // what the revision bought. A failure here costs the comparison, not the
    // grade — the score above is already worth returning on its own.
    if (hasPrevious) {
      try {
        const compared = await client.chat.completions.create({
          model: ELIORA_SUMMARY_MODEL,
          max_completion_tokens: 2400,
          messages: [
            {
              role: "system",
              content: rubricComparePrompt({
                criteria,
                rubric,
                gradeLevel: body.gradeLevel,
              }),
            },
            { role: "user", content: parts },
          ],
          tools: [COMPARE_TOOL],
          tool_choice: { type: "function", function: { name: "compare_drafts" } },
        });
        const cCall = compared.choices[0]?.message?.tool_calls?.[0];
        const c = JSON.parse(
          (cCall && "function" in cCall ? cCall.function.arguments : "") || "{}",
        );

        // Match the old marks back onto the graded lines. The model is told to
        // reuse the wording but usually shortens it ("Thesis (5 pts)" for a
        // criterion graded with its full description), so a prefix match either
        // way is what actually lands — with the position as a last resort.
        const findCriterion = (name?: unknown) => {
          const q = str(name)?.toLowerCase();
          if (!q) return undefined;
          return criteria.find((r) => {
            const k = r.criterion.toLowerCase();
            return k === q || k.startsWith(q) || q.startsWith(k);
          });
        };

        const inOrder: { criterion?: unknown; points?: unknown }[] = Array.isArray(
          c.previous,
        )
          ? c.previous
          : [];
        inOrder.forEach((p, i) => {
          const row = findCriterion(p?.criterion) ?? criteria[i];
          const was = num(p?.points);
          if (row && was != null && row.was == null)
            row.was = Math.min(was, row.outOf);
        });

        // Only a full set of old marks totals to something comparable — a
        // partial one would show a gain the revision didn't earn.
        const complete = criteria.every((r) => r.was != null);
        if (!complete) criteria.forEach((r) => (r.was = undefined));
        const previousScore = complete
          ? criteria.reduce((n, r) => n + (r.was ?? 0), 0)
          : undefined;

        // Every claim about a criterion is checked against the two marks that
        // criterion actually got. The model reports the line's full value as
        // the "gain" (+5 on a line that went 2→5), and it lists a criterion it
        // still isn't happy with as a regression even when the score went UP.
        // Both are told directly by the arithmetic, so neither survives here:
        // the points become the real movement, and a "regression" that didn't
        // move down is dropped rather than shown to the student as a loss.
        const settle = (list: DraftChange[], down: boolean): DraftChange[] =>
          list.reduce<DraftChange[]>((out, ch) => {
            const row = findCriterion(ch.criterion);
            const moved = row?.was != null ? row.points - row.was : undefined;
            // A change not tied to a rubric line can't be checked, so it's left
            // as written — not every observation is about one criterion.
            if (moved == null) out.push(ch);
            else if (down ? moved < 0 : moved > 0)
              out.push({ ...ch, points: Math.abs(moved) });
            return out;
          }, []);

        const comparison: DraftComparison = {
          summary: str(c.summary) || "",
          // Arithmetic, not judgement — so the model can't award itself an
          // improvement the two scores don't actually show.
          pointsGained: previousScore != null ? score - previousScore : 0,
          previousScore,
          previousOutOf: previousScore != null ? outOf : undefined,
          improved: settle(changes(c.improved), false),
          regressed: settle(changes(c.regressed), true),
          rewritten: strings(c.rewritten, 5),
          nextEdits: strings(c.nextEdits, 4),
        };
        if (
          comparison.summary ||
          comparison.improved.length ||
          comparison.regressed.length
        )
          grade.comparison = comparison;
      } catch {
        // Grade stands; the comparison section just doesn't render.
      }
    }

    return Response.json({ grade });
  } catch {
    return Response.json(
      { error: "Sorry, I couldn't grade that. Please try again." },
      { status: 200 },
    );
  }
}
