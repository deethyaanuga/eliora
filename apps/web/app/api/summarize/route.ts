import OpenAI from "openai";
import {
  ELIORA_SUMMARY_MODEL,
  normalizeFlashcardStyle,
  outputSystemPrompt,
  videoNotesExtractPrompt,
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
            properties: {
              front: { type: "string" },
              back: { type: "string" },
              style: {
                type: "string",
                enum: ["basic", "reversed", "qa", "cloze", "example"],
              },
            },
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

// Order the tracks worth trying: English before other languages, human-made
// before ASR. Every track is a candidate, not just the best one — a track's
// timedtext URL can come back empty (pot-gated) while the next one downloads
// fine, so giving up after the first miss loses transcripts we could have had.
function rankTracks(tracks: CaptionTrack[]): CaptionTrack[] {
  const score = (t: CaptionTrack) =>
    (t.languageCode?.startsWith("en") ? 0 : 2) + (t.kind === "asr" ? 1 : 0);
  return tracks
    .filter((t) => t.baseUrl)
    .map((t, i) => ({ t, i }))
    .sort((a, b) => score(a.t) - score(b.t) || a.i - b.i)
    .map(({ t }) => t);
}

// How long any single request to YouTube gets before we give up and move to the
// next tier. Without this a hung connection stalls the learner's whole request.
const YT_TIMEOUT_MS = 8000;

// Optional egress proxy. YouTube blocks caption fetches from datacenter IPs,
// which is the usual reason every tier below comes back empty at once; routing
// through a residential proxy is the only real fix for that. Unset → direct.
// Memoized as a promise, not a flag, so a burst of concurrent callers all await
// the same agent instead of racing past a half-initialized one.
let dispatcherPromise: Promise<unknown> | null = null;

function getProxyDispatcher(): Promise<unknown> {
  dispatcherPromise ??= (async () => {
    const proxy = process.env.YOUTUBE_PROXY_URL;
    if (!proxy) return null;
    try {
      const { ProxyAgent } = await import("undici");
      return new ProxyAgent(proxy);
    } catch {
      // undici unavailable — fall through to a direct fetch rather than fail.
      return null;
    }
  })();
  return dispatcherPromise;
}

async function ytFetch(url: string, init: RequestInit = {}) {
  const dispatcher = await getProxyDispatcher();
  return fetch(url, {
    ...init,
    signal: AbortSignal.timeout(YT_TIMEOUT_MS),
    ...(dispatcher ? { dispatcher } : {}),
  } as RequestInit);
}

// InnerTube player clients, tried in order. The timedtext URLs handed out by the
// WEB client and the watch-page scrape are gated behind a BotGuard "pot" token
// (they return an empty body), so these are the clients whose caption URLs are
// still fetchable without one. Which one works shifts over time as YouTube
// tightens different clients: measured Aug 2026, IOS and ANDROID each returned
// tracks for 5/5 sample videos while ANDROID_VR — long the only client here —
// had gone LOGIN_REQUIRED on 4 of those 5. It stays as a third string because
// which client is bot-walled depends on how hot our egress IP is. The embedded
// and TV clients (WEB_EMBEDDED_PLAYER, TVHTML5*) return playabilityStatus ERROR
// across the board and aren't worth a round trip.
const INNERTUBE_CLIENTS: {
  clientName: string;
  clientVersion: string;
  userAgent: string;
  extra: Record<string, unknown>;
}[] = [
  {
    clientName: "IOS",
    clientVersion: "20.10.4",
    userAgent:
      "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X)",
    extra: {
      deviceMake: "Apple",
      deviceModel: "iPhone16,2",
      osName: "iPhone",
      osVersion: "18.3.2.22D82",
    },
  },
  {
    clientName: "ANDROID",
    clientVersion: "20.10.38",
    userAgent: "com.google.android.youtube/20.10.38 (Linux; U; Android 15) gzip",
    extra: { androidSdkVersion: 35 },
  },
  {
    clientName: "ANDROID_VR",
    clientVersion: "1.60.19",
    userAgent:
      "com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12)",
    extra: { androidSdkVersion: 32 },
  },
];

const INNERTUBE_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";

async function tracksFromClient(
  videoId: string,
  client: (typeof INNERTUBE_CLIENTS)[number],
): Promise<CaptionTrack[]> {
  try {
    const res = await ytFetch(
      `https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_KEY}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": client.userAgent,
        },
        body: JSON.stringify({
          videoId,
          contentCheckOk: true,
          racyCheckOk: true,
          context: {
            client: {
              clientName: client.clientName,
              clientVersion: client.clientVersion,
              hl: "en",
              ...client.extra,
            },
          },
        }),
      },
    );
    if (!res.ok) return [];
    const data = (await res.json()) as {
      captions?: {
        playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[] };
      };
    };
    return data.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  } catch {
    return [];
  }
}

// Ask each InnerTube client in turn, stopping at the first that returns tracks.
// (Videos bot-walled from this IP — playabilityStatus LOGIN_REQUIRED — return no
// tracks for any client; those fall back to the paste-the-transcript workaround.)
async function getCaptionTracks(videoId: string): Promise<CaptionTrack[]> {
  for (const client of INNERTUBE_CLIENTS) {
    const tracks = await tracksFromClient(videoId, client);
    if (tracks.length) return tracks;
  }
  return [];
}

// Fallback: scrape the watch page for the embedded caption track metadata.
async function scrapeCaptionTracks(videoId: string): Promise<CaptionTrack[]> {
  try {
    const page = await ytFetch(
      `https://www.youtube.com/watch?v=${videoId}&hl=en`,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Accept-Language": "en-US,en;q=0.9",
        },
      },
    );
    const html = await page.text();
    const match = html.match(/"captionTracks":(\[.*?\}\])/);
    if (!match) return [];
    return JSON.parse(match[1]) as CaptionTrack[];
  } catch {
    return [];
  }
}

// Caption cues arrive at roughly word granularity. Video notes anchor sections
// with [mm:ss], so fold the cues into lines of about this length and stamp each
// one — enough to jump back to the right moment, without a timestamp per word.
const STAMP_EVERY_MS = 15000;

const mmss = (ms: number) => {
  const total = Math.max(0, Math.round(ms / 1000));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `[${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}]`;
};

function stampLines(cues: { ms: number; text: string }[]): string {
  const lines: string[] = [];
  let startMs = 0;
  let buf = "";
  for (const cue of cues) {
    const text = cue.text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (!buf) startMs = cue.ms;
    buf += (buf ? " " : "") + text;
    if (cue.ms - startMs >= STAMP_EVERY_MS) {
      lines.push(`${mmss(startMs)} ${buf}`);
      buf = "";
    }
  }
  if (buf) lines.push(`${mmss(startMs)} ${buf}`);
  return lines.join("\n");
}

// Download one caption track in one format and parse it into text. json3 is the
// most robust format; the caller retries as XML when it comes back empty.
// With `stamped`, the cues keep their start times as [mm:ss] line prefixes.
async function fetchTrackFormat(
  baseUrl: string,
  fmt: "json3" | "xml",
  stamped: boolean,
): Promise<string | null> {
  try {
    // For XML, strip any fmt the baseUrl already carries — bare timedtext is XML.
    const stripped = baseUrl
      .replace(/([?&])fmt=[^&]*/g, "$1")
      .replace(/\?&+/, "?")
      .replace(/&&+/g, "&")
      .replace(/[?&]$/, "");
    const url =
      fmt === "json3"
        ? `${stripped}${stripped.includes("?") ? "&" : "?"}fmt=json3`
        : stripped;
    const res = await ytFetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", "Accept-Language": "en-US,en;q=0.9" },
    });
    if (!res.ok) return null;
    const raw = await res.text();
    if (!raw.trim()) return null;

    const cues: { ms: number; text: string }[] = [];
    if (raw.trimStart().startsWith("{")) {
      const json = JSON.parse(raw) as {
        events?: { tStartMs?: number; segs?: { utf8?: string }[] }[];
      };
      for (const e of json.events ?? []) {
        cues.push({
          ms: e.tStartMs ?? 0,
          text: (e.segs ?? []).map((s) => s.utf8 ?? "").join(""),
        });
      }
    } else {
      const re = /<text[^>]*\bstart="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
      for (const m of raw.matchAll(re)) {
        cues.push({
          ms: Number(m[1]) * 1000,
          text: decodeEntities(m[2].replace(/<[^>]+>/g, " ")),
        });
      }
    }

    const text = stamped
      ? stampLines(cues)
      : cues
          .map((c) => c.text)
          .join("")
          .replace(/\s+/g, " ")
          .trim();
    return text.length > 40 ? text : null;
  } catch {
    return null;
  }
}

// A caption track can be listed but undownloadable (empty body, or json3
// rejected while bare XML works). Try both formats before writing it off.
async function fetchTrackText(
  baseUrl: string,
  stamped = false,
): Promise<string | null> {
  return (
    (await fetchTrackFormat(baseUrl, "json3", stamped)) ??
    (await fetchTrackFormat(baseUrl, "xml", stamped))
  );
}

// Best-effort YouTube transcript fetch: InnerTube player clients first,
// watch-page scrape as a fallback, then work down the ranked caption tracks
// until one actually downloads. Only when every track in every tier comes back
// empty do we surface the paste-the-transcript workaround.
async function fetchTranscript(
  videoId: string,
  stamped = false,
): Promise<string | null> {
  const seen = new Set<string>();
  for (const source of [getCaptionTracks, scrapeCaptionTracks]) {
    for (const track of rankTracks(await source(videoId))) {
      if (seen.has(track.baseUrl)) continue;
      seen.add(track.baseUrl);
      const text = await fetchTrackText(track.baseUrl, stamped);
      if (text) return text;
    }
  }
  return null;
}

// A transcript this long won't fit in one pass and still yield complete notes,
// so it goes extract-then-organize: each chunk is squeezed to its content (with
// timestamps kept), and the notes are written from the joined extracts.
const VIDEO_NOTES_SINGLE_PASS_MAX = 45000;
const VIDEO_NOTES_CHUNK = 38000;

function chunkTranscript(transcript: string, size: number): string[] {
  const chunks: string[] = [];
  let cur = "";
  for (const line of transcript.split("\n")) {
    if (cur && cur.length + line.length + 1 > size) {
      chunks.push(cur);
      cur = "";
    }
    cur += (cur ? "\n" : "") + line;
  }
  if (cur.trim()) chunks.push(cur);
  return chunks;
}

async function condenseTranscript(
  client: OpenAI,
  transcript: string,
): Promise<string> {
  const chunks = chunkTranscript(transcript, VIDEO_NOTES_CHUNK);
  const parts = await Promise.all(
    chunks.map(async (chunk, i) => {
      const completion = await client.chat.completions.create({
        model: ELIORA_SUMMARY_MODEL,
        max_completion_tokens: 2000,
        messages: [
          {
            role: "system",
            content: videoNotesExtractPrompt(i + 1, chunks.length),
          },
          { role: "user", content: chunk },
        ],
      });
      return completion.choices[0]?.message?.content?.trim() ?? "";
    }),
  );
  return parts.filter(Boolean).join("\n\n");
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

  const output = body.output ?? "summary";
  const wantsVideoNotes = output === "videonotes";

  // Build the user message content based on the source.
  let content: OpenAI.Chat.Completions.ChatCompletionUserMessageParam["content"];
  // Video notes work off the raw transcript, which may need condensing first —
  // that happens inside the stream so the learner only waits on one request.
  let transcriptForNotes: string | null = null;

  if (body.source === "text") {
    const text = body.text?.trim();
    if (!text || text.length < 20)
      return plain("Please paste a bit more text for me to summarize.");
    // The learner pasted the transcript themselves (the fallback when YouTube
    // blocks caption fetching), so treat it as one.
    if (wantsVideoNotes) transcriptForNotes = text;
    content = `Summarize these notes:\n\n${text}`;
  } else if (body.source === "video") {
    const id = body.url ? extractVideoId(body.url) : null;
    if (!id)
      return plain("That doesn't look like a YouTube link. Please check it.");
    const transcript = await fetchTranscript(id, wantsVideoNotes);
    if (!transcript)
      return plain(
        "I couldn't pull this video's transcript automatically — YouTube blocks " +
          "fetching captions from a server. Here's the quick workaround:\n\n" +
          '1. On the video, click "…more" under the title → "Show transcript".\n' +
          "2. Select all the transcript text and copy it.\n" +
          '3. Paste it into the "Notes / text" tab here, and I\'ll summarize it.',
      );
    if (wantsVideoNotes) transcriptForNotes = transcript;
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

  // Flashcards / quiz → structured JSON (a forced tool call), grounded in material.
  if (output === "flashcards" || output === "quiz") {
    try {
      const client = new OpenAI();
      const tool = output === "flashcards" ? FLASHCARDS_TOOL : QUIZ_TOOL;
      const completion = await client.chat.completions.create({
        model: ELIORA_SUMMARY_MODEL,
        max_completion_tokens: 1800,
        messages: [
          {
            role: "system",
            content: outputSystemPrompt(
              output,
              body.profile,
              normalizeFlashcardStyle(body.flashcardStyle),
            ),
          },
          { role: "user", content },
        ],
        tools: [tool],
        tool_choice: {
          type: "function",
          function: {
            name: tool.type === "function" ? tool.function.name : "",
          },
        },
      });
      const call = completion.choices[0]?.message?.tool_calls?.[0];
      const args = JSON.parse(
        (call && "function" in call ? call.function.arguments : "") || "{}",
      );
      if (output === "flashcards") {
        const cards = (args.cards ?? [])
          .filter(
            (c: { front?: string; back?: string }) =>
              c?.front?.trim() && c?.back?.trim(),
          )
          .map((c: { front: string; back: string; style?: string }) => ({
            front: c.front.trim(),
            back: c.back.trim(),
            style: normalizeFlashcardStyle(c.style),
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

        // A feature-length transcript won't yield complete notes in one pass, so
        // extract each chunk first and write the notes from the joined extracts.
        let material = content;
        if (transcriptForNotes) {
          const source =
            transcriptForNotes.length > VIDEO_NOTES_SINGLE_PASS_MAX
              ? (await condenseTranscript(client, transcriptForNotes)) ||
                transcriptForNotes.slice(0, VIDEO_NOTES_SINGLE_PASS_MAX)
              : transcriptForNotes;
          material = `Take notes from this video transcript:\n\n${source}`;
        }

        const completion = await client.chat.completions.create({
          model: ELIORA_SUMMARY_MODEL,
          // In-depth notes / study guides run longer, so give room to finish.
          // Modules repeat a full sub-structure per topic, so they run longer still.
          max_completion_tokens:
            output === "modules" || output === "videonotes" ? 3800 : 2800,
          messages: [
            { role: "system", content: outputSystemPrompt(output, body.profile) },
            { role: "user", content: material },
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
