import OpenAI from "openai";
import {
  clampSessionCount,
  ELIORA_SUMMARY_MODEL,
  lessonPlanPrompt,
  transcriptForPlan,
  type ChatMessage,
  type LessonPlan,
  type LessonPlanRequest,
  type PlannedSession,
  type SessionRead,
} from "@eliora/shared";

// Turn the first tutoring session into a course of sessions: what the session
// revealed about the learner, then the plan built on that read. Forced tool call
// so the client always gets the same shape, on gpt-4o-mini like the other
// forced-tool endpoints.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PLAN_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "make_lesson_plan",
    description:
      "Return what the first session revealed about the learner, then the ordered plan for the sessions ahead.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Short name for the whole plan.",
        },
        subject: { type: "string" },
        summary: {
          type: "string",
          description: "1–2 sentences on the arc of the plan.",
        },
        read: {
          type: "object",
          description: "What the first session showed. Evidence, not guesses.",
          properties: {
            level: {
              type: "string",
              description: "Where they're starting from, in one honest line.",
            },
            strengths: {
              type: "array",
              items: { type: "string" },
              description: "2–4 specific things they already do well.",
            },
            gaps: {
              type: "array",
              items: { type: "string" },
              description:
                "2–5 things to fix, costliest first, naming the underlying misunderstanding.",
            },
            pace: {
              type: "string",
              description: "How they work best — what engaged them, what lost them.",
            },
          },
          required: ["level", "strengths", "gaps", "pace"],
        },
        sessions: {
          type: "array",
          description: "The sessions ahead, in order, each building on the last.",
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "The topic, in a few words." },
              focus: {
                type: "string",
                description: "One line: what this session is FOR.",
              },
              objectives: {
                type: "array",
                items: { type: "string" },
                description:
                  "2–4 observable things they'll be able to do afterwards, as bare verb phrases (no 'by the end you can' prefix).",
              },
              activities: {
                type: "array",
                items: { type: "string" },
                description: "What actually happens in the session.",
              },
              homework: {
                type: "string",
                description: "ONE small thing between sessions, 10 min or less.",
              },
              checkpoint: {
                type: "boolean",
                description: "True if this session reviews/checks instead of teaching new material.",
              },
            },
            required: ["title", "focus", "objectives", "activities"],
          },
        },
        nextSession: {
          type: "string",
          description: "What to open with next time, in one concrete line.",
        },
        note: { type: "string", description: "One warm sentence from Eliora." },
      },
      required: ["title", "summary", "read", "sessions", "nextSession"],
    },
  },
};

const str = (v: unknown) =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

function lines(raw: unknown, max: number): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((v) => str(v))
    .filter((v): v is string => !!v)
    .slice(0, max);
}

function normalizeSessions(raw: unknown, want: number): PlannedSession[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (s: { title?: unknown; focus?: unknown }) => str(s?.title) && str(s?.focus),
    )
    .slice(0, want)
    .map((s: Record<string, unknown>, i) => ({
      number: i + 1,
      title: String(s.title).trim(),
      focus: String(s.focus).trim(),
      objectives: lines(s.objectives, 4),
      activities: lines(s.activities, 5),
      homework: str(s.homework),
      checkpoint: s.checkpoint === true,
    }));
}

export async function POST(req: Request) {
  let body: LessonPlanRequest;
  try {
    body = (await req.json()) as LessonPlanRequest;
  } catch {
    return Response.json({ error: "Bad request." }, { status: 400 });
  }

  const messages: ChatMessage[] = Array.isArray(body.messages)
    ? body.messages.filter((m) => typeof m?.content === "string")
    : [];
  const transcript = transcriptForPlan(messages);
  // A plan off two throwaway lines is a syllabus with the learner's name on it.
  if (messages.filter((m) => m.role === "user").length < 2 || transcript.length < 120) {
    return Response.json(
      {
        error:
          "We haven't talked enough yet for a real plan. Work through something with me first — then I'll know where to start you.",
      },
      { status: 200 },
    );
  }

  const want = clampSessionCount(body.sessionCount);

  try {
    const client = new OpenAI();
    const completion = await client.chat.completions.create({
      model: ELIORA_SUMMARY_MODEL,
      max_completion_tokens: 3200,
      messages: [
        { role: "system", content: lessonPlanPrompt({ ...body, sessionCount: want }) },
        {
          role: "user",
          content: `Here is the transcript of our first session:\n\n${transcript}`,
        },
      ],
      tools: [PLAN_TOOL],
      tool_choice: { type: "function", function: { name: "make_lesson_plan" } },
    });

    const call = completion.choices[0]?.message?.tool_calls?.[0];
    const args = JSON.parse(
      (call && "function" in call ? call.function.arguments : "") || "{}",
    );

    const sessions = normalizeSessions(args.sessions, want);
    if (!sessions.length) {
      return Response.json(
        {
          error:
            str(args.note) ||
            "I couldn't read enough from that session to plan from. Tell me a bit more about what you're working on.",
        },
        { status: 200 },
      );
    }

    const read: SessionRead = {
      level: str(args.read?.level) || "",
      strengths: lines(args.read?.strengths, 4),
      gaps: lines(args.read?.gaps, 5),
      pace: str(args.read?.pace) || "",
    };

    const plan: LessonPlan = {
      title: str(args.title) || "Your lesson plan",
      subject: str(args.subject) || str(body.subject),
      summary: str(args.summary) || "",
      read,
      sessions,
      nextSession: str(args.nextSession) || sessions[0].focus,
      note: str(args.note),
    };

    return Response.json({ plan });
  } catch {
    return Response.json(
      { error: "Sorry, I couldn't put that plan together. Please try again." },
      { status: 200 },
    );
  }
}
