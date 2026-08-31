import OpenAI from "openai";
import {
  ELIORA_TTS_INSTRUCTIONS,
  ELIORA_TTS_MODEL,
  ELIORA_TTS_VOICE,
  ELIORA_TTS_VOICES,
  speechFriendly,
  type ElioraTtsVoice,
} from "@eliora/shared";

// Natural-sounding "read aloud" — streams OpenAI speech (mp3) back to the
// browser, which plays it through an <audio> element. Same OPENAI_API_KEY as
// every other route; nothing extra to configure.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The speech API rejects very long inputs; keep it to a sane paragraph budget
// so a runaway message can't rack up cost or time out.
const MAX_CHARS = 4000;

type TtsRequest = {
  text?: string;
  voice?: string;
  speed?: number;
  /** Extra delivery direction, appended to the house style (e.g. a tutor's). */
  instructions?: string;
  /** BCP-47 tag of the language being spoken, when it isn't English. */
  lang?: string;
};

function pickVoice(voice: string | undefined): ElioraTtsVoice {
  return (ELIORA_TTS_VOICES as readonly string[]).includes(voice ?? "")
    ? (voice as ElioraTtsVoice)
    : ELIORA_TTS_VOICE;
}

export async function POST(req: Request) {
  let body: TtsRequest;
  try {
    body = (await req.json()) as TtsRequest;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const text = body.text?.trim();
  if (!text) return new Response("Text required", { status: 400 });

  // Say it the way a person would ("e.g." → "for example") before the voice
  // ever sees it — no amount of delivery direction saves a literal "arrow".
  const spoken = speechFriendly(text, body.lang);
  const input = spoken.length > MAX_CHARS ? spoken.slice(0, MAX_CHARS) : spoken;
  const voice = pickVoice(body.voice);
  const speed =
    typeof body.speed === "number" && body.speed >= 0.25 && body.speed <= 4
      ? body.speed
      : 1;

  // Override with OPENAI_TTS_MODEL (e.g. "tts-1") if your OpenAI project
  // doesn't have access to the default gpt-4o-mini-tts model.
  const model = process.env.OPENAI_TTS_MODEL || ELIORA_TTS_MODEL;
  // Only the gpt-4o-mini-tts generation is steerable; the older tts-1 models
  // reject `instructions` outright, so they just get the flatter reading.
  const steerable = model.startsWith("gpt-");
  const extra = body.instructions?.trim().slice(0, 800);
  const instructions = extra
    ? `${ELIORA_TTS_INSTRUCTIONS} ${extra}`
    : ELIORA_TTS_INSTRUCTIONS;

  try {
    const client = new OpenAI(); // reads OPENAI_API_KEY; throws if missing
    const speech = await client.audio.speech.create({
      model,
      voice,
      input,
      speed,
      response_format: "mp3",
      ...(steerable ? { instructions } : {}),
    });

    return new Response(speech.body, {
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return new Response(err instanceof Error ? err.message : "TTS failed", {
      status: 500,
    });
  }
}
