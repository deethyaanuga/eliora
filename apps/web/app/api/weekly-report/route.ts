import OpenAI from "openai";
import {
  ELIORA_SUMMARY_MODEL,
  weeklyReportPrompt,
  type LearnerProfile,
} from "@eliora/shared";

// Turns one week of the learner's tracked activity (effort/XP, study hours,
// active days, streak, subjects/topics practiced, concepts captured or still
// open, goal progress, what's due) into a warm "what you learned this week"
// recap + a few forward focuses. Returns { message, focus }. Forces a tool call
// for clean, structured output — same shape as /api/monthly-report.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REPORT_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "give_weekly_report",
    description: "Return a warm weekly recap of what the learner did and learned.",
    parameters: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description:
            "2–4 warm, specific sentences recapping what they learned this week.",
        },
        focus: {
          type: "array",
          description: "2–3 concrete focus items for next week.",
          items: { type: "string" },
        },
      },
      required: ["message", "focus"],
    },
  },
};

// Everything the client has already computed for the selected week. Numbers are
// pre-tallied client-side (the app's progress data lives in the browser), so the
// route just renders them into a prompt — it never recomputes.
type WeeklyReportRequest = {
  weekLabel?: string; // e.g. "Jul 13 – Jul 19, 2026"
  career?: string;
  xp?: number; // total XP earned in the week
  studyHours?: number; // hours studied in the week
  activeDays?: number; // days with any activity (out of 7)
  bestDayXp?: number;
  bestDayLabel?: string;
  streak?: number; // current day streak (as of now)
  topics?: string[]; // subjects/topics practiced this week
  conceptsLearned?: string[]; // concepts nailed / marked resolved
  mistakesLogged?: number; // new concepts captured to work on this week
  mistakesOpen?: string[]; // concepts still unresolved
  goalsActive?: number;
  goalsDone?: number;
  goalsDueSoon?: string[]; // goal headlines with a deadline this week
  goalProgress?: string[]; // "Goal — 3/10" style progress lines
  assignmentsDue?: number; // assignments due this week
  quiet?: boolean; // true when the week had little/no tracked activity
  profile?: LearnerProfile;
};

export async function POST(req: Request) {
  let body: WeeklyReportRequest;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const n = (v: unknown): v is number =>
    typeof v === "number" && !Number.isNaN(v);
  const list = (v: unknown): string[] =>
    (Array.isArray(v) ? v : [])
      .filter((x) => typeof x === "string" && x.trim())
      .map((x) => (x as string).trim());

  const topics = list(body.topics);
  const conceptsLearned = list(body.conceptsLearned);
  const goalsDueSoon = list(body.goalsDueSoon);
  const goalProgress = list(body.goalProgress);
  const mistakesOpen = list(body.mistakesOpen);

  const detail = [
    body.weekLabel?.trim() ? `Week: ${body.weekLabel.trim()}` : "",
    body.career?.trim() ? `Career goal: ${body.career.trim()}` : "",
    body.quiet ? "This was a QUIET week — little or no tracked activity." : "",
    n(body.xp) ? `Effort this week: ${body.xp} XP` : "",
    n(body.studyHours)
      ? `Time studied: ${body.studyHours} hour${body.studyHours === 1 ? "" : "s"}`
      : "",
    n(body.activeDays) ? `Active days: ${body.activeDays} of 7` : "",
    n(body.bestDayXp) && body.bestDayXp! > 0
      ? `Best single day: ${body.bestDayXp} XP${
          body.bestDayLabel?.trim() ? ` (${body.bestDayLabel.trim()})` : ""
        }`
      : "",
    n(body.streak) && body.streak! > 0
      ? `Current streak: ${body.streak} day${body.streak === 1 ? "" : "s"}`
      : "",
    topics.length ? `Subjects/topics practiced: ${topics.join("; ")}` : "",
    conceptsLearned.length
      ? `Concepts nailed this week: ${conceptsLearned.join("; ")}`
      : "",
    n(body.mistakesLogged) && body.mistakesLogged! > 0
      ? `New concepts captured to work on: ${body.mistakesLogged}`
      : "",
    mistakesOpen.length
      ? `Concepts still to nail: ${mistakesOpen.slice(0, 6).join("; ")}`
      : "",
    n(body.goalsDone) || n(body.goalsActive)
      ? `Goals: ${body.goalsDone ?? 0} achieved, ${body.goalsActive ?? 0} in progress`
      : "",
    goalProgress.length
      ? `Goal progress:\n${goalProgress.map((g) => `- ${g}`).join("\n")}`
      : "",
    goalsDueSoon.length
      ? `Goals with a deadline this week: ${goalsDueSoon.join("; ")}`
      : "",
    n(body.assignmentsDue) && body.assignmentsDue! > 0
      ? `Assignments due this week: ${body.assignmentsDue}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const client = new OpenAI(); // reads OPENAI_API_KEY; throws if missing
    const completion = await client.chat.completions.create({
      model: ELIORA_SUMMARY_MODEL,
      max_completion_tokens: 400,
      messages: [
        { role: "system", content: weeklyReportPrompt(body.profile) },
        {
          role: "user",
          content: detail || "Recap my week.",
        },
      ],
      tools: [REPORT_TOOL],
      tool_choice: {
        type: "function",
        function: { name: "give_weekly_report" },
      },
    });
    const call = completion.choices[0]?.message?.tool_calls?.[0];
    const args =
      call && "function" in call
        ? JSON.parse(call.function.arguments || "{}")
        : {};
    const message = String(args.message ?? "").trim();
    const focus = (Array.isArray(args.focus) ? (args.focus as unknown[]) : [])
      .filter((f) => typeof f === "string" && f.trim())
      .map((f) => (f as string).trim())
      .slice(0, 3);
    if (!message) {
      return Response.json(
        { error: "Couldn't write that recap — try again." },
        { status: 200 },
      );
    }
    return Response.json({ message, focus });
  } catch {
    return Response.json(
      { error: "Couldn't write that recap — try again." },
      { status: 200 },
    );
  }
}
