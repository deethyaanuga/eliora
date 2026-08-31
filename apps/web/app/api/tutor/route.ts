import OpenAI from "openai";
import {
  ELIORA_SUMMARY_MODEL,
  tutorPrompt,
  type QuizQuestion,
  type SessionBeat,
  type SessionRecap,
  type TutorCorrection,
  type TutorLevel,
  type TutorMode,
  type TutorPhase,
  type TutorPhrase,
  type TutorReply,
  type TutorRequest,
  type TutorTrack,
} from "@eliora/shared";

// The AI tutor: sit down for a session, get the terms a topic runs on, or hand
// her something you produced and get it marked. One endpoint, two tracks (a
// subject or a language), three modes, one shape back. Forced tool call so the
// client always knows what it's rendering, and gpt-4o-mini like the other
// forced-tool routes (a reasoning model spends its budget thinking and never
// emits the call).
//
// The conversation mode is a real session and moves through three phases. On
// "open" she speaks first — greeting, a plan for the minutes they have, and the
// one question that finds out where they are. On "work" she takes a turn at a
// time against that plan, with the clock in her prompt so she paces. On "wrap"
// she closes it: what moved, what to practise, what she'd open with next time.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CHECK_SCHEMA = {
  type: "object",
  properties: {
    question: { type: "string" },
    options: { type: "array", items: { type: "string" } },
    answerIndex: {
      type: "integer",
      description: "0-based index of the one correct option.",
    },
    explanation: {
      type: "string",
      description: "One line on why the correct answer is right.",
    },
    topic: { type: "string" },
  },
  required: ["question", "options", "answerIndex"],
} as const;

// The plan and the recap are what make the opening and closing turns a session
// rather than two more messages, and a merely-encouraged field is a field the
// model drops. So the schema is built per phase and requires the one that turn
// exists to produce.
const tutorTool = (
  phase: TutorPhase,
): OpenAI.Chat.Completions.ChatCompletionTool => ({
  type: "function",
  function: {
    name: "tutor_reply",
    description:
      "Return the tutor's reply, the corrections, and the terms worth keeping.",
    parameters: {
      type: "object",
      properties: {
        reply: {
          type: "string",
          description:
            "Converse: your answer (in the target language on the language track). Otherwise: a one-line English headline.",
        },
        replyEnglish: {
          type: "string",
          description: "Language track only: what `reply` means in English.",
        },
        replySay: {
          type: "string",
          description:
            "Language track only: plain-English respelling of `reply`, stress in CAPS.",
        },
        corrections: {
          type: "array",
          items: {
            type: "object",
            properties: {
              yours: {
                type: "string",
                description: "The exact fragment the learner wrote.",
              },
              better: {
                type: "string",
                description: "How to say it, or what is actually correct.",
              },
              why: {
                type: "string",
                description: "One plain-English line: the reason behind the fix.",
              },
            },
            required: ["yours", "better", "why"],
          },
        },
        phrases: {
          type: "array",
          items: {
            type: "object",
            properties: {
              target: {
                type: "string",
                description:
                  "The phrase in the target language, or the key term/formula.",
              },
              english: { type: "string", description: "What it means." },
              say: {
                type: "string",
                description:
                  "Language track: plain-English respelling, stress in CAPS.",
              },
              when: { type: "string", description: "When you'd actually use it." },
            },
            required: ["target", "english"],
          },
        },
        rewrite: {
          type: "string",
          description: "Check mode: their whole work, corrected, in their voice.",
        },
        rewriteEnglish: {
          type: "string",
          description: "Language track only: the corrected text, in English.",
        },
        tip: {
          type: "string",
          description: "ONE grammar/culture/concept nugget worth keeping.",
        },
        followUp: {
          type: "string",
          description: "One concrete thing to try next.",
        },
        checks: {
          type: "array",
          items: CHECK_SCHEMA,
          description: "1–3 quick multiple-choice checks on what just came up.",
        },
        note: { type: "string", description: "One warm sentence from Eliora." },
        plan: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "The beat, in a few words." },
              goal: {
                type: "string",
                description: "One line: what they can do once it's done.",
              },
              minutes: { type: "integer" },
            },
            required: ["title", "goal"],
          },
          description: "Opening turn only: the beats of today's session.",
        },
        onBeat: {
          type: "integer",
          description: "0-based index of the beat this turn is working on.",
        },
        beatDone: {
          type: "boolean",
          description: "True when this turn finished the beat it was on.",
        },
        recap: {
          type: "object",
          description: "Wrap-up turn only: where the session got to.",
          properties: {
            covered: { type: "array", items: { type: "string" } },
            landed: { type: "array", items: { type: "string" } },
            practise: { type: "array", items: { type: "string" } },
            nextTime: { type: "string" },
          },
          required: ["covered", "landed", "practise", "nextTime"],
        },
      },
      required:
        phase === "open"
          ? ["reply", "plan"]
          : phase === "wrap"
            ? ["reply", "recap"]
            : ["reply"],
    },
  },
});

const MODES: TutorMode[] = ["converse", "phrases", "check"];
const LEVELS: TutorLevel[] = ["beginner", "intermediate", "advanced"];
const TRACKS: TutorTrack[] = ["subject", "language"];
const PHASES: TutorPhase[] = ["open", "work", "wrap"];
const str = (v: unknown) =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

// A list of short lines from the model, cleaned up. Used for every arm of the
// recap, which is nothing but lists of short lines.
function lines(raw: unknown, max: number): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(str).filter((s): s is string => !!s).slice(0, max);
}

function normalizePlan(raw: unknown): SessionBeat[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((b: { title?: unknown; goal?: unknown }) => str(b?.title))
    .slice(0, 5)
    .map((b: { title: string; goal?: unknown; minutes?: unknown }) => ({
      title: b.title.trim(),
      goal: str(b.goal) || "",
      minutes:
        typeof b.minutes === "number" && b.minutes > 0
          ? Math.round(b.minutes)
          : undefined,
    }));
}

// A recap with nothing in it is worse than none — the card would render as a
// row of empty headings, which reads as the session having gone nowhere.
function normalizeRecap(raw: unknown): SessionRecap | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const recap: SessionRecap = {
    covered: lines(r.covered, 5),
    landed: lines(r.landed, 4),
    practise: lines(r.practise, 4),
    nextTime: str(r.nextTime) || "",
  };
  return recap.covered.length || recap.landed.length || recap.practise.length
    ? recap
    : undefined;
}

function normalizeChecks(raw: unknown): QuizQuestion[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (q: { question?: string; options?: unknown; answerIndex?: unknown }) =>
        str(q?.question) &&
        Array.isArray(q.options) &&
        q.options.length >= 2 &&
        typeof q.answerIndex === "number" &&
        q.answerIndex >= 0 &&
        q.answerIndex < q.options.length,
    )
    .slice(0, 3)
    .map((q: {
      question: string;
      options: unknown[];
      answerIndex: number;
      explanation?: unknown;
      topic?: unknown;
    }) => ({
      question: q.question.trim(),
      options: q.options.map(String),
      answerIndex: q.answerIndex,
      explanation: str(q.explanation),
      topic: str(q.topic),
    }));
}

// A "correction" whose fix is the same as what they wrote is really praise —
// the model slips those in ("fui → fui: correctly used past tense"). They'd
// render as a strikethrough pointing at itself, so drop them.
const same = (a: string, b: string) =>
  a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();

function normalizeCorrections(raw: unknown): TutorCorrection[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (c: { yours?: unknown; better?: unknown }) =>
        str(c?.yours) &&
        str(c?.better) &&
        !same(c.yours as string, c.better as string),
    )
    .slice(0, 8)
    .map((c: { yours: string; better: string; why?: unknown }) => ({
      yours: c.yours.trim(),
      better: c.better.trim(),
      why: str(c.why) || "",
    }));
}

// `say` is a pronunciation respelling — it only means anything on the language
// track, where the learner may not be able to sound the word out at all.
function normalizePhrases(raw: unknown, track: TutorTrack): TutorPhrase[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (p: { target?: unknown; english?: unknown }) =>
        str(p?.target) && str(p?.english),
    )
    .slice(0, 12)
    .map((p: {
      target: string;
      english: string;
      say?: unknown;
      when?: unknown;
    }) => ({
      target: p.target.trim(),
      english: p.english.trim(),
      say: track === "language" ? str(p.say) : undefined,
      when: str(p.when),
    }));
}

export async function POST(req: Request) {
  let body: TutorRequest;
  try {
    body = (await req.json()) as TutorRequest;
  } catch {
    return Response.json({ error: "Bad request." }, { status: 400 });
  }

  const mode: TutorMode = MODES.includes(body.mode) ? body.mode : "converse";
  const level: TutorLevel = LEVELS.includes(body.level)
    ? body.level
    : "beginner";
  const track: TutorTrack = TRACKS.includes(body.track) ? body.track : "subject";
  const subject = (body.subject ?? "").trim();
  const text = (body.text ?? "").trim();
  const isLang = track === "language";
  // Only the conversation is a session; the one-shot modes have no phase.
  const phase: TutorPhase =
    mode === "converse" && body.phase && PHASES.includes(body.phase)
      ? body.phase
      : "work";

  if (!subject) {
    return Response.json(
      { error: isLang ? "Pick a language first." : "Pick a subject first." },
      { status: 200 },
    );
  }
  // She speaks first when the session opens and last when it closes — neither
  // turn is waiting on the learner to type anything.
  if (!text && phase === "work") {
    return Response.json(
      {
        error:
          mode === "phrases"
            ? isLang
              ? "Tell me the situation you need phrases for."
              : "Tell me the topic you need the terms for."
            : mode === "check"
              ? isLang
                ? "Paste what you wrote and I'll check it."
                : "Paste your work and I'll check it."
              : isLang
                ? "Say something and I'll answer."
                : "Tell me what you're working on and I'll help.",
      },
      { status: 200 },
    );
  }

  // The opening and closing turns have no learner message to carry, so the user
  // turn is the stage direction instead: they've sat down, or the clock's gone.
  const goal = str(body.goal);
  const intro =
    phase === "open"
      ? `[Your learner has just sat down for a ${
          body.planMinutes ?? 30
        }-minute ${subject} session. They haven't said anything yet.${
          goal ? ` They said they want to work on: ${goal}` : ""
        } Open the session.]`
      : phase === "wrap"
        ? `[Time's up on today's ${subject} session. Close it out and tell them where they got to.]`
        : mode === "phrases"
          ? isLang
            ? `The situation I need ${subject} for:\n${text}`
            : `The ${subject} topic I need the key terms for:\n${text}`
          : mode === "check"
            ? isLang
              ? `Here's my ${subject} — please check it:\n${text}`
              : `Here's my ${subject} work — please check it:\n${text}`
            : text;

  try {
    const client = new OpenAI();
    const completion = await client.chat.completions.create({
      model: ELIORA_SUMMARY_MODEL,
      max_completion_tokens: 2200,
      messages: [
        {
          role: "system",
          content: tutorPrompt({
            ...body,
            mode,
            track,
            level,
            subject,
            text,
            phase,
          }),
        },
        { role: "user", content: intro },
      ],
      tools: [tutorTool(phase)],
      tool_choice: { type: "function", function: { name: "tutor_reply" } },
    });

    const call = completion.choices[0]?.message?.tool_calls?.[0];
    const args = JSON.parse(
      (call && "function" in call ? call.function.arguments : "") || "{}",
    );

    const reply = str(args.reply);
    const corrections = normalizeCorrections(args.corrections);
    const phrases = normalizePhrases(args.phrases, track);
    const note = str(args.note);
    // Only the opening turn sets the plan; a later turn that invents a new one
    // would silently reshuffle the board under the learner.
    const plan = phase === "open" ? normalizePlan(args.plan) : undefined;
    const recap = phase === "wrap" ? normalizeRecap(args.recap) : undefined;

    // Nothing to say and nothing to show — usually the ask was too vague. Her
    // own note names what's missing, so it's the most useful thing to surface.
    if (!reply && !corrections.length && !phrases.length && !recap && !plan?.length) {
      return Response.json(
        {
          error:
            note || "I couldn't work with that yet — try adding a bit more.",
        },
        { status: 200 },
      );
    }

    const answer: TutorReply = {
      mode,
      track,
      reply: reply || "",
      // Outside converse, `reply` is already an English headline — a gloss and
      // a respelling of it ("SO-lid — THREE tense slips to FIX") are noise. On
      // the subject track she's speaking English throughout, so neither applies.
      replyEnglish:
        isLang && mode === "converse" ? str(args.replyEnglish) : undefined,
      replySay: isLang && mode === "converse" ? str(args.replySay) : undefined,
      corrections,
      phrases,
      rewrite: mode === "check" ? str(args.rewrite) : undefined,
      rewriteEnglish:
        isLang && mode === "check" ? str(args.rewriteEnglish) : undefined,
      tip: str(args.tip),
      // The UI already says "Try saying:" — the model likes to say it too.
      followUp: str(args.followUp)?.replace(/^try (saying|this):?\s*/i, ""),
      checks: normalizeChecks(args.checks),
      note,
      plan: plan?.length ? plan : undefined,
      // She moves the board; the client just follows it. Clamped to the plan we
      // know about so a hallucinated index can't blank the agenda.
      onBeat:
        typeof args.onBeat === "number" && args.onBeat >= 0
          ? Math.min(
              Math.round(args.onBeat),
              Math.max((plan?.length ?? body.plan?.length ?? 1) - 1, 0),
            )
          : undefined,
      beatDone: args.beatDone === true,
      recap,
    };

    return Response.json({ answer });
  } catch {
    return Response.json(
      { error: "Sorry, I couldn't put that together. Please try again." },
      { status: 200 },
    );
  }
}
