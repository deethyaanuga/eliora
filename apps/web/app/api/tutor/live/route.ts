import {
  realtimeVoice,
  tutorById,
  tutorLiveInstructions,
  type TutorLiveRequest,
} from "@eliora/shared";

// Mints a short-lived client secret for the OpenAI Realtime API so the browser
// can open a live voice call directly with OpenAI over WebRTC — audio never
// touches this server, only this one setup request does. The real API key
// stays here; the browser only ever sees the ephemeral token, which expires
// on its own shortly after.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REALTIME_MODEL = "gpt-realtime";

export async function POST(req: Request) {
  let body: TutorLiveRequest;
  try {
    body = (await req.json()) as TutorLiveRequest;
  } catch {
    return Response.json({ error: "Bad request." }, { status: 400 });
  }

  const subject = (body.subject ?? "").trim();
  if (!subject) {
    return Response.json(
      { error: body.track === "language" ? "Pick a language first." : "Pick a subject first." },
      { status: 200 },
    );
  }

  const persona = tutorById(body.tutor);
  const instructions = tutorLiveInstructions(body);

  try {
    const res = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        session: {
          type: "realtime",
          model: REALTIME_MODEL,
          instructions,
          audio: {
            output: { voice: realtimeVoice(persona.voice) },
            input: { transcription: { model: "gpt-4o-mini-transcribe" } },
          },
        },
      }),
    });
    if (!res.ok) {
      return Response.json(
        { error: "Couldn't start the live call. Please try again." },
        { status: 200 },
      );
    }
    const data = (await res.json()) as { value: string };
    return Response.json({ clientSecret: data.value, model: REALTIME_MODEL });
  } catch {
    return Response.json(
      { error: "Couldn't reach the server. Please try again." },
      { status: 200 },
    );
  }
}
