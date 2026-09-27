import OpenAI from "openai";
import { toFile } from "openai/uploads";
import {
  ELIORA_SUMMARY_MODEL,
  countFillerWords,
  presentationFeedbackPrompt,
  wordsPerMinute,
  type PresentationFeedback,
} from "@eliora/shared";

// The learner uploads a recorded practice take (audio or video/webm); this
// transcribes it (Whisper) and then critiques the DELIVERY — pacing, filler
// words, structure, clarity, and how closely it followed their script/notes if
// they gave one. WPM and filler-word counts are computed from the transcript
// here, not asked of the model, so the numbers always match what's actually in
// the transcript. Returns { feedback } or { error }.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FEEDBACK_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "give_presentation_feedback",
    description: "Return delivery feedback on the rehearsed presentation take.",
    parameters: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "2–3 sentence overview of how the take came across.",
        },
        strengths: {
          type: "array",
          items: { type: "string" },
          description: "2–4 genuine strengths, each grounded in the transcript.",
        },
        improvements: {
          type: "array",
          items: { type: "string" },
          description:
            "2–4 concrete, prioritized improvements — highest-impact first, " +
            "each something doable in the next take.",
        },
        scriptAlignment: {
          type: "string",
          description:
            "How well the take covered the script's talking points — what it " +
            "hit, skipped, or added. ONLY set when a script was provided.",
        },
      },
      required: ["summary", "strengths", "improvements"],
    },
  },
};

const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // Whisper's own upload cap
const MAX_DURATION_SEC = 8 * 60;
const MIN_DURATION_SEC = 3;
const MAX_SCRIPT = 4000;

const str = (v: unknown) =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

export async function POST(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ error: "Bad request." }, { status: 400 });
  }

  const take = form.get("take");
  const durationSec = Number(form.get("durationSec") ?? 0);
  const script = str(form.get("script"))?.slice(0, MAX_SCRIPT);

  if (!(take instanceof File) || take.size === 0) {
    return Response.json(
      { error: "No recording came through — try recording a take first." },
      { status: 200 },
    );
  }
  if (take.size > MAX_AUDIO_BYTES) {
    return Response.json(
      { error: "That take is too long to send for feedback — try a shorter one." },
      { status: 200 },
    );
  }
  if (!Number.isFinite(durationSec) || durationSec < MIN_DURATION_SEC) {
    return Response.json(
      { error: "That take's too short to get useful feedback on — try a longer run." },
      { status: 200 },
    );
  }
  if (durationSec > MAX_DURATION_SEC) {
    return Response.json(
      { error: "That take is too long for feedback — try a run under 8 minutes." },
      { status: 200 },
    );
  }

  try {
    const client = new OpenAI();

    const audioFile = await toFile(
      Buffer.from(await take.arrayBuffer()),
      take.name || "take.webm",
      { type: take.type || "video/webm" },
    );
    const transcription = await client.audio.transcriptions.create({
      file: audioFile,
      model: "whisper-1",
    });
    const transcript = (transcription.text || "").trim();
    if (!transcript) {
      return Response.json(
        {
          error:
            "I couldn't make out any speech in that take — check your mic and try again.",
        },
        { status: 200 },
      );
    }

    const wpm = wordsPerMinute(transcript, durationSec);
    const fillerWords = countFillerWords(transcript);

    const completion = await client.chat.completions.create({
      model: ELIORA_SUMMARY_MODEL,
      max_completion_tokens: 1400,
      messages: [
        {
          role: "system",
          content: presentationFeedbackPrompt(script),
        },
        {
          role: "user",
          content:
            `TRANSCRIPT (${wpm} words per minute):\n${transcript}` +
            (script ? `\n\nSCRIPT / notes I meant to cover:\n${script}` : ""),
        },
      ],
      tools: [FEEDBACK_TOOL],
      tool_choice: { type: "function", function: { name: "give_presentation_feedback" } },
    });

    const call = completion.choices[0]?.message?.tool_calls?.[0];
    const args = JSON.parse(
      (call && "function" in call ? call.function.arguments : "") || "{}",
    );

    const strings = (v: unknown, n: number) =>
      (Array.isArray(v) ? v : [])
        .map((s: unknown) => str(s))
        .filter(Boolean)
        .slice(0, n) as string[];

    const feedback: PresentationFeedback = {
      transcript,
      wordsPerMinute: wpm,
      fillerWords,
      summary: str(args.summary) || "",
      strengths: strings(args.strengths, 4),
      improvements: strings(args.improvements, 4),
      scriptAlignment: script ? str(args.scriptAlignment) : undefined,
    };

    if (!feedback.summary && !feedback.strengths.length && !feedback.improvements.length) {
      return Response.json(
        { error: "Sorry, I couldn't put feedback together for that take. Try again." },
        { status: 200 },
      );
    }

    return Response.json({ feedback });
  } catch {
    return Response.json(
      { error: "Sorry, I couldn't get feedback on that take right now. Please try again." },
      { status: 200 },
    );
  }
}
