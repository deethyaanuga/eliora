// Video feed: given the learner's subjects/topics, returns a mixed list of
// real YouTube study videos to browse and watch in the app.
//   POST { topics: string[] }  →  { items: Video[] }  or  { error: string }
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Video = {
  videoId: string;
  title: string;
  channel: string;
  url: string;
  topic: string;
};

const MAX_TOPICS = 5;
const PER_TOPIC = 8;

async function searchTopic(topic: string, key: string): Promise<Video[]> {
  const url =
    "https://www.googleapis.com/youtube/v3/search?part=snippet&type=video" +
    "&videoEmbeddable=true&safeSearch=strict" +
    `&maxResults=${PER_TOPIC}&q=${encodeURIComponent(topic + " study lesson")}&key=${key}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = (await res.json()) as {
      items?: Array<{
        id?: { videoId?: string };
        snippet?: { title?: string; channelTitle?: string };
      }>;
    };
    return (data.items ?? [])
      .filter((it) => it.id?.videoId)
      .map((it) => ({
        videoId: it.id!.videoId!,
        title: decodeEntities(it.snippet?.title ?? "Untitled"),
        channel: it.snippet?.channelTitle ?? "Unknown channel",
        url: `https://www.youtube.com/watch?v=${it.id!.videoId}`,
        topic,
      }));
  } catch {
    return [];
  }
}

// YouTube API titles come HTML-escaped (&amp;, &#39;, …).
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"');
}

export async function POST(req: Request) {
  let topics: string[];
  try {
    const body = (await req.json()) as { topics?: unknown };
    topics = (Array.isArray(body.topics) ? body.topics : [])
      .filter((t): t is string => typeof t === "string" && t.trim().length > 0)
      .map((t) => t.trim())
      .slice(0, MAX_TOPICS);
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!topics.length) {
    return Response.json({ error: "no_topics" }, { status: 400 });
  }
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) {
    return Response.json({ error: "youtube_api_key_not_configured" });
  }

  const perTopic = await Promise.all(topics.map((t) => searchTopic(t, key)));

  // Interleave topics (round-robin) so the feed mixes subjects instead of
  // showing all of one class first, and dedupe repeated videos.
  const items: Video[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < PER_TOPIC; i++) {
    for (const list of perTopic) {
      const v = list[i];
      if (v && !seen.has(v.videoId)) {
        seen.add(v.videoId);
        items.push(v);
      }
    }
  }
  return Response.json({ items });
}
