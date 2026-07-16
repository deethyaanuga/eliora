import OpenAI from "openai";
import {
  ELIORA_SUMMARY_MODEL,
  monthlyReportPrompt,
  type LearnerProfile,
} from "@eliora/shared";

// Turns one calendar month of the learner's tracked activity (effort/XP, study
// hours, active days, streak, goal progress, GPA snapshot, mistakes, what's due)
// into a warm monthly recap + a few forward focuses. Returns { message, focus }.
// Forces a tool call for clean, structured output — same shape as /api/reflection.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REPORT_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "give_monthly_report",
    description: "Return a warm monthly progress recap.",
    parameters: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "3–5 warm, specific sentences recapping the month.",
        },
        focus: {
          type: "array",
          description: "2–4 concrete focus items for next month.",
          items: { type: "string" },
        },
      },
      required: ["message", "focus"],
    },
  },
};

// Everything the client has already computed for the selected month. Numbers are
// pre-tallied client-side (the app's progress data lives in the browser), so the
// route just renders them into a prompt — it never recomputes.
type MonthlyReportRequest = {
  monthLabel?: string; // e.g. "July 2026"
  career?: string;
  xp?: number; // total XP earned in the month
  studyHours?: number; // hours studied in the month
  activeDays?: number; // days with any activity
  daysInMonth?: number;
  bestDayXp?: number;
  streak?: number; // current day streak (as of now)
  gpa?: number; // current weighted GPA
  projectedGpa?: number; // projected weighted GPA
  goalsActive?: number;
  goalsDone?: number;
  goalsDueSoon?: string[]; // goal headlines with a deadline in/near this month
  goalProgress?: string[]; // "Goal — 3/10" style progress lines
  mistakesLogged?: number; // new mistakes captured this month
  mistakesOpen?: string[]; // concepts still unresolved
  assignmentsDue?: number; // assignments due this month
  assignmentsDone?: number; // assignments completed (overall)
  quiet?: boolean; // true when the month had little/no tracked activity
  profile?: LearnerProfile;
};

export async function POST(req: Request) {
  let body: MonthlyReportRequest;
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

  const goalsDueSoon = list(body.goalsDueSoon);
  const goalProgress = list(body.goalProgress);
  const mistakesOpen = list(body.mistakesOpen);

  const detail = [
    body.monthLabel?.trim() ? `Month: ${body.monthLabel.trim()}` : "",
    body.career?.trim() ? `Career goal: ${body.career.trim()}` : "",
    body.quiet ? "This was a QUIET month — little or no tracked activity." : "",
    n(body.xp) ? `Effort this month: ${body.xp} XP` : "",
    n(body.studyHours)
      ? `Time studied: ${body.studyHours} hour${body.studyHours === 1 ? "" : "s"}`
      : "",
    n(body.activeDays)
      ? `Active days: ${body.activeDays}${
          n(body.daysInMonth) ? ` of ${body.daysInMonth}` : ""
        }`
      : "",
    n(body.bestDayXp) && body.bestDayXp! > 0
      ? `Best single day: ${body.bestDayXp} XP`
      : "",
    n(body.streak) && body.streak! > 0
      ? `Current streak: ${body.streak} day${body.streak === 1 ? "" : "s"}`
      : "",
    n(body.gpa) ? `Weighted GPA so far: ${body.gpa!.toFixed(2)}` : "",
    n(body.projectedGpa)
      ? `Projected weighted GPA: ${body.projectedGpa!.toFixed(2)}`
      : "",
    n(body.goalsDone) || n(body.goalsActive)
      ? `Goals: ${body.goalsDone ?? 0} achieved, ${body.goalsActive ?? 0} in progress`
      : "",
    goalProgress.length ? `Goal progress:\n${goalProgress.map((g) => `- ${g}`).join("\n")}` : "",
    goalsDueSoon.length
      ? `Goals with a deadline coming up: ${goalsDueSoon.join("; ")}`
      : "",
    n(body.assignmentsDue)
      ? `Assignments due this month: ${body.assignmentsDue}${
          n(body.assignmentsDone) ? ` (${body.assignmentsDone} done overall)` : ""
        }`
      : "",
    n(body.mistakesLogged) && body.mistakesLogged! > 0
      ? `New mistakes captured to work on: ${body.mistakesLogged}`
      : "",
    mistakesOpen.length
      ? `Concepts still to nail: ${mistakesOpen.slice(0, 6).join("; ")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const client = new OpenAI(); // reads OPENAI_API_KEY; throws if missing
    const completion = await client.chat.completions.create({
      model: ELIORA_SUMMARY_MODEL,
      max_completion_tokens: 500,
      messages: [
        { role: "system", content: monthlyReportPrompt(body.profile) },
        {
          role: "user",
          content: detail || "Recap my month.",
        },
      ],
      tools: [REPORT_TOOL],
      tool_choice: {
        type: "function",
        function: { name: "give_monthly_report" },
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
      .slice(0, 4);
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
