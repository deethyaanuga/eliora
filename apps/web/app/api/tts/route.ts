import OpenAI from "openai";
import {
  ELIORA_TTS_MODEL,
  ELIORA_TTS_VOICE,
  ELIORA_TTS_VOICES,
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

  const input = text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text;
  const voice = pickVoice(body.voice);
  const speed =
    typeof body.speed === "number" && body.speed >= 0.25 && body.speed <= 4
      ? body.speed
      : 1;

  try {
    const client = new OpenAI(); // reads OPENAI_API_KEY; throws if missing
    const speech = await client.audio.speech.create({
      // Override with OPENAI_TTS_MODEL (e.g. "tts-1") if your OpenAI project
      // doesn't have access to the default gpt-4o-mini-tts model.
      model: process.env.OPENAI_TTS_MODEL || ELIORA_TTS_MODEL,
      voice,
      input,
      speed,
      response_format: "mp3",
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
