import OpenAI from "openai";
import {
  ELIORA_SUMMARY_MODEL,
  outputSystemPrompt,
  type SummarizeRequest,
} from "@eliora/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Tools to force structured flashcards / quiz from the material.
const FLASHCARDS_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "make_flashcards",
    description: "Return flashcards built from the material.",
    parameters: {
      type: "object",
      properties: {
        cards: {
          type: "array",
          items: {
            type: "object",
            properties: { front: { type: "string" }, back: { type: "string" } },
            required: ["front", "back"],
          },
        },
      },
      required: ["cards"],
    },
  },
};
const QUIZ_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "make_quiz",
    description: "Return a multiple-choice quiz built from the material.",
    parameters: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              question: { type: "string" },
              options: { type: "array", items: { type: "string" } },
              answerIndex: { type: "integer" },
              explanation: { type: "string" },
              topic: { type: "string" },
            },
            required: ["question", "options", "answerIndex"],
          },
        },
      },
      required: ["questions"],
    },
  },
};

function extractVideoId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname === "youtu.be") return u.pathname.slice(1) || null;
    if (u.hostname.includes("youtube.com")) {
      return u.searchParams.get("v") || u.pathname.split("/").pop() || null;
    }
  } catch {
    /* not a URL */
  }
  return null;
}

type CaptionTrack = { baseUrl: string; languageCode?: string; kind?: string };

const decodeEntities = (s: string) =>
  s
    .replace(/&#39;/g, "'")
    .replace(/&#34;/g, '"')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));

// Pick an English track if available, else any (prefer human-made over ASR).
function pickTrack(tracks: CaptionTrack[]): CaptionTrack | null {
  if (!tracks.length) return null;
  const en = tracks.filter((t) => t.languageCode?.startsWith("en"));
  const pool = en.length ? en : tracks;
  return pool.find((t) => t.kind !== "asr") ?? pool[0];
}

// Ask YouTube's InnerTube player API for the caption tracks. We use the
// ANDROID_VR client: the regular ANDROID/IOS player clients now return HTTP 400,
// and the timedtext URLs from the WEB client / watch-page scrape are gated behind
// a BotGuard "pot" token (they return an empty body). ANDROID_VR still returns
// caption tracks whose timedtext URLs are fetchable without that token. (Videos
// that are bot-walled from this IP — playabilityStatus LOGIN_REQUIRED — return no
// tracks for any client; those fall back to the paste-the-transcript workaround.)
async function getCaptionTracks(videoId: string): Promise<CaptionTrack[]> {
  try {
    const res = await fetch(
      "https://www.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent":
            "com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12)",
        },
        body: JSON.stringify({
          videoId,
          contentCheckOk: true,
          racyCheckOk: true,
          context: {
            client: {
              clientName: "ANDROID_VR",
              clientVersion: "1.60.19",
              hl: "en",
              androidSdkVersion: 32,
            },
          },
        }),
      },
    );
    const data = (await res.json()) as {
      captions?: {
        playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[] };
      };
    };
    return (
      data.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? []
    );
  } catch {
    return [];
  }
}

// Fallback: scrape the watch page for the embedded caption track metadata.
async function scrapeCaptionTracks(videoId: string): Promise<CaptionTrack[]> {
  try {
    const page = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en`, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    const html = await page.text();
    const match = html.match(/"captionTracks":(\[.*?\}\])/);
    if (!match) return [];
    return JSON.parse(match[1]) as CaptionTrack[];
  } catch {
    return [];
  }
}

// Parse a caption track. json3 is the most robust format; fall back to XML.
async function fetchTrackText(baseUrl: string): Promise<string | null> {
  try {
    const url = baseUrl.includes("fmt=")
      ? baseUrl
      : `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}fmt=json3`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", "Accept-Language": "en-US,en;q=0.9" },
    });
    const raw = await res.text();
    if (!raw.trim()) return null;

    let text = "";
    if (raw.trimStart().startsWith("{")) {
      const json = JSON.parse(raw) as {
        events?: { segs?: { utf8?: string }[] }[];
      };
      text = (json.events ?? [])
        .flatMap((e) => e.segs ?? [])
        .map((s) => s.utf8 ?? "")
        .join("");
    } else {
      text = decodeEntities(
        raw
          .replace(/<text[^>]*>/g, " ")
          .replace(/<\/text>/g, " ")
          .replace(/<[^>]+>/g, ""),
      );
    }
    text = text.replace(/\s+/g, " ").trim();
    return text.length > 40 ? text : null;
  } catch {
    return null;
  }
}

// Best-effort YouTube transcript fetch: InnerTube player API first, watch-page
// scrape as a fallback, then parse the chosen caption track.
async function fetchTranscript(videoId: string): Promise<string | null> {
  let tracks = await getCaptionTracks(videoId);
  if (!tracks.length) tracks = await scrapeCaptionTracks(videoId);
  const track = pickTrack(tracks);
  if (!track?.baseUrl) return null;
  return fetchTrackText(track.baseUrl);
}

export async function POST(req: Request) {
  let body: SummarizeRequest;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const encoder = new TextEncoder();
  const plain = (msg: string) =>
    new Response(msg, {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });

  // Build the user message content based on the source.
  let content: OpenAI.Chat.Completions.ChatCompletionUserMessageParam["content"];

  if (body.source === "text") {
    const text = body.text?.trim();
    if (!text || text.length < 20)
      return plain("Please paste a bit more text for me to summarize.");
    content = `Summarize these notes:\n\n${text}`;
  } else if (body.source === "video") {
    const id = body.url ? extractVideoId(body.url) : null;
    if (!id)
      return plain("That doesn't look like a YouTube link. Please check it.");
    const transcript = await fetchTranscript(id);
    if (!transcript)
      return plain(
        "I couldn't pull this video's transcript automatically — YouTube blocks " +
          "fetching captions from a server. Here's the quick workaround:\n\n" +
          '1. On the video, click "…more" under the title → "Show transcript".\n' +
          "2. Select all the transcript text and copy it.\n" +
          '3. Paste it into the "Notes / text" tab here, and I\'ll summarize it.',
      );
    content = `Summarize this video transcript:\n\n${transcript}`;
  } else if (body.source === "doc") {
    const media = body.fileMediaType ?? "";
    if (media === "application/pdf" && body.fileBase64) {
      content = [
        { type: "text", text: "Summarize this document." },
        {
          type: "file",
          file: {
            filename: body.fileName || "document.pdf",
            file_data: `data:application/pdf;base64,${body.fileBase64}`,
          },
        },
      ];
    } else if (media.startsWith("image/") && body.fileBase64) {
      content = [
        { type: "text", text: "Summarize the notes in this image." },
        {
          type: "image_url",
          image_url: { url: `data:${media};base64,${body.fileBase64}` },
        },
      ];
    } else if (body.text?.trim()) {
      content = `Summarize this document:\n\n${body.text.trim()}`;
    } else {
      return plain("I couldn't read that file. Try a PDF, image, or text file.");
    }
  } else {
    return plain("Unknown source.");
  }

  const output = body.output ?? "summary";

  // Flashcards / quiz → structured JSON (a forced tool call), grounded in material.
  if (output === "flashcards" || output === "quiz") {
    try {
      const client = new OpenAI();
      const tool = output === "flashcards" ? FLASHCARDS_TOOL : QUIZ_TOOL;
      const completion = await client.chat.completions.create({
        model: ELIORA_SUMMARY_MODEL,
        max_completion_tokens: 1800,
        messages: [
          { role: "system", content: outputSystemPrompt(output, body.profile) },
          { role: "user", content },
        ],
        tools: [tool],
        tool_choice: { type: "function", function: { name: tool.function.name } },
      });
      const args = JSON.parse(
        completion.choices[0]?.message?.tool_calls?.[0]?.function?.arguments ||
          "{}",
      );
      if (output === "flashcards") {
        const cards = (args.cards ?? [])
          .filter((c: { front?: string; back?: string }) => c?.front?.trim() && c?.back?.trim())
          .map((c: { front: string; back: string }) => ({
            front: c.front.trim(),
            back: c.back.trim(),
          }));
        return Response.json({ flashcards: cards });
      }
      const quiz = (args.questions ?? [])
        .filter(
          (q: { question?: string; options?: string[]; answerIndex?: number }) =>
            q?.question?.trim() &&
            Array.isArray(q.options) &&
            q.options.length >= 2 &&
            typeof q.answerIndex === "number",
        )
        .map(
          (q: {
            question: string;
            options: string[];
            answerIndex: number;
            explanation?: string;
            topic?: string;
          }) => ({
            question: q.question.trim(),
            options: q.options.map(String),
            answerIndex: q.answerIndex,
            explanation: q.explanation?.trim() || undefined,
            topic: q.topic?.trim() || undefined,
          }),
        );
      return Response.json({ quiz });
    } catch {
      return Response.json(
        { error: "Sorry, I couldn't create that. Please try again." },
        { status: 200 },
      );
    }
  }

  // Summary / study guide → streamed text.
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const client = new OpenAI(); // reads OPENAI_API_KEY; throws if missing
        const completion = await client.chat.completions.create({
          model: ELIORA_SUMMARY_MODEL,
          max_completion_tokens: 1300,
          messages: [
            { role: "system", content: outputSystemPrompt(output, body.profile) },
            { role: "user", content },
          ],
          stream: true,
        });
        for await (const chunk of completion) {
          const text = chunk.choices[0]?.delta?.content;
          if (text) controller.enqueue(encoder.encode(text));
        }
        controller.close();
      } catch (err) {
        const status = err instanceof OpenAI.APIError ? ` (${err.status})` : "";
        controller.enqueue(
          encoder.encode(`Sorry, I couldn't do that${status}. Please try again.`),
        );
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
    },
  });
}
