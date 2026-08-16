"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { signIn, signOut, useSession } from "next-auth/react";
import {
  buildDoubtTree,
  countDoubtHelps,
  doubtAgo,
  doubtScore,
  DOUBT_BODY_MAX,
  DOUBT_GLOBAL_SCOPE,
  DOUBT_REPLY_MAX,
  DOUBT_TITLE_MAX,
  DOUBT_WORK_MAX,
  ELIORA_DEFAULT_TUTOR,
  ELIORA_TUTORS,
  MATERIAL_MAX,
  myVote,
  sortDoubts,
  studyTipPrompt,
  tutorById,
  type Doubt,
  type DoubtGroup,
  type DoubtReplyNode,
  type DoubtSort,
  type ElioraTutor,
  type StudyMaterial,
} from "@eliora/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type Video = { videoId: string; title: string; channel: string; url: string };
// Short-form study recs that open a search on TikTok / YouTube / Instagram.
type SocialPlatform = "youtube" | "tiktok" | "instagram";
type SocialRec = {
  platform: SocialPlatform;
  title: string;
  note?: string;
  url: string;
};
const SOCIAL_META: Record<
  SocialPlatform,
  { label: string; emoji: string; color: string }
> = {
  youtube: { label: "YouTube", emoji: "▶️", color: "#ff0000" },
  tiktok: { label: "TikTok", emoji: "🎵", color: "#111111" },
  instagram: { label: "Instagram", emoji: "📸", color: "#c13584" },
};
// An anonymized peer example (mirrors StudentExample in @eliora/shared) — how
// another student worked through a similar problem, shown as a card in chat.
type StudentExample = {
  id: string;
  subject?: string;
  topic: string;
  problem: string;
  approach: string;
  tags?: string[];
  createdAt?: string;
};
// A flashcard's learning format (mirrors FlashcardStyle in @eliora/shared).
type FlashcardStyle = "basic" | "reversed" | "qa" | "cloze" | "example";
type Flashcard = { front: string; back: string; style?: FlashcardStyle };
// UI labels per style: what to call each side of the card, plus a picker label.
const FLASHCARD_STYLES: {
  key: FlashcardStyle;
  label: string;
  emoji: string;
  front: string;
  back: string;
}[] = [
  { key: "basic", label: "Term → Definition", emoji: "🃏", front: "Term", back: "Definition" },
  { key: "reversed", label: "Definition → Term", emoji: "🔄", front: "Definition", back: "Term" },
  { key: "qa", label: "Question & Answer", emoji: "❓", front: "Question", back: "Answer" },
  { key: "cloze", label: "Fill in the blank", emoji: "✏️", front: "Fill in the blank", back: "Answer" },
  { key: "example", label: "Concept → Example", emoji: "💡", front: "Concept", back: "Example" },
];
function flashcardStyleMeta(style?: FlashcardStyle) {
  return FLASHCARD_STYLES.find((s) => s.key === style) ?? FLASHCARD_STYLES[0];
}
type QuizQuestion = {
  question: string;
  options: string[];
  answerIndex: number;
  explanation?: string;
  topic?: string;
};
// A file/photo/video the learner attached to a message (mirrors ChatAttachment
// in @eliora/shared — page.tsx keeps its own client-side copies of shared types).
type Attachment = {
  kind: "image" | "video" | "file";
  name: string;
  mime: string;
  dataUrl?: string; // base64 data URL — an image, or a frame grabbed from a video
  text?: string; // extracted text, for text-based files
  note?: string; // extra context, e.g. "video · 0:42"
};
type Message = {
  role: "user" | "assistant";
  content: string;
  videos?: Video[];
  socials?: SocialRec[];
  examples?: StudentExample[];
  flashcards?: Flashcard[];
  quiz?: QuizQuestion[];
  attachments?: Attachment[];
};
type Chat = {
  id: string;
  title: string;
  messages: Message[];
  named?: boolean; // true once the user renames it (stops auto-titling)
  folderId?: string; // which chat folder it belongs to (if any)
};
type ChatFolder = { id: string; name: string };

// --- Sharing flashcards & notes with friends -------------------------------
// Eliora is local-first (everything lives in the browser, no shared backend),
// so "sharing" packs the deck or note into a link. The friend opens the link
// on any device and the app imports it — no accounts or server needed.
type SharePayload =
  | { v: 1; kind: "flashcards"; title?: string; cards: Flashcard[] }
  | { v: 1; kind: "note"; title?: string; text: string };

// URL-safe base64 that survives unicode (emoji, accents) round-trips.
function b64urlEncode(s: string): string {
  return btoa(unescape(encodeURIComponent(s)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
function b64urlDecode(s: string): string {
  const p = s.replace(/-/g, "+").replace(/_/g, "/");
  return decodeURIComponent(escape(atob(p + "=".repeat((4 - (p.length % 4)) % 4))));
}

function makeShareUrl(payload: SharePayload): string {
  const enc = b64urlEncode(JSON.stringify(payload));
  const { origin, pathname } = window.location;
  return `${origin}${pathname}?share=${enc}`;
}

// --- Chat attachments (photos / files / videos) ----------------------------
// The learner can attach things to a chat message. Photos and a still frame
// grabbed from a video become base64 images the vision model can actually see;
// text-based files are read inline; anything else travels as a labelled note.
const MAX_ATTACHMENTS = 6;
const IMG_MAX_DIM = 1024; // longest edge, px — keeps the base64 payload small
const FILE_TEXT_MAX = 12_000; // chars of a text file we send
const TEXT_LIKE =
  /\.(txt|md|markdown|csv|tsv|json|log|html?|xml|tex|srt|vtt|rtf|yml|yaml|ini|conf)$/i;

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
function fmtDuration(sec: number): string {
  if (!isFinite(sec) || sec <= 0) return "";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function loadImageEl(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image decode failed"));
    img.src = src;
  });
}

// Draw a source (image or video element) onto a canvas, scaled so its longest
// edge is at most IMG_MAX_DIM, and return a JPEG data URL.
function drawToJpeg(
  src: CanvasImageSource,
  w: number,
  h: number,
  quality = 0.85,
): string {
  const scale = Math.min(1, IMG_MAX_DIM / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  ctx.drawImage(src, 0, 0, cw, ch);
  return canvas.toDataURL("image/jpeg", quality);
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = () => reject(new Error("file read failed"));
    fr.readAsDataURL(file);
  });
}

async function imageAttachment(file: File): Promise<Attachment> {
  const raw = await readAsDataUrl(file);
  try {
    const img = await loadImageEl(raw);
    const dataUrl = drawToJpeg(img, img.naturalWidth, img.naturalHeight);
    return { kind: "image", name: file.name, mime: "image/jpeg", dataUrl };
  } catch {
    // Couldn't re-encode (rare) — fall back to the original if it's a format
    // the vision model accepts; otherwise keep it as a note only.
    const ok = /^data:image\/(png|jpe?g|webp|gif);base64,/.test(raw);
    return ok
      ? { kind: "image", name: file.name, mime: file.type || "image/*", dataUrl: raw }
      : { kind: "image", name: file.name, mime: file.type || "image/*",
          note: "couldn't prepare this image" };
  }
}

// Grab a representative still frame from a video so Eliora has something to look
// at (the model can't watch video). Seeks a little in to skip black intro frames.
function grabVideoFrame(
  url: string,
): Promise<{ frame: string; duration: number }> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "metadata";
    video.playsInline = true;
    let done = false;
    const fail = () => {
      if (done) return;
      done = true;
      reject(new Error("video frame grab failed"));
    };
    video.onloadedmetadata = () => {
      const t = Math.min(1, (video.duration || 2) / 4);
      try {
        video.currentTime = isFinite(t) ? t : 0;
      } catch {
        fail();
      }
    };
    video.onseeked = () => {
      if (done) return;
      try {
        const frame = drawToJpeg(
          video,
          video.videoWidth || 320,
          video.videoHeight || 240,
          0.8,
        );
        done = true;
        resolve({ frame, duration: video.duration || 0 });
      } catch {
        fail();
      }
    };
    video.onerror = fail;
    video.src = url;
  });
}

async function videoAttachment(file: File): Promise<Attachment> {
  const url = URL.createObjectURL(file);
  try {
    const { frame, duration } = await grabVideoFrame(url);
    const len = fmtDuration(duration);
    return {
      kind: "video",
      name: file.name,
      mime: "image/jpeg",
      dataUrl: frame,
      note: len ? `${len} long` : undefined,
    };
  } catch {
    return {
      kind: "video",
      name: file.name,
      mime: file.type || "video/*",
      note: "couldn't grab a preview frame",
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function fileAttachment(file: File): Promise<Attachment> {
  const looksText =
    /^text\//i.test(file.type) ||
    /json|xml|csv/i.test(file.type) ||
    TEXT_LIKE.test(file.name);
  if (looksText && file.size < 2_000_000) {
    try {
      const text = await file.text();
      if (text.trim()) {
        return {
          kind: "file",
          name: file.name,
          mime: file.type || "text/plain",
          text: text.slice(0, FILE_TEXT_MAX),
        };
      }
    } catch {
      /* fall through to a note */
    }
  }
  return {
    kind: "file",
    name: file.name,
    mime: file.type || "application/octet-stream",
    note: `${fmtBytes(file.size)} — I can't read this file type directly`,
  };
}

async function fileToAttachment(file: File): Promise<Attachment> {
  if (file.type.startsWith("image/")) return imageAttachment(file);
  if (file.type.startsWith("video/")) return videoAttachment(file);
  return fileAttachment(file);
}

// Read an incoming share from the URL (?share=…). Returns null if absent/bad.
function readShareFromUrl(): SharePayload | null {
  try {
    const enc = new URLSearchParams(window.location.search).get("share");
    if (!enc) return null;
    const data = JSON.parse(b64urlDecode(enc)) as SharePayload;
    if (data?.v !== 1) return null;
    if (data.kind === "flashcards" && Array.isArray(data.cards)) return data;
    if (data.kind === "note" && typeof data.text === "string") return data;
    return null;
  } catch {
    return null;
  }
}

// Try the native share sheet (lets them send to a friend via Messages, email,
// WhatsApp, AirDrop…). Falls back to copying the link. Returns what happened.
async function shareContent(
  payload: SharePayload,
): Promise<"shared" | "copied" | "error"> {
  const url = makeShareUrl(payload);
  const title =
    payload.title ||
    (payload.kind === "flashcards" ? "Flashcards from Eliora" : "Notes from Eliora");
  const text =
    payload.kind === "flashcards"
      ? `${title} — ${payload.cards.length} flashcards to study. Open in Eliora:`
      : `${title} — study notes. Open in Eliora:`;
  try {
    if (typeof navigator !== "undefined" && navigator.share) {
      await navigator.share({ title, text, url });
      return "shared";
    }
  } catch (e) {
    // AbortError = user dismissed the sheet; treat as no-op, not an error.
    if ((e as Error)?.name === "AbortError") return "error";
  }
  try {
    await navigator.clipboard.writeText(url);
    return "copied";
  } catch {
    return "error";
  }
}

// Best-effort short title for a note: its first heading/line, markdown stripped.
function noteTitle(text: string): string {
  const line = (text || "")
    .split("\n")
    .map((l) => l.replace(/^#+\s*/, "").replace(/[*_`]/g, "").trim())
    .find((l) => l.length > 0);
  if (!line) return "Study notes";
  return line.length > 60 ? line.slice(0, 60) + "…" : line;
}

// --- Focus music: connect a playlist without leaving the app ----------------
// Rather than register a developer app + OAuth with every service (Spotify app +
// secret, Apple MusicKit key + paid membership, Google/YouTube OAuth), the
// learner pastes a link to THEIR playlist and it plays inline via the service's
// own official embed. Public content plays previews for everyone and full tracks
// when they're signed into that service in the same browser — no keys, no server.
type MusicProvider = "spotify" | "apple" | "youtube";

type MusicSource = {
  id: string;
  provider: MusicProvider;
  embedUrl: string; // the service's inline player URL
  kind: string; // "Playlist" | "Album" | "Video" | … (for the little label)
  url: string; // the original pasted link, for "open in <service>"
  title?: string; // optional learner-given name
};

const MUSIC_PROVIDERS: Record<
  MusicProvider,
  { label: string; icon: string; color: string; example: string }
> = {
  spotify: {
    label: "Spotify",
    icon: "🟢",
    color: "#1DB954",
    example: "https://open.spotify.com/playlist/…",
  },
  apple: {
    label: "Apple Music",
    icon: "🍎",
    color: "#FA243C",
    example: "https://music.apple.com/…/playlist/…",
  },
  youtube: {
    label: "YouTube Music",
    icon: "▶️",
    color: "#FF0000",
    example: "https://music.youtube.com/playlist?list=…",
  },
};

// Turn a pasted Spotify / Apple Music / YouTube (Music) link into an official
// inline embed. Returns null for anything we can't play (bad URL, other host).
function parseMusicUrl(raw: string): Omit<MusicSource, "id" | "title"> | null {
  const s = (raw || "").trim();
  if (!s) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./, "").toLowerCase();

  // Spotify: open.spotify.com/{type}/{id} → open.spotify.com/embed/{type}/{id}
  if (host === "open.spotify.com") {
    const m = u.pathname.match(
      /\/(playlist|album|track|artist|show|episode)\/([A-Za-z0-9]+)/,
    );
    if (!m) return null;
    const [, type, spId] = m;
    return {
      provider: "spotify",
      embedUrl: `https://open.spotify.com/embed/${type}/${spId}?utm_source=eliora`,
      kind: type.charAt(0).toUpperCase() + type.slice(1),
      url: s,
    };
  }

  // Apple Music: music.apple.com/… → embed.music.apple.com/… (same path).
  if (host === "music.apple.com" || host === "embed.music.apple.com") {
    const kind = /\/playlist\//.test(u.pathname)
      ? "Playlist"
      : /\/album\//.test(u.pathname)
        ? "Album"
        : "Music";
    return {
      provider: "apple",
      embedUrl: `https://embed.music.apple.com${u.pathname}${u.search}`,
      kind,
      url: s,
    };
  }

  // YouTube / YouTube Music: prefer a playlist (list=…), else a single video.
  if (
    host === "music.youtube.com" ||
    host === "youtube.com" ||
    host === "m.youtube.com" ||
    host === "youtu.be"
  ) {
    const list = u.searchParams.get("list");
    if (list) {
      const listId = list.replace(/^VL/, ""); // strip the library-view prefix
      return {
        provider: "youtube",
        embedUrl: `https://www.youtube.com/embed/videoseries?list=${encodeURIComponent(listId)}`,
        kind: "Playlist",
        url: s,
      };
    }
    const vid =
      host === "youtu.be" ? u.pathname.slice(1) : u.searchParams.get("v") || "";
    if (vid) {
      return {
        provider: "youtube",
        embedUrl: `https://www.youtube.com/embed/${encodeURIComponent(vid)}`,
        kind: "Video",
        url: s,
      };
    }
    return null;
  }

  return null;
}

// Height of the inline player per provider (Apple/Spotify give compact players).
function musicEmbedHeight(provider: MusicProvider, kind: string): number {
  if (provider === "youtube") return 200; // 16:9-ish video
  if (provider === "apple") return kind === "Playlist" || kind === "Album" ? 450 : 175;
  return kind === "Track" || kind === "Episode" ? 152 : 352; // spotify
}

let chatCounter = 0;
function newChatId(): string {
  chatCounter += 1;
  return `c${Date.now().toString(36)}-${chatCounter}`;
}
function chatTitle(msgs: Message[]): string {
  const u = msgs.find((m) => m.role === "user");
  if (u) {
    const t = u.content.trim().replace(/\s+/g, " ");
    return t.length > 22 ? t.slice(0, 22) + "…" : t || "New chat";
  }
  return "New chat";
}
type LearnerProfile = {
  name?: string;
  klass: string;
  struggles: string;
  learningStyle: string;
  interests: string;
  pastSuccess: string;
  studyHabits?: string;
  biggestChallenge?: string;
  gradeYear?: string;
  subjectsStudying?: string;
  planningStyle?: string;
  sessionLength?: string;
  focusHelp?: string;
  usedStudyApp?: string;
  wantedFeature?: string;
  planBlocker?: string;
  mainGoal?: string;
  hobbies?: string;
  focusTime?: string;
  needHelpMost?: string;
};
type Milestone = {
  title: string;
  detail?: string;
  done: boolean;
  checkpoint?: boolean;
  added?: boolean; // true when the learner added this step themselves
};
type IncomingMilestone = { title: string; detail?: string; checkpoint?: boolean };

// A daily 9am–9pm time-block schedule. `blocks` maps an hour (9…20, i.e. the
// slot that starts at that hour) to what the learner plans to do then. Stamped
// with the date it's for so it starts fresh each new day.
type ScheduleKind = "study" | "break" | "class" | "other";
type ScheduleBlock = { text: string; kind: ScheduleKind };
type DaySchedule = { date: string; blocks: Record<number, ScheduleBlock> };
// The hours the schedule covers: 9:00 (9am) through the 20:00 (8–9pm) block.
const SCHEDULE_HOURS = [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
const SCHEDULE_KINDS: {
  key: ScheduleKind;
  emoji: string;
  label: string;
  color: string;
}[] = [
  { key: "study", emoji: "📚", label: "Study", color: "#2f6f4f" },
  { key: "break", emoji: "☕", label: "Break", color: "#d98a2b" },
  { key: "class", emoji: "🏫", label: "Class", color: "#3a6ea5" },
  { key: "other", emoji: "📝", label: "Other", color: "#8a8a8a" },
];
const scheduleKind = (k: ScheduleKind) =>
  SCHEDULE_KINDS.find((x) => x.key === k) ?? SCHEDULE_KINDS[0];
// "9:00 AM", "12:00 PM", "1:00 PM" … for an hour in 24h form.
function hourLabel(h: number): string {
  const period = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:00 ${period}`;
}
// Default length for a per-task focus countdown (a Pomodoro sprint).
const TIMER_DEFAULT_MIN = 25;
// "25:00" / "4:09" — seconds → mm:ss for a countdown display.
function fmtTimer(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
// A soft two-note chime when a countdown finishes. Best-effort: the AudioContext
// is unlocked by the click that started the timer, and any failure is ignored.
function playTimerChime(): void {
  try {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const now = ctx.currentTime;
    [880, 1174.66].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const t0 = now + i * 0.18;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.25, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.36);
    });
    setTimeout(() => ctx.close().catch(() => {}), 1000);
  } catch {
    /* audio not available — silent */
  }
}
type EventKind =
  | "exam"
  | "final"
  | "quiz"
  | "assignment"
  | "project"
  | "other";
type StudyEvent = {
  id: string;
  title: string;
  date: string;
  kind?: EventKind;
  tasks?: GoalTask[]; // prep checklist broken down from the event (working back from the date)
};
type Assignment = {
  id: string;
  title: string;
  subject?: string;
  due?: string;
  estMin?: number; // estimated minutes (time management)
  planDate?: string; // day the learner plans to work on it (YYYY-MM-DD)
  concern?: string; // what the learner is worried about / stuck on
  done: boolean;
};
// Turn an ISO due date (YYYY-MM-DD) into a friendly deadline for display:
// the calendar date plus a relative countdown ("in 3 days", "tomorrow",
// "overdue"). `urgent` flags anything due today/tomorrow or already past so
// the UI can highlight it. Returns null when there's no due date.
function formatDeadline(
  due: string | undefined,
  todayISO: string,
): { label: string; urgent: boolean; overdue: boolean } | null {
  if (!due) return null;
  const date = new Date(`${due}T00:00:00`);
  const dateLabel = date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year:
      date.getFullYear() === new Date(`${todayISO}T00:00:00`).getFullYear()
        ? undefined
        : "numeric",
  });
  const days = Math.round(
    (date.getTime() - new Date(`${todayISO}T00:00:00`).getTime()) / 86_400_000,
  );
  const rel =
    days < -1
      ? `${Math.abs(days)} days overdue`
      : days === -1
        ? "overdue since yesterday"
        : days === 0
          ? "due today"
          : days === 1
            ? "due tomorrow"
            : `in ${days} days`;
  return {
    label: `📅 ${dateLabel} · ${rel}`,
    urgent: days <= 1,
    overdue: days < 0,
  };
}
// A SMART goal the learner sets (Specific, Measurable, Achievable, Relevant,
// Time-bound). Only `specific` is required; `target`/`current` drive a progress bar.
type GoalTask = { title: string; done: boolean };
type GoalHorizon = "short" | "mid" | "long";
const GOAL_HORIZONS: {
  key: GoalHorizon;
  label: string;
  hint: string;
  desc: string;
  example: string;
}[] = [
  {
    key: "short",
    label: "Short-term",
    hint: "days–1 year",
    desc: "Objectives for the near future — a few days, weeks, or up to a year. Specific and realistic, they help you make steady progress toward your bigger goals.",
    example: "e.g. Finish this week's problem set; raise my quiz average to 85%.",
  },
  {
    key: "mid",
    label: "Mid-term",
    hint: "1–5 years",
    desc: "Objectives you aim to achieve over a moderate period — typically 1 to 5 years. They bridge the gap between your short- and long-term goals by building on your immediate achievements.",
    example: "e.g. Pass all my AP exams; keep a 3.5 GPA through high school.",
  },
  {
    key: "long",
    label: "Long-term",
    hint: "5+ years",
    desc: "Objectives you plan to achieve over an extended period — typically more than 5 years. They represent your broader ambitions and guide your major life or career decisions.",
    example: "e.g. Get into nursing school; become a software engineer.",
  },
];
type SmartGoal = {
  id: string;
  specific: string;
  measurable?: string;
  achievable?: string;
  relevant?: string;
  timeBound?: string; // YYYY-MM-DD
  subject?: string;
  horizon?: GoalHorizon;
  target?: number;
  current?: number;
  statement?: string; // AI-composed one-sentence version of the answers
  tasks?: GoalTask[]; // checklist of steps to achieve the goal
  rewardId?: string; // a custom reward unlocked free when this goal is achieved
  done: boolean;
};

// One entry in the mistake tracker — a specific concept the learner keeps
// getting wrong. Captured from wrong quiz answers, Eliora's log_mistake tool,
// recurring assignment-feedback issues, or manual entry. Deduped by concept
// (case-insensitive); a repeat bumps `count` + `lastSeen` instead of adding a row.
type MistakeSource = "quiz" | "chat" | "feedback" | "manual";
type Mistake = {
  id: string;
  concept: string;
  subject?: string;
  why?: string; // the misconception
  fix?: string; // the correct idea
  source: MistakeSource;
  count: number;
  createdAt: string; // ISO
  lastSeen: string; // ISO
  resolved: boolean;
};

// The long-term 4-year academic roadmap: classes + milestones per year leading
// to a destination (a college, major, or career). `done` is tracked on the
// client. AI-generated (via /api/four-year-plan or the save_four_year_plan tool)
// and editable here.
// Course level drives the weighted-GPA bonus (Honors/AP count for more).
type CourseLevel = "Regular" | "Honors" | "AP/IB" | "College";
type FourYearCourse = {
  title: string;
  note?: string;
  credits?: number;
  category?: string;
  level?: CourseLevel; // rigor → weighted-GPA bonus
  grade?: string; // letter grade earned (on done courses) → GPA
  done?: boolean;
};
type FourYearMilestone = {
  title: string;
  checkpoint?: boolean;
  done?: boolean;
};
type FourYearYear = {
  label: string;
  courses: FourYearCourse[];
  milestones: FourYearMilestone[];
};
type CreditRequirement = { subject: string; required: number };
type FourYearPlan = {
  destination: string;
  years: FourYearYear[];
  requirements?: CreditRequirement[];
  totalRequired?: number;
  gpaGoal?: number; // target weighted GPA the learner is aiming for
  projectedGrade?: string; // assumed grade for planned (ungraded) courses
};
// Answers from the 4-year-plan survey, passed to the generator. `blank` starts an
// empty skeleton instead of drafting; `advise` asks Eliora what to do next after.
type FypGenInput = {
  career: string;
  grade?: string;
  classes?: string;
  strengths?: string;
  interests?: string;
  afterPlan?: string;
  notes?: string;
  requirements?: string; // pasted graduation credit requirements
  catalog?: string; // pasted course catalog
  docs?: { base64: string; mediaType: string; name: string }[]; // uploaded docs
  blank?: boolean;
  advise?: boolean;
};

const STORAGE_KEY = "eliora-chat"; // legacy single conversation (migrated)
const CHATS_KEY = "eliora-chats";
const ACTIVE_KEY = "eliora-active-chat";
const PROFILE_KEY = "eliora-profile";
const PLAN_KEY = "eliora-plan";
const EVENTS_KEY = "eliora-events";
const MISSED_KEY = "eliora-missed";
const SUBJECTS_KEY = "eliora-subjects";
const ASSIGNMENTS_KEY = "eliora-assignments";
const GOALS_KEY = "eliora-goals";
const FOUR_YEAR_KEY = "eliora-four-year-plan";

// Multiple-choice answers for the sign-up survey questions.
const STUDY_HABIT_OPTIONS = [
  "Very consistent — I study daily",
  "Somewhat consistent — a few times a week",
  "Inconsistent — only before deadlines/exams",
  "I rarely study",
];
const CHALLENGE_OPTIONS = [
  "Procrastination",
  "Lack of focus",
  "Not knowing where to start",
  "Poor time management",
  "Low motivation",
];
const PLANNING_OPTIONS = [
  "I use a planner or app",
  "I write it on paper",
  "I mentally plan it",
  "I don't plan at all",
];
const SESSION_LENGTH_OPTIONS = [
  "Less than 30 minutes",
  "30–60 minutes",
  "1–2 hours",
  "More than 2 hours",
];
const FOCUS_HELP_OPTIONS = [
  "Music or background noise",
  "Taking frequent breaks",
  "Quiet environment",
  "Studying with others",
  "Timers (Pomodoro, etc.)",
];
const USED_APP_OPTIONS = [
  "Yes, and I liked it",
  "Yes, but I didn't like it",
  "Yes, but I stopped using it",
  "No, I haven't used one",
];
const WANTED_FEATURE_OPTIONS = [
  "Automatic study schedules",
  "Reminders and notifications",
  "Progress tracking",
  "Gamification (points, rewards)",
  "Focus timers",
];
const PLAN_BLOCKER_OPTIONS = [
  "Distractions (phone, social media)",
  "Lack of motivation",
  "Busy schedule",
  "Plan feels too strict",
  "I usually stick to my plan",
];
const MAIN_GOAL_OPTIONS = [
  "Improve grades",
  "Stay consistent",
  "Reduce stress",
  "Prepare for exams",
  "Build better habits",
];
const HOBBY_OPTIONS = [
  "Sports / Exercise",
  "Gaming",
  "Reading",
  "Music",
  "Art / Creative activities",
  "Watching videos / movies",
  "Social media / content creation",
  "Other",
];
const FOCUS_TIME_OPTIONS = [
  "Early morning",
  "Afternoon",
  "Evening",
  "Late night",
];

// Schedule-setup survey answers → the hour the learner is free and today's
// study-minute budget. Keys are the option labels shown in the survey.
const HOME_TIME_OPTIONS = [
  "Right after school (~3 PM)",
  "Late afternoon (~4–5 PM)",
  "Early evening (~6 PM)",
  "Later (~7 PM or after)",
];
const HOME_TIME_HOUR: Record<string, number> = {
  "Right after school (~3 PM)": 15,
  "Late afternoon (~4–5 PM)": 16,
  "Early evening (~6 PM)": 18,
  "Later (~7 PM or after)": 19,
};
const STUDY_BUDGET_OPTIONS = [
  "About 30 minutes",
  "About 1 hour",
  "About 2 hours",
  "As much as fits",
];
const STUDY_BUDGET_MIN: Record<string, number | undefined> = {
  "About 30 minutes": 30,
  "About 1 hour": 60,
  "About 2 hours": 120,
  "As much as fits": undefined,
};

// Sent when the learner taps "Build/Rebuild plan from our chat".
const PLAN_FROM_CHAT_PROMPT =
  "Look back over our whole conversation so far and create or update my " +
  "learning + studying plan based on what we've actually talked about — the " +
  "topics I'm working on, what I said I'm stuck on, what I've covered, and what " +
  "makes sense to do next. Also fold in anything I have due and anything I need " +
  "to review. Call save_plan with the FULL updated list (4–6 small steps with " +
  "1–2 checkpoints), then give me a short 2–3 sentence walkthrough and the one " +
  "tiny step to start with.";

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const KINDS: EventKind[] = [
  "exam",
  "final",
  "quiz",
  "assignment",
  "project",
  "other",
];
const KIND_COLOR: Record<EventKind, string> = {
  exam: "#b8742a",
  final: "#c0392b",
  quiz: "#2f6f8f",
  assignment: "#5b6660",
  project: "#7a5c9e",
  other: "#5b6660",
};

function formatDate(iso: string): string {
  const [, m, d] = iso.split("-").map(Number);
  return m && d ? `${MONTHS[m - 1]} ${d}` : iso;
}
function daysUntil(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  const target = new Date(y, (m ?? 1) - 1, d ?? 1).getTime();
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.round((target - today) / 86_400_000);
}
function countdown(iso: string): string {
  const n = daysUntil(iso);
  if (n === 0) return "Today";
  if (n === 1) return "Tomorrow";
  return n > 0 ? `in ${n} days` : `${-n}d ago`;
}
function eventId(title: string, date: string): string {
  return `${date}__${title.trim().toLowerCase()}`;
}

// Default year labels for a blank 4-year roadmap, anchored to the learner's
// grade when we can tell they're in high school; otherwise generic Year 1–4.
function blankYearLabels(grade: string): string[] {
  if (/fresh|grade\s*9|9th|ninth|high\s*school|sophomore|junior|senior/i.test(grade)) {
    return [
      "Freshman — Grade 9",
      "Sophomore — Grade 10",
      "Junior — Grade 11",
      "Senior — Grade 12",
    ];
  }
  return ["Year 1", "Year 2", "Year 3", "Year 4"];
}

// Coerce a raw roadmap (from the API, the chat stream, or storage) into our
// shape, defaulting `done` flags to false and dropping empties.
function fypNum(v: unknown): number | undefined {
  return typeof v === "number" && isFinite(v) && v >= 0 ? v : undefined;
}
function normalizeFourYearPlan(raw: unknown, fallbackDest = ""): FourYearPlan {
  const r = (raw ?? {}) as {
    destination?: unknown;
    years?: unknown;
    requirements?: unknown;
    totalRequired?: unknown;
  };
  const years = (Array.isArray(r.years) ? r.years : [])
    .slice(0, 4)
    .map((yy) => {
      const y = (yy ?? {}) as {
        label?: unknown;
        courses?: unknown;
        milestones?: unknown;
      };
      return {
        label: String(y.label ?? "").trim() || "Year",
        courses: (Array.isArray(y.courses) ? y.courses : [])
          .map((cc) => {
            const c = (cc ?? {}) as {
              title?: unknown;
              note?: unknown;
              credits?: unknown;
              category?: unknown;
              level?: unknown;
              grade?: unknown;
              done?: unknown;
            };
            return {
              title: String(c.title ?? "").trim(),
              note: c.note ? String(c.note).trim() || undefined : undefined,
              credits: fypNum(c.credits),
              category: c.category
                ? String(c.category).trim() || undefined
                : undefined,
              level: fypLevel(c.level),
              grade: fypGrade(c.grade),
              done: c.done === true,
            };
          })
          .filter((c) => c.title),
        milestones: (Array.isArray(y.milestones) ? y.milestones : [])
          .map((mm) => {
            if (typeof mm === "string") return { title: mm.trim(), done: false };
            const m = (mm ?? {}) as {
              title?: unknown;
              checkpoint?: unknown;
              done?: unknown;
            };
            return {
              title: String(m.title ?? "").trim(),
              checkpoint: m.checkpoint === true || undefined,
              done: m.done === true,
            };
          })
          .filter((m) => m.title),
      };
    })
    .filter((y) => y.label);
  const requirements = (Array.isArray(r.requirements) ? r.requirements : [])
    .map((rr) => {
      const req = (rr ?? {}) as { subject?: unknown; required?: unknown };
      return {
        subject: String(req.subject ?? "").trim(),
        required: fypNum(req.required),
      };
    })
    .filter((req): req is CreditRequirement => !!req.subject && req.required != null);
  return {
    destination: String(r.destination ?? fallbackDest ?? "").trim(),
    years,
    requirements: requirements.length ? requirements : undefined,
    totalRequired: fypNum(r.totalRequired),
    gpaGoal: fypNum((r as { gpaGoal?: unknown }).gpaGoal),
    projectedGrade: fypGrade((r as { projectedGrade?: unknown }).projectedGrade),
  };
}

// GPA scale (unweighted, 4.0) and the weighted bonus per course level. Weighted
// GPA adds the bonus so rigor (Honors/AP) is rewarded; unweighted is the plain 4.0.
const LEVEL_OPTIONS: CourseLevel[] = ["Regular", "Honors", "AP/IB", "College"];
const LEVEL_WEIGHT: Record<CourseLevel, number> = {
  Regular: 0,
  Honors: 0.5,
  "AP/IB": 1,
  College: 1,
};
const GRADE_POINTS: Record<string, number> = {
  "A+": 4, A: 4, "A-": 3.7,
  "B+": 3.3, B: 3, "B-": 2.7,
  "C+": 2.3, C: 2, "C-": 1.7,
  "D+": 1.3, D: 1, "D-": 0.7,
  F: 0,
};
const GRADE_OPTIONS = Object.keys(GRADE_POINTS);
// Grade points for a letter grade, or undefined if it isn't a graded letter.
function fypGradePoints(grade?: string): number | undefined {
  if (!grade) return undefined;
  const k = grade.trim().toUpperCase();
  return k in GRADE_POINTS ? GRADE_POINTS[k] : undefined;
}
// Coerce loose input to a known course level / letter grade (else undefined).
function fypLevel(v: unknown): CourseLevel | undefined {
  const s = typeof v === "string" ? v.trim() : "";
  return (LEVEL_OPTIONS as string[]).includes(s)
    ? (s as CourseLevel)
    : undefined;
}
function fypGrade(v: unknown): string | undefined {
  const s = typeof v === "string" ? v.trim().toUpperCase() : "";
  return s in GRADE_POINTS ? s : undefined;
}

// Credit math for a roadmap: earned (completed courses), planned (all courses),
// required (school total or sum of requirements), per-category breakdown, GPA
// (weighted + unweighted from graded done courses), per-year load, and whether
// the plan AS WRITTEN meets graduation (used for projection/warnings).
function fypCredits(plan: FourYearPlan) {
  const all = plan.years.flatMap((y) => y.courses);
  const cr = (c: FourYearCourse) =>
    typeof c.credits === "number" ? c.credits : 1;
  const earned = all.filter((c) => c.done).reduce((n, c) => n + cr(c), 0);
  const planned = all.reduce((n, c) => n + cr(c), 0);
  const reqs = plan.requirements ?? [];
  const required =
    plan.totalRequired ??
    (reqs.length ? reqs.reduce((n, r) => n + r.required, 0) : undefined);
  const byCategory = reqs.map((r) => {
    const inCat = all.filter(
      (c) =>
        (c.category ?? "").trim().toLowerCase() ===
        r.subject.trim().toLowerCase(),
    );
    return {
      subject: r.subject,
      required: r.required,
      planned: inCat.reduce((n, c) => n + cr(c), 0),
      earned: inCat.filter((c) => c.done).reduce((n, c) => n + cr(c), 0),
    };
  });
  // Credits on courses whose category matches no requirement (or is blank) are
  // invisible to the per-subject bars — surface them so a "short in Math"
  // warning isn't really just a mistagged course.
  const catNames = new Set(reqs.map((r) => r.subject.trim().toLowerCase()));
  const uncategorized = reqs.length
    ? all
        .filter((c) => !catNames.has((c.category ?? "").trim().toLowerCase()))
        .reduce((n, c) => n + cr(c), 0)
    : 0;

  // GPA: credit-weighted average over completed courses that carry a letter grade.
  let gp = 0;
  let wgp = 0;
  let gpaCredits = 0;
  for (const c of all) {
    if (!c.done) continue;
    const base = fypGradePoints(c.grade);
    if (base == null) continue;
    const w = cr(c);
    gp += base * w;
    wgp += (base + (c.level ? LEVEL_WEIGHT[c.level] : 0)) * w;
    gpaCredits += w;
  }
  const gpa = gpaCredits > 0 ? gp / gpaCredits : undefined;
  const weightedGpa = gpaCredits > 0 ? wgp / gpaCredits : undefined;

  // Per-year planned load, to flag an overloaded year (ADHD-friendly pacing).
  const perYear = plan.years.map((y) => ({
    label: y.label,
    planned: y.courses.reduce((n, c) => n + cr(c), 0),
  }));

  // Projection: does the plan as written get them to graduation? Overall shortfall
  // + any category where planned credits still fall short.
  const shortOverall = required != null ? Math.max(0, required - planned) : 0;
  const shortCats = byCategory.filter((c) => c.planned < c.required);
  const onTrack =
    required != null && shortOverall === 0 && shortCats.length === 0;

  return {
    earned,
    planned,
    required,
    byCategory,
    gpa,
    weightedGpa,
    gpaCredits,
    perYear,
    shortOverall,
    shortCats,
    onTrack,
    uncategorized,
  };
}

// Projected GPA: blend actual grades (completed, graded courses) with an ASSUMED
// grade for every remaining/ungraded course, so the learner sees where the plan is
// heading — not just what's already banked. Also works out the average grade they'd
// need on the remaining courses to reach their weighted-GPA goal.
const DEFAULT_PROJECTED_GRADE = "A-";
function fypProjection(plan: FourYearPlan) {
  const all = plan.years.flatMap((y) => y.courses);
  const cr = (c: FourYearCourse) =>
    typeof c.credits === "number" ? c.credits : 1;
  const assumed = fypGrade(plan.projectedGrade) ?? DEFAULT_PROJECTED_GRADE;
  const assumedPts = fypGradePoints(assumed) ?? 3.7;

  let gp = 0; // projected unweighted points
  let wgp = 0; // projected weighted points
  let credits = 0; // all GPA-bearing credits in the projection
  let gradedWeighted = 0; // weighted points already banked (real grades)
  let gradedCredits = 0;
  let remBonusW = 0; // level bonus on the remaining (ungraded) courses
  for (const c of all) {
    const w = cr(c);
    const real = fypGradePoints(c.grade);
    const bonus = c.level ? LEVEL_WEIGHT[c.level] : 0;
    const base = real ?? assumedPts;
    gp += base * w;
    wgp += (base + bonus) * w;
    credits += w;
    if (real != null) {
      gradedWeighted += (real + bonus) * w;
      gradedCredits += w;
    } else {
      remBonusW += bonus * w;
    }
  }
  const projectedGpa = credits > 0 ? gp / credits : undefined;
  const projectedWeightedGpa = credits > 0 ? wgp / credits : undefined;

  const goal = typeof plan.gpaGoal === "number" ? plan.gpaGoal : undefined;
  const remainingCredits = credits - gradedCredits;
  const meetsGoal =
    goal != null && projectedWeightedGpa != null
      ? projectedWeightedGpa >= goal - 0.001
      : undefined;
  // Base grade needed, on average, across the remaining courses (their level
  // bonuses are already factored out) to hit the weighted goal.
  let neededBase: number | undefined;
  if (goal != null && remainingCredits > 0) {
    neededBase =
      (goal * credits - gradedWeighted - remBonusW) / remainingCredits;
  }
  return {
    assumed,
    projectedGpa,
    projectedWeightedGpa,
    goal,
    meetsGoal,
    neededBase,
    remainingCredits,
    hasCourses: credits > 0,
  };
}
// Nearest letter grade to a grade-point value (to show a target as a letter).
function fypLetterFor(points: number): string {
  let best = GRADE_OPTIONS[0];
  let bestDiff = Infinity;
  for (const g of GRADE_OPTIONS) {
    const d = Math.abs((GRADE_POINTS[g] ?? 0) - points);
    if (d < bestDiff) {
      bestDiff = d;
      best = g;
    }
  }
  return best;
}

// Unweighted GPA for a single year, from its graded, completed courses. Undefined
// until at least one done course has a letter grade.
function fypYearGpa(year: FourYearYear): number | undefined {
  let gp = 0;
  let w = 0;
  for (const c of year.courses) {
    if (!c.done) continue;
    const pts = fypGradePoints(c.grade);
    if (pts == null) continue;
    const cr = typeof c.credits === "number" ? c.credits : 1;
    gp += pts * cr;
    w += cr;
  }
  return w > 0 ? gp / w : undefined;
}

type A11y = {
  dyslexic: boolean;
  fontScale: number; // 1 = normal; scales the whole app
  spacing: boolean;
  contrast: boolean;
  reduceMotion: boolean;
  readAloud: boolean;
  theme: Theme;
};
type Theme = "light" | "dark" | "neon" | "pastel" | "minimalist" | "anime";
// Themes that use the dark base (get the `.dark` class + dark: utilities).
const DARK_THEMES: Theme[] = ["dark", "neon"];
const THEMES: { key: Theme; label: string; emoji: string }[] = [
  { key: "light", label: "Light", emoji: "☀️" },
  { key: "dark", label: "Dark", emoji: "🌙" },
  { key: "neon", label: "Neon", emoji: "💜" },
  { key: "pastel", label: "Pastel", emoji: "🌸" },
  { key: "minimalist", label: "Minimal", emoji: "◻️" },
  { key: "anime", label: "Anime", emoji: "🎌" },
];
const A11Y_KEY = "eliora-a11y";
const FONT_STEPS = [1, 1.15, 1.3, 1.5, 1.75, 2];
// A comfortable reading zoom that grows a little on larger screens, so text
// isn't tiny on big monitors. Multiplied by the user's text-size setting.
function baseZoom(w: number): number {
  if (w < 480) return 1;
  if (w < 768) return 1.06;
  if (w < 1100) return 1.14;
  if (w < 1500) return 1.22;
  return 1.3;
}
const DEFAULT_A11Y: A11y = {
  dyslexic: false,
  fontScale: 1,
  spacing: false,
  contrast: false,
  reduceMotion: false,
  readAloud: false,
  theme: "light",
};

// OpenAI voices offered in Settings (mirrors ELIORA_TTS_VOICES in
// @eliora/shared). "nova" is the warm default the API uses when none is set.
const TTS_VOICE_KEY = "eliora-tts-voice";
const TTS_VOICES: { id: string; label: string }[] = [
  { id: "nova", label: "Nova · warm (default)" },
  { id: "alloy", label: "Alloy · neutral" },
  { id: "shimmer", label: "Shimmer · bright" },
  { id: "echo", label: "Echo · calm" },
  { id: "fable", label: "Fable · expressive" },
  { id: "onyx", label: "Onyx · deep" },
  { id: "coral", label: "Coral · friendly" },
  { id: "sage", label: "Sage · gentle" },
];

// Roughly how long `text` takes to say, used to cap waits on voices that never
// report they've finished (some browsers ship no voices at all).
function speechBudgetMs(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.min(120_000, 4_000 + words * 450);
}

// Robotic browser voice — the fallback when OpenAI TTS is unavailable.
// Resolves once it stops talking so callers can wait their turn.
function speakFallback(text: string): Promise<void> {
  return new Promise((resolve) => {
    const synth =
      typeof window === "undefined" ? null : window.speechSynthesis ?? null;
    if (!synth) return resolve();
    synth.cancel();
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(guard);
      resolve();
    };
    // Some browsers never fire onend (or have no voice installed at all), so
    // don't let a caller wait on it forever.
    const guard = window.setTimeout(finish, speechBudgetMs(text));
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 0.95;
    u.onend = finish;
    u.onerror = finish;
    synth.speak(u);
  });
}

// One shared player so a second "Read aloud" (or a click elsewhere) stops
// whatever is currently talking instead of overlapping voices.
let ttsAudio: HTMLAudioElement | null = null;

function stopSpeaking() {
  if (typeof window !== "undefined" && window.speechSynthesis)
    window.speechSynthesis.cancel();
  if (ttsAudio) {
    ttsAudio.pause();
    if (ttsAudio.src.startsWith("blob:")) URL.revokeObjectURL(ttsAudio.src);
    ttsAudio = null;
  }
}

// Natural OpenAI voice via /api/tts, with the browser voice as a fallback.
// Returns once playback has started (or the fallback fires). Clicking again
// while the same text is playing toggles it off.
async function speak(text: string, onState?: (s: "loading" | "playing" | "idle") => void) {
  const clean = text.trim();
  if (!clean || typeof window === "undefined") return;

  // Toggle off if this exact clip is already playing.
  if (ttsAudio && ttsAudio.dataset.text === clean && !ttsAudio.paused) {
    stopSpeaking();
    onState?.("idle");
    return;
  }
  stopSpeaking();
  onState?.("loading");

  try {
    const res = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: clean,
        voice: window.localStorage.getItem(TTS_VOICE_KEY) || undefined,
      }),
    });
    if (!res.ok) throw new Error(`TTS ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.dataset.text = clean;
    ttsAudio = audio;
    audio.onended = () => {
      URL.revokeObjectURL(url);
      if (ttsAudio === audio) ttsAudio = null;
      onState?.("idle");
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      if (ttsAudio === audio) ttsAudio = null;
      onState?.("idle");
    };
    await audio.play();
    onState?.("playing");
  } catch {
    // Network/API trouble → still read it aloud with the built-in voice.
    // "idle" only once that voice is done, so the caller isn't told the reading
    // finished while the browser is still talking.
    await speakFallback(clean);
    onState?.("idle");
  }
}

// Like speak(), but resolves when the voice has finished talking (not merely
// started) — the voice conversation below needs to know when it's safe to
// listen again without hearing Eliora through the speakers.
function speakUntilDone(text: string): Promise<void> {
  return new Promise((resolve) => {
    if (!text.trim()) return resolve();
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(guard);
      resolve();
    };
    // Last-ditch guard: if playback never reports that it ended (a stalled
    // audio element, a browser with no voices), the conversation still moves on
    // instead of sitting on "speaking" forever.
    const guard = window.setTimeout(finish, speechBudgetMs(text) + 15_000);
    void speak(text, (state) => {
      if (state === "idle") finish();
    });
  });
}

// Markdown reads badly out loud — strip the syntax (and the emoji Eliora likes
// to sprinkle in) so the voice says the words and nothing else.
function plainSpeech(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " (code example on screen) ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/\*\*|__|~~|\*|_/g, "")
    .replace(/\|/g, " ")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, "")
    .replace(/\n+/g, ". ")
    .replace(/\.\s*\.+/g, ".")
    .replace(/[ \t]+/g, " ")
    .trim();
}

type VoicePhase = "listening" | "thinking" | "speaking";

// How long a pause has to last before we treat it as "your turn is over".
const VOICE_SILENCE_MS = 1300;

// Hands-free conversation: you talk, Eliora answers out loud, then she listens
// again. Recognition runs in the browser (audio never leaves the device — only
// the transcript is sent); the reply comes from the normal chat endpoint and is
// voiced by /api/tts, so it lands in the chat transcript underneath too.
function VoiceChat({
  onSend,
  onClose,
}: {
  onSend: (text: string) => Promise<string>;
  onClose: () => void;
}) {
  const [phase, setPhaseState] = useState<VoicePhase>("listening");
  const [heard, setHeard] = useState("");
  const [reply, setReply] = useState("");
  const [error, setError] = useState<string | null>(null);

  // The loop below lives entirely inside one effect, so phase/controls travel
  // through refs instead of state that would be stale in a callback.
  const phaseRef = useRef<VoicePhase>("listening");
  const sendRef = useRef(onSend);
  const skipRef = useRef<() => void>(() => {});
  const sendNowRef = useRef<() => void>(() => {});
  const cutSpeechRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    sendRef.current = onSend;
  });

  const setPhase = (p: VoicePhase) => {
    phaseRef.current = p;
    setPhaseState(p);
  };

  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    const SR = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!SR) {
      setError(
        "This browser can't listen yet. Chrome, Edge, or Safari support voice mode — or just type your message.",
      );
      return;
    }

    let closed = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let rec: any = null;
    let silence: number | undefined;
    let finalText = "";
    let heardText = "";

    const clearSilence = () => {
      if (silence) window.clearTimeout(silence);
      silence = undefined;
    };

    const stopListening = () => {
      clearSilence();
      if (!rec) return;
      const r = rec;
      rec = null;
      r.onresult = null;
      r.onend = null;
      r.onerror = null;
      try {
        r.stop();
      } catch {
        /* already stopped */
      }
    };

    const listen = () => {
      if (closed) return;
      stopListening();
      finalText = "";
      heardText = "";
      setHeard("");
      setReply("");
      setPhase("listening");
      const r = new SR();
      r.lang = "en-US";
      r.continuous = true;
      r.interimResults = true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      r.onresult = (e: any) => {
        let interim = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const res = e.results[i];
          if (res.isFinal) finalText += res[0].transcript + " ";
          else interim += res[0].transcript;
        }
        heardText = `${finalText} ${interim}`.replace(/\s+/g, " ").trim();
        setHeard(heardText);
        // Pause long enough and we take it as the end of your turn.
        clearSilence();
        silence = window.setTimeout(() => {
          if (heardText.trim()) void takeTurn(heardText.trim());
        }, VOICE_SILENCE_MS);
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      r.onerror = (e: any) => {
        if (e?.error === "not-allowed" || e?.error === "service-not-allowed") {
          setError(
            "Microphone access is blocked. Allow it in your browser (the 🔒 icon in the address bar), then open voice mode again.",
          );
          closed = true;
          stopListening();
        }
        // "no-speech" and "aborted" are normal — onend restarts us.
      };
      r.onend = () => {
        // Chrome cuts recognition off after a lull; restart so the
        // conversation stays hands-free.
        if (!closed && rec === r && phaseRef.current === "listening") {
          try {
            r.start();
          } catch {
            /* already restarting */
          }
        }
      };
      rec = r;
      try {
        r.start();
      } catch {
        /* already running */
      }
    };

    const takeTurn = async (said: string) => {
      stopListening();
      setHeard(said);
      setReply("");
      setPhase("thinking");
      let answer = "";
      try {
        answer = await sendRef.current(said);
      } catch {
        answer = "Sorry — I couldn't reach the server. Let's try that again.";
      }
      if (closed) return;
      setReply(answer);
      const spoken = plainSpeech(answer);
      if (spoken) {
        setPhase("speaking");
        // Racing against a resolver lets "Skip" (or hanging up) cut the voice
        // off without leaving this await hanging forever.
        const interrupted = new Promise<void>((res) => {
          cutSpeechRef.current = res;
        });
        await Promise.race([speakUntilDone(spoken), interrupted]);
        cutSpeechRef.current = null;
        stopSpeaking();
      }
      if (!closed) listen();
    };

    skipRef.current = () => {
      stopSpeaking();
      cutSpeechRef.current?.();
    };
    sendNowRef.current = () => {
      const said = heardText.trim();
      if (said) void takeTurn(said);
    };

    listen();
    return () => {
      closed = true;
      stopListening();
      stopSpeaking();
      cutSpeechRef.current?.();
    };
  }, []);

  const status = error
    ? "Voice mode needs a hand"
    : phase === "listening"
      ? "Listening…"
      : phase === "thinking"
        ? "Thinking…"
        : "Eliora is talking";

  return (
    <div style={styles.voiceOverlay}>
      <div style={styles.voiceCard}>
        <div style={styles.voiceHead}>
          <span style={styles.voiceTitle}>🎙️ Voice mode</span>
          <button
            style={styles.recCloseBtn}
            onClick={onClose}
            aria-label="Leave voice mode"
          >
            ✕
          </button>
        </div>

        <div
          className={`eliora-orb${error ? "" : ` ${phase}`}`}
          style={styles.voiceOrb}
          aria-hidden
        >
          🌱
        </div>

        <div style={styles.voiceStatus} aria-live="polite">
          {status}
        </div>

        {error ? (
          <p style={styles.voiceError}>{error}</p>
        ) : (
          <>
            <p style={styles.voiceHeard}>
              {heard ||
                (phase === "listening"
                  ? "Go ahead — say anything. Pause for a second when you're done and I'll answer."
                  : "…")}
            </p>
            {reply && <p style={styles.voiceReply}>{reply}</p>}
          </>
        )}

        <div style={styles.voiceControls}>
          {!error && phase === "listening" && heard.trim() && (
            <button style={styles.recSecondary} onClick={() => sendNowRef.current()}>
              ⏎ Send now
            </button>
          )}
          {!error && phase === "speaking" && (
            <button style={styles.recSecondary} onClick={() => skipRef.current()}>
              ⏭ Skip — my turn
            </button>
          )}
          <button style={styles.recPrimary} onClick={onClose}>
            ⏹ End voice chat
          </button>
        </div>

        {!error && (
          <p style={styles.voiceHint}>
            Everything you say lands in this chat, so you can scroll back and
            read it later.
          </p>
        )}
      </div>
    </div>
  );
}

// "Read aloud" control with live loading / playing state.
function SpeakButton({ text }: { text: string }) {
  const [state, setState] = useState<"loading" | "playing" | "idle">("idle");
  useEffect(() => () => stopSpeaking(), []);
  return (
    <button
      style={styles.speakBtn}
      onClick={() => void speak(text, setState)}
      aria-label={
        state === "playing" ? "Stop reading aloud" : "Read this message aloud"
      }
      aria-busy={state === "loading"}
    >
      {state === "loading"
        ? "⏳ Loading…"
        : state === "playing"
          ? "⏹ Stop"
          : "🔊 Read aloud"}
    </button>
  );
}

function AccessibilityPanel({
  value,
  onChange,
  onClose,
}: {
  value: A11y;
  onChange: (v: A11y) => void;
  onClose: () => void;
}) {
  const items: {
    key: Exclude<keyof A11y, "fontScale" | "theme">;
    label: string;
    desc: string;
  }[] = [
    {
      key: "dyslexic",
      label: "Dyslexia-friendly font",
      desc: "Easier-to-read letters with more spacing",
    },
    {
      key: "spacing",
      label: "Extra line spacing",
      desc: "More room between lines and words",
    },
    {
      key: "contrast",
      label: "High contrast",
      desc: "Stronger colors for low vision",
    },
    {
      key: "reduceMotion",
      label: "Reduce motion",
      desc: "Turn off animations",
    },
    {
      key: "readAloud",
      label: "Read answers aloud",
      desc: "Adds a 🔊 button to Eliora's messages",
    },
  ];
  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div style={styles.modalHead}>
          <h2 style={styles.modalTitle}>Accessibility</h2>
          <button style={styles.linkBtn} onClick={onClose}>
            Close
          </button>
        </div>
        <p style={styles.formIntro}>Adjust how Eliora looks and reads to you.</p>
        <div style={styles.fontRow}>
          <div>
            <div style={styles.toggleLabel}>Text size</div>
            <div style={styles.toggleDesc}>Make everything bigger or smaller</div>
          </div>
          <div style={styles.fontStepper}>
            <button
              style={styles.fontStepBtn}
              aria-label="Smaller text"
              disabled={value.fontScale <= FONT_STEPS[0]}
              onClick={() => {
                const i = FONT_STEPS.indexOf(value.fontScale);
                const cur = i === -1 ? 0 : i;
                onChange({
                  ...value,
                  fontScale: FONT_STEPS[Math.max(0, cur - 1)],
                });
              }}
            >
              −
            </button>
            <span style={styles.fontValue}>
              {Math.round(value.fontScale * 100)}%
            </span>
            <button
              style={styles.fontStepBtn}
              aria-label="Larger text"
              disabled={value.fontScale >= FONT_STEPS[FONT_STEPS.length - 1]}
              onClick={() => {
                const i = FONT_STEPS.indexOf(value.fontScale);
                const cur = i === -1 ? 0 : i;
                onChange({
                  ...value,
                  fontScale: FONT_STEPS[Math.min(FONT_STEPS.length - 1, cur + 1)],
                });
              }}
            >
              +
            </button>
          </div>
        </div>
        <div style={{ marginTop: 4, marginBottom: 4 }}>
          <div style={styles.toggleLabel}>Theme</div>
          <div style={styles.toggleDesc}>Pick a look</div>
          <div style={styles.themeGrid}>
            {THEMES.map((t) => (
              <button
                key={t.key}
                onClick={() => onChange({ ...value, theme: t.key })}
                aria-pressed={value.theme === t.key}
                style={{
                  ...styles.themeChip,
                  ...(value.theme === t.key ? styles.themeChipActive : {}),
                }}
              >
                <span style={{ fontSize: 18 }}>{t.emoji}</span>
                {t.label}
              </button>
            ))}
          </div>
        </div>
        {items.map((it) => (
          <button
            key={it.key}
            style={styles.toggleRow}
            onClick={() => onChange({ ...value, [it.key]: !value[it.key] })}
            aria-pressed={value[it.key]}
          >
            <span
              style={{
                ...styles.switch,
                background: value[it.key] ? "var(--accent)" : "var(--border)",
              }}
            >
              <span
                style={{
                  ...styles.knob,
                  transform: value[it.key] ? "translateX(20px)" : "translateX(0)",
                }}
              />
            </span>
            <span style={{ flex: 1, textAlign: "left" }}>
              <span style={styles.toggleLabel}>{it.label}</span>
              <span style={styles.toggleDesc}>{it.desc}</span>
            </span>
          </button>
        ))}
        {value.readAloud && <VoicePicker />}
        <ChangePasswordSection />
      </div>
    </div>
  );
}

// Picks the OpenAI voice used for "Read aloud" and previews it. Stored on its
// own in localStorage, so it survives without touching the A11y schema.
function VoicePicker() {
  const [voice, setVoice] = useState("nova");
  const [previewing, setPreviewing] = useState(false);
  useEffect(() => {
    setVoice(window.localStorage.getItem(TTS_VOICE_KEY) || "nova");
  }, []);
  function choose(id: string) {
    setVoice(id);
    window.localStorage.setItem(TTS_VOICE_KEY, id);
    setPreviewing(true);
    void speak(
      "Hi, I'm Eliora. This is how I'll sound when I read your answers aloud.",
      (s) => setPreviewing(s !== "idle"),
    );
  }
  return (
    <div style={{ marginTop: 8, marginBottom: 4 }}>
      <div style={styles.toggleLabel}>Voice</div>
      <div style={styles.toggleDesc}>
        {previewing ? "Playing a preview…" : "Tap a voice to hear it"}
      </div>
      <div style={styles.themeGrid}>
        {TTS_VOICES.map((v) => (
          <button
            key={v.id}
            onClick={() => choose(v.id)}
            aria-pressed={voice === v.id}
            style={{
              ...styles.themeChip,
              ...(voice === v.id ? styles.themeChipActive : {}),
            }}
          >
            🔊 {v.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// "Reset password" for signed-in users: verify the current password, set a new
// one (typed twice). Google-only accounts get a friendly explanation from the
// API instead, since they have no password in the local store.
function ChangePasswordSection() {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError("");
    setDone(false);
    if (!current || !next) {
      setError("Fill in your current and new password.");
      return;
    }
    if (next.length < 6) {
      setError("New password must be at least 6 characters.");
      return;
    }
    if (next !== confirm) {
      setError("New passwords don't match — please retype them.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(d.error || "Could not change your password.");
        return;
      }
      setDone(true);
      setCurrent("");
      setNext("");
      setConfirm("");
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: 12, borderTop: "1px solid var(--border)", paddingTop: 12 }}>
      <div style={styles.toggleLabel}>Account</div>
      {!open ? (
        <button style={styles.linkBtn} onClick={() => setOpen(true)}>
          🔑 Reset password
        </button>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
          <input
            style={styles.loginInput}
            type="password"
            placeholder="Current password"
            value={current}
            autoComplete="current-password"
            onChange={(e) => setCurrent(e.target.value)}
          />
          <input
            style={styles.loginInput}
            type="password"
            placeholder="New password (6+ characters)"
            value={next}
            autoComplete="new-password"
            onChange={(e) => setNext(e.target.value)}
          />
          <input
            style={styles.loginInput}
            type="password"
            placeholder="Confirm new password"
            value={confirm}
            autoComplete="new-password"
            onChange={(e) => setConfirm(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
          />
          {error && <p style={styles.loginError}>{error}</p>}
          {done && (
            <p style={{ color: "var(--accent)", margin: 0, fontSize: 14 }}>
              ✅ Password changed.
            </p>
          )}
          <button style={styles.loginSubmit} disabled={busy} onClick={submit}>
            {busy ? "…" : "Change password"}
          </button>
        </div>
      )}
    </div>
  );
}

// Render text with clickable links (e.g. fallback YouTube search links).
// Open a link robustly: a normal new tab in a real browser, but if that's
// blocked (e.g. an embedded webview/preview that disallows window.open),
// fall back to navigating in place so the link still works.
function openExternal(href: string) {
  return (e: React.MouseEvent) => {
    // Respect modifier-clicks (cmd/ctrl/middle) — let the browser handle those.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
    e.preventDefault();
    const w = window.open(href, "_blank", "noopener,noreferrer");
    if (!w) window.location.href = href;
  };
}

function renderContent(text: string, linkColor: string) {
  const linkStyle: React.CSSProperties = {
    color: linkColor,
    textDecoration: "underline",
    wordBreak: "break-all",
  };
  const link = (href: string, label: string, key: number) => (
    <a
      key={key}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={openExternal(href)}
      style={linkStyle}
    >
      {label}
    </a>
  );
  // Match Markdown links [label](url) OR bare http(s) URLs.
  const re = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s]+)/g;
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(<span key={key++}>{text.slice(last, m.index)}</span>);
    if (m[1]) {
      // Markdown link: label = m[1], url = m[2]
      nodes.push(link(m[2], m[1], key++));
    } else {
      // Bare URL — strip trailing punctuation so the href stays valid.
      let url = m[3];
      const trail = url.match(/[).,;:!?\]]+$/);
      let tail = "";
      if (trail) {
        tail = trail[0];
        url = url.slice(0, url.length - tail.length);
      }
      nodes.push(link(url, url, key++));
      if (tail) nodes.push(<span key={key++}>{tail}</span>);
    }
    last = re.lastIndex;
  }
  if (last < text.length) nodes.push(<span key={key++}>{text.slice(last)}</span>);
  return nodes;
}

// Inline formatting for one line: ==highlighted key ideas==, **bold**, plus
// links/URLs (via renderContent). The AI wraps its most important takeaways in
// == == so they show up as marker-pen highlights in the study notes.
function renderInline(text: string, linkColor: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  text.split(/(\*\*[^*]+\*\*|==[^=]+==)/g).forEach((part, i) => {
    if (!part) return;
    let m: RegExpMatchArray | null;
    if ((m = part.match(/^\*\*([^*]+)\*\*$/)))
      out.push(<strong key={`b${i}`}>{renderContent(m[1], linkColor)}</strong>);
    else if ((m = part.match(/^==([^=]+)==$/)))
      out.push(
        <mark key={`h${i}`} style={styles.mdMark}>
          {renderContent(m[1], linkColor)}
        </mark>,
      );
    else out.push(<span key={`s${i}`}>{renderContent(part, linkColor)}</span>);
  });
  return out;
}

// Lightweight markdown renderer for AI study notes: #/##/### headings, - / *
// bullets, 1. numbered items, **bold**, and links — kept plain and scannable.
// (The AI's notes use this structure; chat stays on the simpler renderContent.)
function renderMarkdown(text: string, linkColor: string): React.ReactNode {
  const blocks: React.ReactNode[] = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) {
      blocks.push(<div key={i} style={{ height: 6 }} />);
      return;
    }
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      const style = m[1].length <= 2 ? styles.mdH2 : styles.mdH3;
      blocks.push(
        <div key={i} style={style}>
          {renderInline(m[2], linkColor)}
        </div>,
      );
    } else if ((m = line.match(/^(\s*)[-*]\s+(.*)$/))) {
      const indent = Math.min(m[1].length, 6) * 4;
      blocks.push(
        <div key={i} style={{ ...styles.mdBullet, marginLeft: indent }}>
          <span style={styles.mdBulletMark}>•</span>
          <span>{renderInline(m[2], linkColor)}</span>
        </div>,
      );
    } else if ((m = line.match(/^(\s*)(\d+)\.\s+(.*)$/))) {
      const indent = Math.min(m[1].length, 6) * 4;
      blocks.push(
        <div key={i} style={{ ...styles.mdBullet, marginLeft: indent }}>
          <span style={styles.mdBulletMark}>{m[2]}.</span>
          <span>{renderInline(m[3], linkColor)}</span>
        </div>,
      );
    } else {
      blocks.push(
        <div key={i} style={styles.mdP}>
          {renderInline(line, linkColor)}
        </div>,
      );
    }
  });
  return <div>{blocks}</div>;
}

function VideoCards({ videos }: { videos: Video[] }) {
  return (
    <div style={styles.videoGrid}>
      {videos.map((v) => (
        <a
          key={v.videoId}
          href={v.url}
          target="_blank"
          rel="noopener noreferrer"
          style={styles.videoCard}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`}
            alt=""
            style={styles.videoThumb}
          />
          <div style={styles.videoMeta}>
            <span style={styles.videoTitle}>{v.title}</span>
            <span style={styles.videoChannel}>{v.channel}</span>
          </div>
        </a>
      ))}
    </div>
  );
}

// Short-form recommendations (TikTok / YouTube Shorts / Instagram Reels). Unlike
// VideoCards these carry no real clip — each opens a search on that platform.
function SocialCards({ socials }: { socials: SocialRec[] }) {
  return (
    <div style={styles.socialWrap}>
      {socials.map((s, i) => {
        const meta = SOCIAL_META[s.platform] ?? SOCIAL_META.youtube;
        return (
          <a
            key={`${s.platform}-${i}`}
            href={s.url}
            target="_blank"
            rel="noopener noreferrer"
            style={styles.socialCard}
          >
            <span style={{ ...styles.socialBadge, background: meta.color }}>
              {meta.emoji} {meta.label}
            </span>
            <span style={styles.socialTitle}>{s.title}</span>
            {s.note && <span style={styles.socialNote}>{s.note}</span>}
            <span style={styles.socialOpen}>Open on {meta.label} →</span>
          </a>
        );
      })}
    </div>
  );
}

// Shows a few ANONYMIZED examples of how OTHER students worked through a similar
// problem, so the learner can feed off the approach. Rendered from the chat
// stream's {type:"examples"} event (see the chat route's find_student_examples).
function ExampleCards({ examples }: { examples: StudentExample[] }) {
  return (
    <div style={styles.exampleWrap}>
      <div style={styles.exampleHeader}>
        🧑‍🤝‍🧑 How other students tackled this
      </div>
      {examples.map((ex, i) => (
        <div key={ex.id ?? i} style={styles.exampleCard}>
          <div style={styles.exampleTopRow}>
            <span style={styles.exampleBadge}>Another student</span>
            {ex.subject && (
              <span style={styles.exampleSubject}>{ex.subject}</span>
            )}
          </div>
          <span style={styles.exampleTopic}>{ex.topic}</span>
          <span style={styles.exampleProblem}>
            <strong>Got stuck on:</strong> {ex.problem}
          </span>
          <span style={styles.exampleApproach}>
            <strong>What helped:</strong> {ex.approach}
          </span>
        </div>
      ))}
    </div>
  );
}

// How demanding the teach-back should be, framed as an academic ladder from
// kindergarten (simplest — explain the gist to a 5-year-old) up to college
// (rigorous — precise terms, edge cases, probing follow-ups). Higher rungs
// expect more depth. Threaded into every teach-back entry point so the
// challenge Eliora sets matches the pick.
type TeachLevel =
  | "kindergarten"
  | "elementary"
  | "middle"
  | "high"
  | "college";

const TEACH_LEVELS: { id: TeachLevel; label: string; emoji: string; hint: string }[] = [
  { id: "kindergarten", label: "Kindergarten", emoji: "🧸", hint: "Explain the gist to a 5-year-old — plainest words, hints welcome" },
  { id: "elementary", label: "Elementary", emoji: "✏️", hint: "Basic idea and why it matters, simple language, small hints ok" },
  { id: "middle", label: "Middle", emoji: "🏫", hint: "Standard check — clear explanation covering the key angles" },
  { id: "high", label: "High", emoji: "🎓", hint: "Thorough and accurate — correct terms, one testing follow-up" },
  { id: "college", label: "College", emoji: "🏛️", hint: "Rigorous — mechanism, edge cases, probing follow-up questions" },
];

// The level-specific framing that goes inside the teach-back challenge: how
// demanding the ask is, how many angles to cover, and whether hints or grilling
// follow-ups are in play. Kept separate so the challenge spine stays shared.
function teachLevelFraming(level: TeachLevel): string {
  switch (level) {
    case "kindergarten":
      return (
        `Keep it as simple as possible — like I'm explaining it to a 5-year-old. ` +
        `Ask me for just the one main idea in the plainest words, with an ` +
        `everyday example or analogy. Be very forgiving; if I stall or go quiet, ` +
        `offer a gentle hint to nudge me along. `
      );
    case "elementary":
      return (
        `Keep it simple, the way I'd explain it to a younger kid. Ask me for the ` +
        `basic idea and why it matters in plain language, and point out one key ` +
        `angle to hit. If I get stuck, offer a small hint. `
      );
    case "high":
      return (
        `Hold me to a high-school standard. Ask me to explain it thoroughly and ` +
        `accurately, covering three key angles — including how the parts fit ` +
        `together and one real example — and expect correct terms. After I ` +
        `explain, ask one follow-up question to test my reasoning. `
      );
    case "college":
      return (
        `Hold me to a rigorous, college-level standard. Ask me to explain it ` +
        `precisely with the right terminology, covering the underlying mechanism, ` +
        `an edge case, and how it connects to a related idea. After I explain, ` +
        `grill me with one or two probing follow-up questions before giving ` +
        `feedback, and don't let vague or hand-wavy answers slide. `
      );
    default:
      return (
        `Ask me to explain it in my own words, and list two or three key angles ` +
        `I should be sure to cover. `
      );
  }
}

// A readable phrase for the level, for baking into prompts (e.g. "at a
// middle-school level"). Kept distinct from the short UI labels.
function teachLevelWord(level: TeachLevel): string {
  switch (level) {
    case "kindergarten":
      return "kindergarten";
    case "elementary":
      return "elementary-school";
    case "high":
      return "high-school";
    case "college":
      return "college";
    default:
      return "middle-school";
  }
}

// —— Teach a student —————————————————————————————————————————————————————
// The flip side of teach-back. Instead of explaining to Eliora-the-teacher, you
// teach a concept to Eliora role-playing a STUDENT who learns a certain way.
// The four learning styles (the VARK model) make the student get stuck — and
// light up — differently, so you have to shape your explanation to reach them.
// Teaching one idea four different ways is the deepest test of understanding.
type StudentStyle = "visual" | "auditory" | "reading" | "kinesthetic";

const STUDENT_STYLES: {
  id: StudentStyle;
  name: string;
  label: string;
  emoji: string;
  hint: string;
}[] = [
  { id: "visual", name: "Maya", label: "Visual", emoji: "👁️", hint: "Maya — learns from pictures, diagrams, and how things are laid out" },
  { id: "auditory", name: "Theo", label: "Auditory", emoji: "👂", hint: "Theo — learns by hearing it explained, talking it through, analogies & stories" },
  { id: "reading", name: "Riya", label: "Reading/Writing", emoji: "✍️", hint: "Riya — learns from written steps, definitions, and lists she can note down" },
  { id: "kinesthetic", name: "Kai", label: "Hands-on", emoji: "✋", hint: "Kai — learns by doing: real examples, worked problems, hands-on practice" },
];

function studentStyleInfo(style: StudentStyle) {
  return STUDENT_STYLES.find((s) => s.id === style) ?? STUDENT_STYLES[0];
}

// How the student Eliora plays behaves in character: what confuses them, the
// questions they ask, and what finally makes it click — all keyed to their
// learning style. This is the heart of the exercise: you only reach the student
// by teaching to the way they learn.
function studentStyleFraming(style: StudentStyle): string {
  switch (style) {
    case "visual":
      return (
        `You learn by SEEING. You think in pictures, diagrams, and where things ` +
        `sit relative to each other, and you get lost in long word-only ` +
        `explanations. Ask me to show you what it looks like — to sketch it, ` +
        `describe a diagram, use colors or arrows, or paint a mental picture. ` +
        `When I give you something you can picture, say it finally clicks; when ` +
        `I just pile on words, say your eyes glaze over and ask me to help you ` +
        `see it. `
      );
    case "auditory":
      return (
        `You learn by HEARING and TALKING it through. You want it said out loud ` +
        `in plain language, with analogies, stories, and a little back-and-forth ` +
        `— a silent diagram does nothing for you. Ask me to explain it aloud a ` +
        `different way, give you an analogy, or talk through the reasoning step ` +
        `by step, and repeat key bits back to check you heard right. When I use ` +
        `a good analogy or rhythm, say it clicks; when I just point at something ` +
        `visual, say you need to hear how it works. `
      );
    case "reading":
      return (
        `You learn from WORDS ON A PAGE. You want clear written steps, precise ` +
        `definitions, and lists you could copy into your notes — vague talk ` +
        `frustrates you. Ask me to lay it out as numbered steps, define the key ` +
        `terms, or give you the rule in one clean sentence. When I give you ` +
        `something structured you could write down, say it clicks; when I stay ` +
        `hand-wavy, say you can't take notes on that and ask me to spell it out. `
      );
    case "kinesthetic":
      return (
        `You learn by DOING. Abstract theory bores and loses you fast — you need ` +
        `a real example, a worked problem, or something hands-on you can try ` +
        `yourself. Ask me how you'd actually USE this, for a concrete real-life ` +
        `example, or to walk through a problem together. When I give you ` +
        `something to do or a real scenario, say it clicks; when I stay abstract, ` +
        `say you're not following and ask for a real example. `
      );
    default:
      return "";
  }
}

// The message that kicks off a "teach a student" role-play. Eliora plays a
// student with the given learning style at the given grade level; you're the
// teacher. It opens in character, reacts turn by turn to how well you adapt to
// the way it learns, and — once it clicks — steps out of character to coach you.
function teachStudentKickoff(
  topic: string,
  style: StudentStyle,
  level: TeachLevel = "middle",
): string {
  const s = studentStyleInfo(style);
  const t = topic.trim();
  const about = t ? `"${t}"` : "a topic I'll pick in a moment";
  const styleWord = s.label.toLowerCase();
  return (
    `Let's role-play so I can practice teaching — the best test of whether I ` +
    `really understand something is whether I can teach it to someone who ` +
    `learns differently than I do.\n\n` +
    `You are ${s.name}, a ${teachLevelWord(level)} student, and I'm your ` +
    `teacher. Today I'm going to teach you ${about}. Stay fully in character ` +
    `as ${s.name} the whole time.\n\n` +
    `${s.name}'s learning style: ${studentStyleFraming(style)}\n` +
    `Behave like a real ${teachLevelWord(level)} student: use vocabulary that ` +
    `fits your age, be curious but easily confused, and at some point reveal ` +
    `one small, believable misconception for me to catch and fix. Ask me short, ` +
    `in-character questions the way ${s.name} really would — don't explain the ` +
    `topic to me, and don't break character to give me hints.\n\n` +
    `Start now: in a sentence or two, as ${s.name}, tell me you're a bit lost ` +
    `on ${about} and ask me to teach you — hinting at how you learn best. Then ` +
    `let me teach, reacting honestly each turn: only say it truly clicks once ` +
    `I've explained it in a way that fits how you learn.\n\n` +
    `Once you genuinely get it, STOP the role-play and switch to being Eliora, ` +
    `my coach: tell me what I taught well, whether I adapted to how ${s.name} ` +
    `learns (a ${styleWord} learner) or missed it, and give me one concrete ` +
    `tip for teaching a ${styleWord} learner next time.`
  );
}

// Record yourself teaching a concept to camera (the Feynman technique works
// even better out loud). We capture video for the learner to watch back AND —
// where the browser supports speech recognition — transcribe what they say so
// their spoken explanation can be sent to Eliora for feedback. The video stays
// local to this modal (never uploaded); only the transcript is handed back.
function TeachBackRecorder({
  concept,
  onSubmit,
  onClose,
}: {
  concept: string;
  onSubmit: (transcript: string) => void;
  onClose: () => void;
}) {
  const liveRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recognitionRef = useRef<any>(null);
  // Committed (final) transcript, kept in a ref so recognition restarts don't
  // lose earlier speech. Interim words are appended on top for the live view.
  const finalRef = useRef("");
  const urlRef = useRef<string | null>(null);

  const [ready, setReady] = useState(false);
  const [phase, setPhase] = useState<"idle" | "recording" | "review">("idle");
  const [error, setError] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [transcript, setTranscript] = useState("");

  const speechSupported =
    typeof window !== "undefined" &&
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ("SpeechRecognition" in window || "webkitSpeechRecognition" in (window as any));

  // Whether this component is still mounted — lets an in-flight getUserMedia
  // bail out cleanly if the modal was closed before the camera came up.
  const mountedRef = useRef(true);

  // Ask the browser for the camera + mic. Called on open and again whenever the
  // learner hits "Try again" after granting access. Translates the browser's
  // error into a message that tells them exactly what to fix.
  const acquire = useCallback(async () => {
    setError(null);
    setReady(false);
    // Secure-context / unsupported-browser guard: getUserMedia only exists on
    // https:// or localhost. Without this we'd throw a cryptic "undefined".
    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices ||
      !navigator.mediaDevices.getUserMedia
    ) {
      setError(
        window.isSecureContext
          ? "This browser doesn't support camera recording. Try Chrome, Edge, or Safari."
          : "Your camera can only be used over a secure (https) connection. Open this page via https:// or localhost and try again.",
      );
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
      if (!mountedRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;
      setReady(true);
    } catch (e) {
      if (!mountedRef.current) return;
      const name = (e as DOMException)?.name;
      if (name === "NotAllowedError" || name === "SecurityError") {
        setError(
          "Camera and mic access was blocked. Click the camera icon in your browser's address bar, allow access, then hit Try again.",
        );
      } else if (name === "NotFoundError" || name === "OverconstrainedError") {
        setError(
          "No camera or microphone was found. Plug one in (or check it isn't disabled), then hit Try again.",
        );
      } else if (name === "NotReadableError") {
        setError(
          "Your camera is already in use by another app. Close it (Zoom, FaceTime, etc.), then hit Try again.",
        );
      } else {
        setError(
          "Couldn't reach your camera and microphone. Check your browser's permissions, then hit Try again.",
        );
      }
    }
  }, []);

  // Acquire the camera + mic on open; tear everything down on unmount.
  useEffect(() => {
    mountedRef.current = true;
    acquire();
    return () => {
      mountedRef.current = false;
      teardown();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Show the live camera feed whenever we're not reviewing a finished take.
  useEffect(() => {
    if (ready && phase !== "review" && liveRef.current && streamRef.current) {
      liveRef.current.srcObject = streamRef.current;
      liveRef.current.play().catch(() => {});
    }
  }, [ready, phase]);

  // Tick a duration counter while recording.
  useEffect(() => {
    if (phase !== "recording") return;
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [phase]);

  function teardown() {
    try {
      recognitionRef.current?.stop();
    } catch {
      /* ignore */
    }
    recognitionRef.current = null;
    try {
      if (recorderRef.current && recorderRef.current.state !== "inactive")
        recorderRef.current.stop();
    } catch {
      /* ignore */
    }
    recorderRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
  }

  // Live transcription that survives the API's silence timeout by restarting
  // itself for as long as we're still recording.
  function startTranscription() {
    if (!speechSupported) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    const SR = w.SpeechRecognition || w.webkitSpeechRecognition;
    const rec = new SR();
    rec.lang = "en-US";
    rec.interimResults = true;
    rec.continuous = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rec.onresult = (e: any) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalRef.current += r[0].transcript;
        else interim += r[0].transcript;
      }
      setTranscript((finalRef.current + interim).replace(/\s+/g, " ").trim());
    };
    rec.onend = () => {
      if (recorderRef.current && recorderRef.current.state === "recording") {
        try {
          rec.start();
        } catch {
          /* already restarting */
        }
      }
    };
    rec.onerror = () => {};
    recognitionRef.current = rec;
    try {
      rec.start();
    } catch {
      /* ignore */
    }
  }

  function startRecording() {
    const stream = streamRef.current;
    if (!stream) return;
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
    chunksRef.current = [];
    finalRef.current = "";
    setVideoUrl(null);
    setTranscript("");
    setSeconds(0);
    let mr: MediaRecorder;
    try {
      mr = new MediaRecorder(stream);
    } catch {
      setError("Video recording isn't supported in this browser.");
      return;
    }
    mr.ondataavailable = (e) => {
      if (e.data && e.data.size) chunksRef.current.push(e.data);
    };
    mr.onstop = () => {
      const blob = new Blob(chunksRef.current, {
        type: chunksRef.current[0]?.type || "video/webm",
      });
      const url = URL.createObjectURL(blob);
      urlRef.current = url;
      setVideoUrl(url);
      setPhase("review");
    };
    recorderRef.current = mr;
    mr.start();
    startTranscription();
    setPhase("recording");
  }

  function stopRecording() {
    try {
      recognitionRef.current?.stop();
    } catch {
      /* ignore */
    }
    recognitionRef.current = null;
    if (recorderRef.current && recorderRef.current.state !== "inactive")
      recorderRef.current.stop();
  }

  function done(text: string) {
    teardown();
    onSubmit(text);
  }

  const mmss = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div style={styles.modalHead}>
          <h2 style={styles.modalTitle}>🎥 Teach it back on camera</h2>
          <button
            style={styles.recCloseBtn}
            onClick={onClose}
            aria-label="Close recorder"
          >
            ✕
          </button>
        </div>

        <p style={styles.recSub}>
          {concept
            ? <>Explain <b>{concept}</b> out loud, as if teaching a friend.</>
            : "Explain the concept out loud, as if teaching a friend."}{" "}
          Watch it back to catch the spots where you hesitate — that&apos;s where
          the gaps are.
        </p>

        {error ? (
          <>
            <div style={styles.recError}>{error}</div>
            <div style={styles.recControls}>
              <button style={styles.recPrimary} onClick={acquire}>
                ↺ Try again
              </button>
            </div>
          </>
        ) : (
          <>
            <div style={styles.recStage}>
              {phase === "review" && videoUrl ? (
                <video
                  key={videoUrl}
                  src={videoUrl}
                  controls
                  playsInline
                  style={{ ...styles.recVideo, transform: "none" }}
                />
              ) : (
                <video
                  ref={liveRef}
                  muted
                  playsInline
                  autoPlay
                  style={styles.recVideo}
                />
              )}
              {phase === "recording" && (
                <div style={styles.recBadge}>● REC {mmss}</div>
              )}
            </div>

            {(phase === "recording" || (phase === "review" && transcript)) && (
              <textarea
                value={transcript}
                onChange={(e) => setTranscript(e.target.value)}
                readOnly={phase === "recording"}
                placeholder={
                  speechSupported
                    ? "Your words will appear here as you speak…"
                    : ""
                }
                rows={3}
                style={styles.recTranscript}
                aria-label="Transcript of your explanation"
              />
            )}

            {phase === "review" && !transcript && speechSupported && (
              <p style={styles.recHint}>
                We didn&apos;t catch any speech. Re-record, or type what you
                explained below.
              </p>
            )}
            {phase === "review" && !speechSupported && (
              <textarea
                value={transcript}
                onChange={(e) => setTranscript(e.target.value)}
                placeholder="Type a quick summary of what you explained so Eliora can give feedback…"
                rows={3}
                style={styles.recTranscript}
                aria-label="Summary of your explanation"
              />
            )}

            <div style={styles.recControls}>
              {phase === "idle" && (
                <button
                  style={styles.recPrimary}
                  disabled={!ready}
                  onClick={startRecording}
                >
                  {ready ? "● Start recording" : "Preparing camera…"}
                </button>
              )}
              {phase === "recording" && (
                <button style={styles.recStop} onClick={stopRecording}>
                  ⏹ Stop
                </button>
              )}
              {phase === "review" && (
                <>
                  <button style={styles.recSecondary} onClick={startRecording}>
                    ↺ Re-record
                  </button>
                  <button
                    style={styles.recPrimary}
                    disabled={!transcript.trim()}
                    onClick={() => done(transcript.trim())}
                    title={
                      transcript.trim()
                        ? "Send your explanation to Eliora"
                        : "Add what you explained first"
                    }
                  >
                    Send to Eliora →
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

type FeedVideo = Video & { topic: string };

// A browsable feed of real study videos for the learner's classes. Videos play
// inline (click a card → embedded player) so they can watch without leaving
// the app. A search box lets them pull up a feed for any topic.
function VideoFeed({ topics }: { topics: string[] }) {
  const [items, setItems] = useState<FeedVideo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [playing, setPlaying] = useState<string | null>(null);
  const [filter, setFilter] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // What the feed is currently built from: the learner's classes, or a search.
  const [searched, setSearched] = useState<string | null>(null);

  const topicsKey = topics.join("|");

  async function load(forTopics: string[]) {
    if (!forTopics.length) return;
    setLoading(true);
    setError(false);
    setPlaying(null);
    try {
      const res = await fetch("/api/videos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topics: forTopics }),
      });
      const data = (await res.json()) as { items?: FeedVideo[]; error?: string };
      if (data.items?.length) setItems(data.items);
      else {
        setItems([]);
        setError(true);
      }
    } catch {
      setItems([]);
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setSearched(null);
    setFilter(null);
    load(topics);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topicsKey]);

  function search() {
    const q = query.trim();
    if (!q || loading) return;
    setSearched(q);
    setFilter(null);
    load([q]);
  }

  const feedTopics = searched ? [searched] : topics;
  const shown = filter ? items.filter((v) => v.topic === filter) : items;

  return (
    <div style={styles.card}>
      <div style={styles.cardHead}>
        <span style={styles.cardClass}>🎬 Video feed</span>
        <button
          style={styles.feedRefresh}
          disabled={loading || !feedTopics.length}
          onClick={() => load(feedTopics)}
        >
          ↻ Refresh
        </button>
      </div>
      <div style={styles.feedSearchRow}>
        <input
          style={styles.feedSearchInput}
          placeholder="Search study videos on any topic…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") search();
          }}
        />
        <button style={styles.feedSearchBtn} disabled={loading} onClick={search}>
          Search
        </button>
        {searched && (
          <button
            style={styles.feedRefresh}
            disabled={loading}
            onClick={() => {
              setSearched(null);
              setQuery("");
              load(topics);
            }}
          >
            ← My classes
          </button>
        )}
      </div>
      {feedTopics.length > 1 && (
        <div style={styles.feedChips}>
          {[null, ...feedTopics].map((t) => (
            <button
              key={t ?? "__all"}
              style={{
                ...styles.feedChip,
                ...(filter === t ? styles.feedChipActive : {}),
              }}
              onClick={() => setFilter(t)}
            >
              {t ?? "All"}
            </button>
          ))}
        </div>
      )}

      {!feedTopics.length && (
        <p style={styles.feedEmpty}>
          Add a class in the Study tab (or search a topic above) and your
          video feed will fill up with study videos.
        </p>
      )}
      {loading && <p style={styles.feedEmpty}>Loading your feed…</p>}
      {!loading && error && feedTopics.length > 0 && (
        <p style={styles.feedEmpty}>
          Couldn&apos;t load videos right now. Try{" "}
          {feedTopics.map((t, i) => (
            <span key={t}>
              {i > 0 && ", "}
              <a
                href={`https://www.youtube.com/results?search_query=${encodeURIComponent(t)}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t} on YouTube
              </a>
            </span>
          ))}
          .
        </p>
      )}

      {!loading && shown.length > 0 && (
        <div style={styles.feedGrid}>
          {shown.map((v) => (
            <div key={v.videoId} style={styles.feedCard}>
              {playing === v.videoId ? (
                <iframe
                  style={styles.feedPlayer}
                  src={`https://www.youtube.com/embed/${v.videoId}?autoplay=1`}
                  title={v.title}
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                />
              ) : (
                <button
                  style={styles.feedThumbBtn}
                  onClick={() => setPlaying(v.videoId)}
                  aria-label={`Play ${v.title}`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`}
                    alt=""
                    style={styles.videoThumb}
                  />
                  <span style={styles.feedPlayBadge}>▶</span>
                </button>
              )}
              <div style={styles.videoMeta}>
                <span style={styles.videoTitle}>{v.title}</span>
                <span style={styles.videoChannel}>{v.channel}</span>
                <span style={styles.feedCardFoot}>
                  <span style={styles.feedTopicTag}>{v.topic}</span>
                  <a
                    href={v.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={styles.feedYtLink}
                  >
                    YouTube ↗
                  </a>
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ProfileCard({
  profile,
  onEdit,
}: {
  profile: LearnerProfile;
  onEdit: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rows = (
    [
      ["Struggles with", profile.struggles],
      ["Likes to learn by", profile.learningStyle],
      ["Interests", profile.interests],
      ["What's worked", profile.pastSuccess],
    ] as const
  ).filter(([, v]) => v && v.trim());

  return (
    <div style={styles.card}>
      <div style={styles.cardHead}>
        <div>
          <span style={styles.cardClass}>{profile.klass}</span>
          {profile.name?.trim() && (
            <span style={styles.cardName}> · {profile.name.trim()}</span>
          )}
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          {rows.length > 0 && (
            <button style={styles.linkBtn} onClick={() => setOpen((o) => !o)}>
              {open ? "Hide" : "Details"}
            </button>
          )}
          <button style={styles.linkBtn} onClick={onEdit}>
            Edit
          </button>
        </div>
      </div>
      {open &&
        rows.map(([label, val]) => (
          <div key={label} style={styles.cardRow}>
            <span style={styles.cardLabel}>{label}: </span>
            {val}
          </div>
        ))}
    </div>
  );
}

// A per-assignment "what are you worried about?" note. Keeps its own draft state
// and commits on blur so we don't rewrite global state (and localStorage) on every
// keystroke. Eliora sees the concern in her context and coaches around it.
function ConcernField({
  value,
  onCommit,
}: {
  value?: string;
  onCommit: (concern: string) => void;
}) {
  const [draft, setDraft] = useState(value ?? "");
  const [editing, setEditing] = useState(false);
  // Keep the draft in sync if the underlying value changes while not editing.
  useEffect(() => {
    if (!editing) setDraft(value ?? "");
  }, [value, editing]);

  if (!editing && !value) {
    return (
      <button
        style={styles.concernAdd}
        onClick={() => setEditing(true)}
        aria-label="Add a concern"
      >
        💭 Add a concern
      </button>
    );
  }
  return (
    <div style={styles.concernRow}>
      <span style={styles.concernIcon} aria-hidden>
        💭
      </span>
      <input
        style={styles.concernInput}
        value={draft}
        autoFocus={editing && !value}
        placeholder="What's worrying you about this?"
        onChange={(e) => setDraft(e.target.value)}
        onFocus={() => setEditing(true)}
        onBlur={() => {
          setEditing(false);
          if ((draft.trim() || "") !== (value ?? "")) onCommit(draft);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
    </div>
  );
}

// The learner types in their day-to-day assignments / homework here.
function AssignmentsPanel({
  assignments,
  subjects,
  events,
  goals,
  profile,
  timeMgmt,
  onToggleTimeMgmt,
  onSetTime,
  onSetConcern,
  onAdd,
  onToggle,
  onRemove,
}: {
  assignments: Assignment[];
  subjects: string[];
  events?: StudyEvent[];
  goals?: SmartGoal[];
  profile?: LearnerProfile | null;
  timeMgmt: boolean;
  onToggleTimeMgmt: () => void;
  onSetTime: (id: string, f: { estMin?: number; planDate?: string }) => void;
  onSetConcern: (id: string, concern: string) => void;
  onAdd: (a: {
    title: string;
    subject?: string;
    due?: string;
    estMin?: number;
    planDate?: string;
  }) => void;
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [subject, setSubject] = useState("");
  const [due, setDue] = useState("");
  const [est, setEst] = useState("");
  const [planDate, setPlanDate] = useState("");
  const open = assignments.filter((a) => !a.done).length;
  const sorted = [...assignments].sort(
    (a, b) => Number(a.done) - Number(b.done),
  );
  // Time-management workload: minutes of open assignments due/planned this week.
  const todayISO = new Date().toISOString().slice(0, 10);
  const weekISO = new Date(Date.now() + 7 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const weekMin = assignments
    .filter((a) => !a.done && typeof a.estMin === "number")
    .filter((a) => {
      const d = a.planDate || a.due;
      return d ? d >= todayISO && d <= weekISO : true;
    })
    .reduce((n, a) => n + (a.estMin ?? 0), 0);
  const fmtMin = (m: number) =>
    m >= 60 ? `${Math.round((m / 60) * 10) / 10} hr` : `${m} min`;

  function add() {
    if (!title.trim()) return;
    const m = parseInt(est, 10);
    onAdd({
      title,
      subject: subject || undefined,
      due: due || undefined,
      estMin: Number.isFinite(m) && m > 0 ? m : undefined,
      planDate: planDate || undefined,
    });
    setTitle("");
    setDue("");
    setEst("");
    setPlanDate("");
  }

  return (
    <div style={styles.card}>
      <div style={styles.cardHead}>
        <span style={styles.cardClass}>📌 Today's assignments</span>
        <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button
            style={{
              ...styles.linkBtn,
              textDecoration: "none",
              color: timeMgmt ? "var(--accent)" : "var(--muted)",
              fontWeight: timeMgmt ? 700 : 400,
            }}
            onClick={onToggleTimeMgmt}
            title="Plan time for each assignment"
          >
            ⏳ Plan time {timeMgmt ? "on" : "off"}
          </button>
          <span style={styles.subjectsCount}>{open} to do</span>
        </span>
      </div>
      {timeMgmt && weekMin > 0 && (
        <div style={styles.timeWorkload}>
          ⏳ Planned this week: <b>{fmtMin(weekMin)}</b> of work
        </div>
      )}
      <div style={styles.assignAddRow}>
        <input
          style={styles.assignInput}
          value={title}
          placeholder="Add an assignment…"
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
        />
        <button style={styles.assignAddBtn} onClick={add}>
          Add
        </button>
      </div>
      <div style={styles.assignMetaRow}>
        <input
          style={styles.assignSelect}
          list="assign-subjects"
          value={subject}
          placeholder="Subject (optional)"
          onChange={(e) => setSubject(e.target.value)}
        />
        <datalist id="assign-subjects">
          {subjects.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
        <input
          type="date"
          style={styles.assignSelect}
          value={due}
          onChange={(e) => setDue(e.target.value)}
        />
      </div>
      {timeMgmt && (
        <div style={styles.assignMetaRow}>
          <input
            type="number"
            min={0}
            step={5}
            style={styles.assignSelect}
            value={est}
            placeholder="Est. minutes"
            onChange={(e) => setEst(e.target.value)}
          />
          <input
            type="date"
            style={styles.assignSelect}
            value={planDate}
            title="When you'll work on it"
            onChange={(e) => setPlanDate(e.target.value)}
          />
        </div>
      )}
      {sorted.length === 0 ? (
        <p style={styles.assignEmpty}>
          Nothing here yet. Add what's due and I'll help you knock it out.
        </p>
      ) : (
        sorted.map((a) => (
          <div key={a.id} style={styles.assignItem}>
            <button
              style={{
                ...styles.assignCheck,
                ...(a.done ? styles.assignCheckDone : {}),
              }}
              onClick={() => onToggle(a.id)}
              aria-label={a.done ? "Mark not done" : "Mark done"}
            >
              {a.done ? "✓" : ""}
            </button>
            <div style={{ flex: 1 }}>
              <div style={a.done ? styles.assignTitleDone : styles.assignTitle}>
                {a.title}
              </div>
              {a.subject && <div style={styles.assignMeta}>{a.subject}</div>}
              {(() => {
                const dl = formatDeadline(a.due, todayISO);
                if (!dl) return null;
                return (
                  <div
                    style={{
                      ...styles.assignDeadline,
                      ...(!a.done && dl.overdue
                        ? styles.assignDeadlineOverdue
                        : !a.done && dl.urgent
                          ? styles.assignDeadlineUrgent
                          : {}),
                    }}
                  >
                    {dl.label}
                  </div>
                );
              })()}
              {timeMgmt && (
                <div style={styles.timeRow}>
                  <input
                    type="number"
                    min={0}
                    step={5}
                    style={styles.timeInput}
                    value={a.estMin ?? ""}
                    placeholder="min"
                    onChange={(e) =>
                      onSetTime(a.id, {
                        estMin: parseInt(e.target.value, 10) || 0,
                      })
                    }
                  />
                  <span style={styles.timeLabel}>min</span>
                  <span style={styles.timeLabel}>· work on</span>
                  <input
                    type="date"
                    style={styles.timeDate}
                    value={a.planDate ?? ""}
                    onChange={(e) =>
                      onSetTime(a.id, { planDate: e.target.value })
                    }
                  />
                </div>
              )}
              {!a.done && (
                <ConcernField
                  value={a.concern}
                  onCommit={(c) => onSetConcern(a.id, c)}
                />
              )}
            </div>
            <button
              style={styles.assignRemove}
              onClick={() => onRemove(a.id)}
              aria-label="Remove"
            >
              ×
            </button>
          </div>
        ))
      )}
      <div style={{ marginTop: 10 }}>
        <Suggestions
          kind="todos"
          label="💡 Suggest to-dos"
          body={{
            events: events?.length ? events : undefined,
            goals: goals?.length ? goals : undefined,
            profile: profile ?? undefined,
            existing: assignments.map((a) => a.title),
          }}
          renderItem={(s, i, drop) => (
            <div key={i} style={styles.sugItem}>
              <div style={{ flex: 1 }}>
                <div style={styles.sugText}>{s.title}</div>
                {(s.subject || s.due) && (
                  <div style={styles.sugMeta}>
                    {s.subject}
                    {s.subject && s.due ? " · " : ""}
                    {s.due ? `due ${s.due}` : ""}
                  </div>
                )}
              </div>
              <button
                style={styles.fypAddPlan}
                onClick={() => {
                  if (s.title) {
                    onAdd({ title: s.title, subject: s.subject, due: s.due });
                    drop();
                  }
                }}
              >
                ＋ Add
              </button>
            </div>
          )}
        />
      </div>
    </div>
  );
}

// A guided SMART-goal builder (Specific, Measurable, Achievable, Relevant,
// Time-bound). Only the goal itself is required; the rest gently prompt the
// learner through the framework. Returns the new goal to the parent on save.
function GoalBuilder({
  subjects,
  profile,
  initial,
  onSave,
  onCancel,
}: {
  subjects: string[];
  profile: LearnerProfile | null;
  initial?: Partial<Omit<SmartGoal, "id" | "done">>;
  onSave: (g: Omit<SmartGoal, "id" | "done">) => void;
  onCancel: () => void;
}) {
  const [specific, setSpecific] = useState(initial?.specific ?? "");
  const [measurable, setMeasurable] = useState(initial?.measurable ?? "");
  const [achievable, setAchievable] = useState(initial?.achievable ?? "");
  const [relevant, setRelevant] = useState(initial?.relevant ?? "");
  const [timeBound, setTimeBound] = useState(initial?.timeBound ?? "");
  const [subject, setSubject] = useState(initial?.subject ?? "");
  const [target, setTarget] = useState(
    initial?.target ? String(initial.target) : "",
  );
  const [horizon, setHorizon] = useState<GoalHorizon>(
    initial?.horizon ?? "short",
  );
  const [saving, setSaving] = useState(false);
  const canSave = specific.trim().length > 0 && !saving;
  async function save() {
    if (!canSave) return;
    const t = parseInt(target, 10);
    const goal = {
      specific: specific.trim(),
      measurable: measurable || undefined,
      achievable: achievable || undefined,
      relevant: relevant || undefined,
      timeBound: timeBound || undefined,
      subject: subject || undefined,
      horizon,
      target: Number.isFinite(t) && t > 0 ? t : undefined,
    };
    // Ask the AI to turn the survey answers into one polished goal sentence.
    setSaving(true);
    let statement: string | undefined;
    try {
      const res = await fetch("/api/goal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal, profile: profile ?? undefined }),
      });
      if (res.ok) {
        const data = (await res.json()) as { statement?: string };
        statement = data.statement?.trim() || undefined;
      }
    } catch {
      /* keep statement undefined — fall back to the raw goal */
    }
    setSaving(false);
    onSave({ ...goal, statement });
  }
  const field = (
    letter: string,
    label: string,
    node: ReactNode,
    hint?: string,
  ) => (
    <label style={styles.goalField}>
      <span style={styles.goalFieldLabel}>
        <span style={styles.goalLetter}>{letter}</span>
        {label}
      </span>
      {node}
      {hint && <span style={styles.goalHint}>{hint}</span>}
    </label>
  );
  return (
    <div style={styles.card}>
      <div style={styles.cardHead}>
        <span style={styles.cardClass}>🌟 New SMART goal</span>
      </div>
      {field(
        "S",
        "Specific — what do you want to achieve? *",
        <input
          style={styles.assignInput}
          value={specific}
          placeholder="e.g. Get a B+ on the AP World Unit 4 test"
          onChange={(e) => setSpecific(e.target.value)}
          autoFocus
        />,
      )}
      {field(
        "M",
        "Measurable — how will you know?",
        <input
          style={styles.assignInput}
          value={measurable}
          placeholder="e.g. Score 85%+ on the practice test"
          onChange={(e) => setMeasurable(e.target.value)}
        />,
        "Optional: set a number below for a progress bar.",
      )}
      {field(
        "A",
        "Achievable — what's realistic / a first step?",
        <input
          style={styles.assignInput}
          value={achievable}
          placeholder="e.g. Study 25 min a day, start with Unit 4 notes"
          onChange={(e) => setAchievable(e.target.value)}
        />,
      )}
      {field(
        "R",
        "Relevant — why does it matter to you?",
        <input
          style={styles.assignInput}
          value={relevant}
          placeholder="e.g. I want college credit and to feel less stressed"
          onChange={(e) => setRelevant(e.target.value)}
        />,
      )}
      {field(
        "T",
        "Time-bound — by when?",
        <input
          type="date"
          style={styles.assignInput}
          value={timeBound}
          onChange={(e) => setTimeBound(e.target.value)}
        />,
      )}
      <div style={styles.goalField}>
        <span style={styles.goalFieldLabel}>How far out is this goal?</span>
        <div style={styles.horizonRow}>
          {GOAL_HORIZONS.map((h) => (
            <button
              key={h.key}
              type="button"
              onClick={() => setHorizon(h.key)}
              style={{
                ...styles.horizonBtn,
                ...(horizon === h.key ? styles.horizonBtnActive : {}),
              }}
            >
              {h.label}
              <span style={styles.horizonHint}>{h.hint}</span>
            </button>
          ))}
        </div>
        <span style={styles.horizonDesc}>
          {GOAL_HORIZONS.find((h) => h.key === horizon)?.desc}
        </span>
        <span style={styles.horizonExample}>
          {GOAL_HORIZONS.find((h) => h.key === horizon)?.example}
        </span>
      </div>
      <div style={styles.assignMetaRow}>
        <input
          style={styles.assignSelect}
          list="goal-subjects"
          value={subject}
          placeholder="Subject (optional)"
          onChange={(e) => setSubject(e.target.value)}
        />
        <datalist id="goal-subjects">
          {subjects.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
        <input
          type="number"
          min={0}
          style={styles.assignSelect}
          value={target}
          placeholder="Target # (optional)"
          onChange={(e) => setTarget(e.target.value)}
        />
      </div>
      <div style={styles.classSurveyActions}>
        <button style={styles.classSurveyCancel} onClick={onCancel}>
          Cancel
        </button>
        <button
          style={{
            ...styles.assignAddBtn,
            ...(canSave ? {} : { opacity: 0.5, cursor: "default" }),
          }}
          disabled={!canSave}
          onClick={save}
        >
          {saving ? "Polishing…" : "Save goal"}
        </button>
      </div>
    </div>
  );
}

// The learner's SMART goals — each with progress, deadline, and the SMART
// breakdown. New goals are added via the GoalBuilder.
function GoalsPanel({
  goals,
  subjects,
  profile,
  career,
  events,
  onAdd,
  onStep,
  onToggle,
  onRemove,
  onBreakDown,
  onToggleTask,
  onHelpTask,
  breakingGoalId,
  rewards,
  onLinkReward,
}: {
  goals: SmartGoal[];
  subjects: string[];
  profile: LearnerProfile | null;
  career?: string;
  events?: StudyEvent[];
  onAdd: (g: Omit<SmartGoal, "id" | "done">) => void;
  onStep: (id: string, delta: number) => void;
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
  onBreakDown: (g: SmartGoal) => void;
  onToggleTask: (goalId: string, index: number) => void;
  onHelpTask: (goal: SmartGoal, taskTitle: string) => void;
  breakingGoalId: string | null;
  rewards: CustomReward[];
  onLinkReward: (goalId: string, rewardId: string | undefined) => void;
}) {
  const [building, setBuilding] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [builderInitial, setBuilderInitial] = useState<
    Partial<Omit<SmartGoal, "id" | "done">> | undefined
  >(undefined);
  // AI goal suggestions the learner can add, change (edit), or regenerate.
  type Suggested = Partial<Omit<SmartGoal, "id" | "done">> & {
    specific: string;
    horizon?: GoalHorizon;
  };
  const [suggestions, setSuggestions] = useState<Suggested[] | null>(null);
  const [loadingSug, setLoadingSug] = useState(false);
  async function fetchSuggestions() {
    if (loadingSug) return;
    setLoadingSug(true);
    try {
      const res = await fetch("/api/goal-suggestions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          career,
          existing: goals.map((g) => g.statement?.trim() || g.specific),
          events: events?.length ? events : undefined,
          profile: profile ?? undefined,
        }),
      });
      const data = (await res.json()) as { suggestions?: Suggested[] };
      if (data.suggestions?.length) setSuggestions(data.suggestions);
    } catch {
      /* ignore — button can be tapped again */
    } finally {
      setLoadingSug(false);
    }
  }
  // Drop a suggestion once added/changed so the list reflects what's left.
  const dropSuggestion = (i: number) =>
    setSuggestions((prev) => (prev ? prev.filter((_, x) => x !== i) : prev));
  const activeGoals = goals.filter((g) => !g.done);
  const achieved = goals.filter((g) => g.done);
  // Goal achievements: the badges you unlock by achieving goals, shown right
  // here so progress toward them is visible where goals live. They only depend
  // on goal counts, so build a minimal stats object (XP fields unused here).
  const goalBadges = BADGE_DEFS.filter((b) => b.id.startsWith("goal-"));
  const goalStats: BadgeStats = {
    total: 0,
    activeDays: 0,
    streak: 0,
    goalsAchieved: achieved.length,
    goalHorizons: new Set(achieved.map((g) => g.horizon).filter(Boolean)).size,
  };
  const earnedGoalBadges = goalBadges.filter((b) => b.met(goalStats)).length;
  // Within a group, soonest deadline first (undated goals last).
  const byDeadline = (a: SmartGoal, b: SmartGoal) => {
    if (a.timeBound && b.timeBound) return a.timeBound.localeCompare(b.timeBound);
    if (a.timeBound) return -1;
    if (b.timeBound) return 1;
    return 0;
  };
  // Group ACTIVE goals by time horizon. Short-term comes FIRST and is
  // highlighted — those are the "do now" goals, so they stand out.
  const goalGroups: {
    title: string;
    horizon?: GoalHorizon;
    highlight?: boolean;
  }[] = [
    { title: "⚡ Short-term — focus now", horizon: "short", highlight: true },
    { title: "📆 Mid-term", horizon: "mid" },
    { title: "🎯 Long-term", horizon: "long" },
    { title: "Other goals", horizon: undefined },
  ];
  // One goal card — reused by the horizon groups and the "Achieved" section.
  const goalCard = (g: SmartGoal) => {
    const pct =
      typeof g.target === "number" && g.target > 0
        ? Math.round(((g.current ?? 0) / g.target) * 100)
        : null;
    const meta = [
      g.subject,
      g.measurable,
      g.relevant ? `Why: ${g.relevant}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    return (
      <div key={g.id} style={styles.goalItem}>
        <div style={styles.goalTop}>
          <button
            style={{
              ...styles.assignCheck,
              ...(g.done ? styles.assignCheckDone : {}),
            }}
            onClick={() => onToggle(g.id)}
            aria-label={g.done ? "Mark not achieved" : "Mark achieved"}
          >
            {g.done ? "✓" : ""}
          </button>
          <div style={{ flex: 1 }}>
            <div style={g.done ? styles.assignTitleDone : styles.goalTitle}>
              {g.statement?.trim() || g.specific}
            </div>
            {!g.statement?.trim() && meta && (
              <div style={styles.assignMeta}>{meta}</div>
            )}
            {!g.statement?.trim() && g.achievable && (
              <div style={styles.assignMeta}>Step: {g.achievable}</div>
            )}
            {g.statement?.trim() && g.subject && (
              <div style={styles.assignMeta}>{g.subject}</div>
            )}
          </div>
          {g.timeBound && (
            <span
              style={{
                ...styles.goalDue,
                ...(daysUntil(g.timeBound) < 0 && !g.done
                  ? styles.goalDueOver
                  : {}),
              }}
            >
              {countdown(g.timeBound)}
            </span>
          )}
          <button
            style={styles.assignRemove}
            onClick={() => onRemove(g.id)}
            aria-label="Remove goal"
          >
            ×
          </button>
        </div>
        {pct != null && (
          <div style={styles.goalProgressRow}>
            <button
              style={styles.goalStep}
              onClick={() => onStep(g.id, -1)}
              aria-label="Decrease progress"
            >
              −
            </button>
            <div style={styles.goalTrack}>
              <div style={{ ...styles.goalFill, width: `${pct}%` }} />
            </div>
            <button
              style={styles.goalStep}
              onClick={() => onStep(g.id, 1)}
              aria-label="Increase progress"
            >
              +
            </button>
            <span style={styles.goalCount}>
              {g.current ?? 0}/{g.target}
            </span>
          </div>
        )}
        {g.tasks && g.tasks.length > 0 && (
          <div style={styles.goalTasks}>
            <div style={styles.goalTasksHead}>
              Steps to get there ·{" "}
              {g.tasks.filter((t) => t.done).length}/{g.tasks.length}
            </div>
            {g.tasks.map((t, i) => (
              <div key={i} style={styles.goalTaskRow}>
                <button
                  style={{ ...styles.goalTaskToggle, flex: 1 }}
                  onClick={() => onToggleTask(g.id, i)}
                >
                  <span
                    style={{
                      ...styles.checkbox,
                      borderColor: "var(--accent)",
                      background: t.done ? "var(--accent)" : "transparent",
                      color: t.done ? "#fff" : "transparent",
                    }}
                  >
                    ✓
                  </span>
                  <span
                    style={{
                      textDecoration: t.done ? "line-through" : "none",
                      color: t.done ? "var(--muted)" : "var(--assistant-text)",
                    }}
                  >
                    {t.title}
                  </span>
                </button>
                {!t.done && (
                  <button
                    style={styles.goalTaskHelp}
                    onClick={() => onHelpTask(g, t.title)}
                    title="Get help with this step"
                  >
                    Help
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        {(() => {
          const prize = g.rewardId
            ? rewards.find((r) => r.id === g.rewardId)
            : undefined;
          // Achieved goals show the treat they won; active goals let you pick or
          // change the reward you're working toward.
          if (g.done) {
            return prize ? (
              <div style={styles.goalPrizeEarned}>
                🎁 Reward earned: {prize.emoji} {prize.title}
              </div>
            ) : null;
          }
          return (
            <div style={styles.goalPrizeRow}>
              <span style={styles.goalPrizeLabel}>🎁 Prize</span>
              {rewards.length === 0 ? (
                <span style={styles.goalPrizeHint}>
                  Add a reward in “My rewards” to work toward one
                </span>
              ) : (
                <select
                  style={styles.goalPrizeSelect}
                  value={g.rewardId ?? ""}
                  onChange={(e) =>
                    onLinkReward(g.id, e.target.value || undefined)
                  }
                  aria-label="Reward for achieving this goal"
                >
                  <option value="">No reward</option>
                  {rewards.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.emoji} {r.title}
                    </option>
                  ))}
                </select>
              )}
            </div>
          );
        })()}
        {!g.done && (
          <button
            style={styles.goalBreakBtn}
            onClick={() => onBreakDown(g)}
            disabled={breakingGoalId === g.id}
            title="Break this goal into a checklist of steps"
          >
            {breakingGoalId === g.id
              ? "Breaking into steps…"
              : g.tasks && g.tasks.length
                ? "↻ Redo steps"
                : "🪜 Break into steps"}
          </button>
        )}
      </div>
    );
  };
  return (
    <div style={styles.card}>
      <div style={styles.cardHead}>
        <span style={styles.cardClass}>🌟 Goals</span>
        {goals.length > 0 && (
          <span style={styles.subjectsCount}>
            {activeGoals.length} active
          </span>
        )}
      </div>
      {goals.length === 0 && !building && (
        <p style={styles.assignEmpty}>
          Set a goal to aim for — Eliora will tie your plan to it. Make it SMART:
          Specific, Measurable, Achievable, Relevant, Time-bound.
        </p>
      )}
      {goals.length > 0 && (
        <div style={styles.goalAchStrip}>
          <div style={styles.goalAchHead}>
            <span style={styles.goalAchTitle}>🏆 Achievements</span>
            <span style={styles.subjectsCount}>
              {earnedGoalBadges}/{goalBadges.length} unlocked
            </span>
          </div>
          <div style={styles.goalAchRow}>
            {goalBadges.map((bd) => {
              const earned = bd.met(goalStats);
              return (
                <div
                  key={bd.id}
                  style={styles.goalAchItem}
                  title={earned ? `${bd.label} — ${bd.blurb}` : `🔒 ${bd.hint}`}
                >
                  <span
                    style={{
                      ...styles.goalAchMedal,
                      background: bd.bg,
                      ...(earned ? {} : styles.badgeMedalLocked),
                    }}
                  >
                    {bd.emoji}
                  </span>
                  <span
                    style={{
                      ...styles.goalAchLabel,
                      ...(earned ? {} : { color: "var(--muted)" }),
                    }}
                  >
                    {bd.label}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {goalGroups.map((grp) => {
        const inGroup = activeGoals
          .filter((g) => (grp.horizon ? g.horizon === grp.horizon : !g.horizon))
          .sort(byDeadline);
        if (!inGroup.length) return null;
        return (
          <div
            key={grp.title}
            style={{
              ...styles.goalGroup,
              ...(grp.highlight ? styles.goalGroupHighlight : {}),
            }}
          >
            <div style={styles.goalGroupHeadRow}>
              <span
                style={
                  grp.highlight
                    ? styles.goalGroupHeadHighlight
                    : styles.goalGroupHead
                }
              >
                {grp.title}
              </span>
              <span
                style={{
                  ...styles.goalGroupCount,
                  ...(grp.highlight ? styles.goalGroupCountOn : {}),
                }}
              >
                {inGroup.length}
              </span>
            </div>
            {inGroup.map(goalCard)}
          </div>
        );
      })}
      {achieved.length > 0 && (
        <div style={styles.goalGroup}>
          <button
            style={styles.goalAchievedToggle}
            onClick={() => setShowDone((v) => !v)}
          >
            {showDone ? "▾" : "▸"} ✅ Achieved · {achieved.length}
          </button>
          {showDone && achieved.map(goalCard)}
        </div>
      )}
      {/* AI goal suggestions — add directly, change (edit), or regenerate. */}
      {suggestions && suggestions.length > 0 && !building && (
        <div style={styles.sugBox}>
          <div style={styles.sugHead}>
            <span style={styles.sugTitle}>💡 Suggested goals</span>
            <span>
              <button
                style={styles.linkBtn}
                disabled={loadingSug}
                onClick={fetchSuggestions}
              >
                {loadingSug ? "…" : "↻ Regenerate"}
              </button>
              <button
                style={{ ...styles.linkBtn, marginLeft: 12 }}
                onClick={() => setSuggestions(null)}
              >
                Hide
              </button>
            </span>
          </div>
          {suggestions.map((s, i) => (
            <div key={i} style={styles.sugItem}>
              <div style={{ flex: 1 }}>
                <div style={styles.sugText}>{s.specific}</div>
                <div style={styles.sugMeta}>
                  {goalHorizonLabelLocal(s.horizon)}
                  {s.measurable ? ` · ${s.measurable}` : ""}
                  {s.timeBound ? ` · by ${s.timeBound}` : ""}
                </div>
              </div>
              <button
                style={styles.sugChange}
                onClick={() => {
                  setBuilderInitial(s);
                  setBuilding(true);
                  dropSuggestion(i);
                }}
                title="Edit this before adding"
              >
                ✎ Change
              </button>
              <button
                style={styles.fypAddPlan}
                onClick={() => {
                  onAdd(s);
                  dropSuggestion(i);
                }}
              >
                ＋ Add
              </button>
            </div>
          ))}
        </div>
      )}
      {building ? (
        <GoalBuilder
          subjects={subjects}
          profile={profile}
          initial={builderInitial}
          onCancel={() => {
            setBuilding(false);
            setBuilderInitial(undefined);
          }}
          onSave={(g) => {
            onAdd(g);
            setBuilding(false);
            setBuilderInitial(undefined);
          }}
        />
      ) : (
        <div style={styles.goalBtnRow}>
          <button
            style={styles.goalNewBtn}
            onClick={() => {
              setBuilderInitial(undefined);
              setBuilding(true);
            }}
          >
            ＋ New goal
          </button>
          <button
            style={styles.goalSuggestBtn}
            disabled={loadingSug}
            onClick={fetchSuggestions}
          >
            {loadingSug ? "Thinking…" : "💡 Suggest goals"}
          </button>
        </div>
      )}
    </div>
  );
}

// Horizon label without importing the shared list (page has its own).
function goalHorizonLabelLocal(h?: GoalHorizon): string {
  return GOAL_HORIZONS.find((x) => x.key === h)?.label ?? "Goal";
}

// All suggestion items are plain string-field records (title/why/date/…).
type SugItem = Record<string, string | undefined>;

// A single auto-generated task for today, and the day's set (stamped with the
// date it was generated for so it regenerates when a new day begins).
// How important a task is. Drives ordering and how the day's time is split:
// higher-priority tasks are worked first and get a bigger slice of the budget.
type Priority = "high" | "med" | "low";
type DailyTask = {
  title: string;
  why?: string;
  subject?: string;
  priority?: Priority; // importance ranking (defaults to "med" when unset)
  estMin?: number; // estimated minutes — the time budget for this task
  done: boolean;
};
type DailyTasksState = { date: string; tasks: DailyTask[] };

// Weight each priority carries when splitting a fixed time block across tasks:
// a "high" task gets 3× the minutes of a "low" one.
const PRIORITY_WEIGHT: Record<Priority, number> = { high: 3, med: 2, low: 1 };
const PRIORITY_RANK: Record<Priority, number> = { high: 0, med: 1, low: 2 };
const PRIORITY_LABEL: Record<Priority, string> = {
  high: "High",
  med: "Med",
  low: "Low",
};
const PRIORITY_ORDER: Priority[] = ["high", "med", "low"];
const taskPriority = (t: DailyTask): Priority => t.priority ?? "med";

// Split a fixed block of minutes across tasks weighted by priority. Only unfinished
// tasks get time; each slice is rounded to 5 min (min 5), then rounding drift is
// absorbed by the highest-priority task so the slices sum back to the block.
function budgetByPriority(
  tasks: DailyTask[],
  blockMin: number,
): (number | undefined)[] {
  const idx = tasks
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => !t.done && t.title.trim());
  const out: (number | undefined)[] = tasks.map(() => undefined);
  if (!idx.length || blockMin < 5) return out;
  const totalWeight = idx.reduce(
    (n, { t }) => n + PRIORITY_WEIGHT[taskPriority(t)],
    0,
  );
  let assigned = 0;
  for (const { t, i } of idx) {
    const share = (blockMin * PRIORITY_WEIGHT[taskPriority(t)]) / totalWeight;
    const rounded = Math.max(5, Math.round(share / 5) * 5);
    out[i] = rounded;
    assigned += rounded;
  }
  // Absorb rounding drift on the highest-priority open task (never below 5 min).
  let drift = blockMin - assigned;
  if (drift !== 0) {
    const top = idx
      .slice()
      .sort(
        (a, b) =>
          PRIORITY_RANK[taskPriority(a.t)] - PRIORITY_RANK[taskPriority(b.t)],
      )[0];
    if (top) {
      const step = drift > 0 ? 5 : -5;
      while (drift !== 0 && (out[top.i] ?? 0) + step >= 5) {
        out[top.i] = (out[top.i] ?? 0) + step;
        drift -= step;
      }
    }
  }
  return out;
}
// Reusable AI-suggestions box: a button that fetches from /api/suggest, then a
// list with Regenerate/Hide. Each item is drawn by the caller's renderItem,
// which supplies the per-item action (Add / Make it / …) + can drop it.
function Suggestions({
  kind,
  label,
  body,
  resultKey = "suggestions",
  renderItem,
}: {
  kind: string;
  label: string;
  body: Record<string, unknown>;
  resultKey?: "items" | "suggestions";
  renderItem: (it: SugItem, i: number, drop: () => void) => ReactNode;
}) {
  const [items, setItems] = useState<SugItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  async function fetchIt() {
    if (loading) return;
    setLoading(true);
    try {
      const res = await fetch("/api/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, ...body }),
      });
      const data = (await res.json()) as Record<string, SugItem[] | undefined>;
      const arr = data[resultKey];
      if (Array.isArray(arr) && arr.length) setItems(arr);
    } catch {
      /* ignore — button can be tapped again */
    } finally {
      setLoading(false);
    }
  }
  const drop = (i: number) =>
    setItems((prev) => (prev ? prev.filter((_, x) => x !== i) : prev));
  if (!items) {
    return (
      <button style={styles.goalSuggestBtn} disabled={loading} onClick={fetchIt}>
        {loading ? "Thinking…" : label}
      </button>
    );
  }
  return (
    <div style={styles.sugBox}>
      <div style={styles.sugHead}>
        <span style={styles.sugTitle}>💡 Suggestions</span>
        <span>
          <button style={styles.linkBtn} disabled={loading} onClick={fetchIt}>
            {loading ? "…" : "↻ Regenerate"}
          </button>
          <button
            style={{ ...styles.linkBtn, marginLeft: 12 }}
            onClick={() => setItems(null)}
          >
            Hide
          </button>
        </span>
      </div>
      {items.map((it, i) => renderItem(it, i, () => drop(i)))}
    </div>
  );
}

// Tappable question starters shown during a lesson so a learner can ask about
// what they're studying without having to phrase it from scratch. A couple are
// tailored to the subject (math wants worked examples, history wants cause &
// effect, a language wants a sentence…); the rest are universal "dig deeper"
// moves. The subject is guessed from the lesson topic plus the learner's class
// and subject folders, so the prompts stay on-subject even when the topic is vague.
type LessonPrompt = { label: string; prompt: string };
type LessonSubjectKind =
  | "math"
  | "cs"
  | "history"
  | "science"
  | "language"
  | "english"
  | "generic";

function lessonSubjectKind(text: string): LessonSubjectKind {
  const t = text.toLowerCase();
  const has = (...ws: string[]) => ws.some((w) => t.includes(w));
  // Check computer science before plain "science" so "computer science" → cs.
  if (
    has("comput", "program", "coding", "python", "javascript", "java", "algorithm", "data structure", "software", "html", "css")
  )
    return "cs";
  if (
    has("math", "algebra", "geometry", "calculus", "trig", "fraction", "equation", "statistic", "arithmetic", "precalc", "derivative", "integral")
  )
    return "math";
  if (
    has("history", "civics", "government", "econom", "geography", "social studies", "revolution", "war", "wwi", "wwii", "empire", "politic", "ancient")
  )
    return "history";
  if (
    has("biology", "chemistry", "physics", "science", "anatomy", "ecolog", "photosynth", "atom", "cell", "molecul", "genetic", "planet", "energy", "reaction")
  )
    return "science";
  if (
    has("spanish", "french", "german", "latin", "mandarin", "chinese", "japanese", "italian", "vocab", "conjugat", "pronoun")
  )
    return "language";
  if (
    has("english", "essay", "writing", "grammar", "literature", "poem", "poetry", "novel", "reading", "shakespeare", "theme", "rhetoric", "author")
  )
    return "english";
  return "generic";
}

const LESSON_PROMPTS_BY_SUBJECT: Record<LessonSubjectKind, LessonPrompt[]> = {
  math: [
    { label: "Worked example", prompt: "Walk me through a worked example step by step." },
    { label: "Why it works", prompt: "Where does this come from — why does it work?" },
    { label: "When do I use it?", prompt: "What kinds of problems is this used to solve?" },
  ],
  science: [
    { label: "Real-world example", prompt: "Show me how this works in the real world." },
    { label: "Give an analogy", prompt: "Can you explain this with a simple analogy or picture?" },
    { label: "Cause & effect", prompt: "What's the cause and effect going on here?" },
  ],
  history: [
    { label: "Causes & effects", prompt: "What caused this and what were its effects?" },
    { label: "Why it matters", prompt: "Why does this matter, and how does it connect to today?" },
    { label: "Key people", prompt: "Who were the key people here and why did they matter?" },
  ],
  english: [
    { label: "Show an example", prompt: "Can you show me a short example passage?" },
    { label: "Key themes", prompt: "What are the key themes or techniques here?" },
    { label: "Help me write", prompt: "How would I write about this in an essay?" },
  ],
  cs: [
    { label: "Code example", prompt: "Can you show me a small code example?" },
    { label: "When do I use it?", prompt: "When would I actually use this in real code?" },
    { label: "Common bug", prompt: "What's a common bug or mistake with this?" },
  ],
  language: [
    { label: "Use in a sentence", prompt: "Can you show me this used in a sentence?" },
    { label: "How to say it", prompt: "How do I pronounce this correctly?" },
    { label: "Common mistakes", prompt: "What are common mistakes to avoid with this?" },
  ],
  generic: [
    { label: "Real example", prompt: "Give me a real-world example of this." },
    { label: "Why it matters", prompt: "Why does this matter and where would I use it?" },
    { label: "Break it down", prompt: "Can you break this down into simpler pieces?" },
  ],
};

// The tail is subject-agnostic — moves that help on any lesson.
const LESSON_PROMPTS_GENERIC: LessonPrompt[] = [
  { label: "Explain simpler", prompt: "Can you explain that more simply?" },
  { label: "Quiz me", prompt: "Quiz me on this to check what I understood." },
];

function lessonPromptsFor(
  topic: string,
  subjects: string[],
  klass?: string,
): LessonPrompt[] {
  const kind = lessonSubjectKind([topic, klass ?? "", ...subjects].join(" "));
  return [...LESSON_PROMPTS_BY_SUBJECT[kind], ...LESSON_PROMPTS_GENERIC];
}

// Prompted chat responses driven by the weak-topic algorithm: the `missed`
// tracker (topics the learner got wrong on quizzes/flashcards). We surface the
// MOST RECENTLY missed topics first (they're appended, so the tail is freshest)
// and turn each into a ready-to-send message, rotating the ask so the learner
// gets variety — re-teach one, get quizzed on the next, diagnose the gap on the
// third. Tapping a chip sends the prompt as if the learner typed it.
type WeakPrompt = { label: string; prompt: string };
const WEAK_PROMPT_TEMPLATES: ((t: string) => WeakPrompt)[] = [
  (t) => ({
    label: `Re-explain ${clipTopic(t)}`,
    prompt: `I keep getting "${t}" wrong. Re-teach it to me from scratch, simply and step by step, then check I've really got it.`,
  }),
  (t) => ({
    label: `Quiz me on ${clipTopic(t)}`,
    prompt: `Quiz me on "${t}" — it's a weak spot for me. Ask a few questions one at a time and tell me exactly where I'm going wrong.`,
  }),
  (t) => ({
    label: `Why I miss ${clipTopic(t)}`,
    prompt: `Help me figure out why I keep missing "${t}". Ask me a question or two to find the gap in my understanding, then fix it.`,
  }),
];
function clipTopic(t: string): string {
  const s = t.trim();
  return s.length > 22 ? `${s.slice(0, 21)}…` : s;
}
function weakTopicPrompts(missed: string[]): WeakPrompt[] {
  const topics = Array.from(new Set(missed.map((m) => m.trim()).filter(Boolean)))
    .reverse() // freshest misses first
    .slice(0, 3);
  return topics.map((t, i) => WEAK_PROMPT_TEMPLATES[i % WEAK_PROMPT_TEMPLATES.length](t));
}

// Home-dashboard card: one topic input with two ways to work it — "Learn"
// opens a lesson that flows into a teach-back on the same topic, and "Teach
// back" jumps straight to the Feynman exercise on what you already know. Tapping
// a suggestion chip fills the box so you can then pick which of the two to run.
// Suggestions lead with weak spots, then class + subject folders.
// The AI tutors shelf on the home screen. Each tutor is the same Eliora with a
// subject lens, a teaching style, and a matching read-aloud voice — picking one
// changes how every later chat explains things, so the choice sticks until it's
// changed. Tapping the selected tutor again opens a fresh session with them.
function TutorPicker({
  selected,
  busy,
  materials,
  materialBusy,
  materialError,
  onSelect,
  onStart,
  onAddMaterial,
  onRemoveMaterial,
}: {
  selected: string;
  busy: boolean;
  materials: StudyMaterial[];
  materialBusy: string | null; // name of the material currently being read
  materialError: string;
  onSelect: (id: string) => void;
  onStart: (tutor: ElioraTutor) => void;
  onAddMaterial: (source: { file?: File; text?: string }) => void;
  onRemoveMaterial: (id: string) => void;
}) {
  const active = tutorById(selected);
  const [previewing, setPreviewing] = useState(false);
  return (
    <div style={styles.card}>
      <div style={styles.cardHead}>
        <span style={styles.cardClass}>🧑‍🏫 AI tutors</span>
        <span style={{ color: "var(--muted)", fontSize: 13 }}>
          {active.emoji} {active.name}
        </span>
      </div>
      <p style={{ color: "var(--muted)", margin: "2px 0 12px", fontSize: 13 }}>
        Pick who teaches you. Each tutor explains their subject differently and
        has their own voice — everything else (your plan, goals, and tools)
        stays the same.
      </p>
      <div style={styles.tutorGrid}>
        {ELIORA_TUTORS.map((t) => {
          const isActive = t.id === active.id;
          return (
            <button
              key={t.id}
              className="eliora-action-card"
              style={{
                ...styles.tutorCard,
                ...(isActive ? styles.tutorCardActive : null),
              }}
              aria-pressed={isActive}
              onClick={() => onSelect(t.id)}
            >
              <span style={styles.tutorAvatar}>{t.emoji}</span>
              <span style={styles.tutorName}>{t.name}</span>
              <span style={styles.tutorSubject}>{t.subject}</span>
              <span style={styles.tutorTagline}>{t.tagline}</span>
            </button>
          );
        })}
      </div>
      <div style={styles.tutorActions}>
        <button
          style={styles.tutorStartBtn}
          disabled={busy}
          onClick={() => onStart(active)}
          title={`Start a new chat with ${active.name}`}
        >
          Start a session with {active.name} →
        </button>
        <button
          style={styles.tutorVoiceBtn}
          disabled={previewing}
          onClick={() =>
            void speak(
              `Hi, I'm ${active.name}. I help with ${active.subject.toLowerCase()}. ` +
                `Tell me what you're working on and we'll take it one step at a time.`,
              (s) => setPreviewing(s !== "idle"),
            )
          }
        >
          {previewing ? "🔊 Playing…" : "🔊 Hear their voice"}
        </button>
      </div>
      <TutorMaterial
        tutor={active}
        materials={materials}
        busyName={materialBusy}
        error={materialError}
        onAdd={onAddMaterial}
        onRemove={onRemoveMaterial}
      />
    </div>
  );
}

// "Teach from my textbook" — upload a chapter (PDF), photograph a page, or
// paste the text. The material is read once into a digest (sections + key
// terms) that then rides along in every chat, so the tutor teaches from the
// learner's actual book instead of general knowledge.
function TutorMaterial({
  tutor,
  materials,
  busyName,
  error,
  onAdd,
  onRemove,
}: {
  tutor: ElioraTutor;
  materials: StudyMaterial[];
  busyName: string | null;
  error: string;
  onAdd: (source: { file?: File; text?: string }) => void;
  onRemove: (id: string) => void;
}) {
  const [pasting, setPasting] = useState(false);
  const [text, setText] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const atCap = materials.length >= MATERIAL_MAX;
  return (
    <div style={styles.tutorMaterial}>
      <div style={styles.tutorMaterialHead}>
        <span style={styles.tutorMaterialTitle}>📚 Teach from my textbook</span>
        {materials.length > 0 && (
          <span style={{ color: "var(--muted)", fontSize: 12 }}>
            {materials.length}/{MATERIAL_MAX} added
          </span>
        )}
      </div>
      <p style={{ color: "var(--muted)", margin: "2px 0 10px", fontSize: 13 }}>
        Upload a chapter, snap a photo of a page, or paste the text.{" "}
        {tutor.name} will teach from it — your book&apos;s wording, your
        book&apos;s sections.
      </p>

      {materials.map((m) => (
        <div key={m.id} style={styles.materialRow}>
          <button
            className="eliora-row-btn"
            style={styles.materialRowMain}
            onClick={() => setOpenId(openId === m.id ? null : m.id)}
            title="What's in this material"
          >
            <span style={{ flexShrink: 0 }}>📕</span>
            <span style={{ flex: 1, textAlign: "left", minWidth: 0 }}>
              <span style={styles.materialTitle}>{m.title}</span>
              <span style={styles.materialMeta}>
                {m.topics.length} section{m.topics.length === 1 ? "" : "s"}
                {m.terms.length ? ` · ${m.terms.length} terms` : ""} · {m.source}
              </span>
            </span>
            <span style={{ color: "var(--muted)" }}>
              {openId === m.id ? "▾" : "›"}
            </span>
          </button>
          <button
            style={styles.materialRemove}
            onClick={() => onRemove(m.id)}
            aria-label={`Remove ${m.title}`}
            title="Remove this material"
          >
            ×
          </button>
          {openId === m.id && (
            <div style={styles.materialDetail}>
              {m.overview && (
                <p style={{ margin: "0 0 8px" }}>{m.overview}</p>
              )}
              <ol style={styles.materialTopicList}>
                {m.topics.map((t, i) => (
                  <li key={i}>{t.title}</li>
                ))}
              </ol>
            </div>
          )}
        </div>
      ))}

      {busyName && (
        <div style={styles.materialReading}>
          ⏳ Reading “{busyName}” — this takes a few seconds for a long chapter.
        </div>
      )}
      {error && <div style={styles.materialError}>{error}</div>}

      {pasting ? (
        <div style={{ marginTop: 8 }}>
          <textarea
            style={styles.materialTextarea}
            value={text}
            placeholder="Paste the chapter or your notes here…"
            onChange={(e) => setText(e.target.value)}
          />
          <div style={styles.tutorActions}>
            <button
              style={styles.tutorStartBtn}
              disabled={text.trim().length < 40 || !!busyName}
              onClick={() => {
                onAdd({ text: text.trim() });
                setText("");
                setPasting(false);
              }}
            >
              Add this material
            </button>
            <button
              style={styles.tutorVoiceBtn}
              onClick={() => {
                setPasting(false);
                setText("");
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div style={styles.tutorActions}>
          <input
            ref={fileRef}
            type="file"
            accept=".pdf,.txt,.md,.markdown,.csv,image/*,application/pdf"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onAdd({ file: f });
              e.target.value = ""; // let them re-pick the same file
            }}
          />
          <button
            style={styles.tutorVoiceBtn}
            disabled={!!busyName || atCap}
            onClick={() => fileRef.current?.click()}
            title={
              atCap
                ? `Remove one first — ${MATERIAL_MAX} materials is the limit`
                : "PDF, photo of a page, or a text file"
            }
          >
            📤 Upload a chapter
          </button>
          <button
            style={styles.tutorVoiceBtn}
            disabled={!!busyName || atCap}
            onClick={() => setPasting(true)}
          >
            📋 Paste text
          </button>
        </div>
      )}
    </div>
  );
}

function LearnStarter({
  profile,
  subjects,
  missed,
  busy,
  level,
  onLearn,
  onTeachBack,
}: {
  profile: LearnerProfile | null;
  subjects: string[];
  missed: string[];
  busy: boolean;
  level: TeachLevel;
  onLearn: (topic: string) => void;
  onTeachBack: (concept: string, level: TeachLevel) => void;
}) {
  const [topic, setTopic] = useState("");
  // Weak spots first — the topics you got wrong are where both a lesson and a
  // teach-back pay off most.
  const suggestions = Array.from(
    new Set(
      [...missed.slice(0, 3), ...(profile?.klass ? [profile.klass] : []), ...subjects]
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ).slice(0, 5);
  const run = (action: (t: string) => void, t: string) => {
    const v = t.trim();
    if (!v || busy) return;
    action(v);
    setTopic("");
  };
  return (
    <div style={styles.card}>
      <div style={styles.cardHead}>
        <span style={styles.cardClass}>💬 Learn a topic</span>
      </div>
      <p style={{ color: "var(--muted)", margin: "2px 0 10px", fontSize: 13 }}>
        Pick a topic. <b>Learn</b> walks you through it then has you teach it
        back to lock it in; <b>Teach back</b> jumps straight to explaining what
        you already know so I can find the holes.
      </p>
      <div style={styles.topicRow}>
        <input
          style={styles.topicInput}
          value={topic}
          placeholder="e.g. photosynthesis, the causes of WWI…"
          onChange={(e) => setTopic(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") run(onLearn, topic);
          }}
          disabled={busy}
        />
        <button
          style={styles.topicBtn}
          disabled={busy || !topic.trim()}
          onClick={() => run(onLearn, topic)}
          title="Open a lesson that flows into a teach-back"
        >
          Learn →
        </button>
        <button
          style={styles.topicBtn}
          disabled={busy || !topic.trim()}
          onClick={() => {
            const v = topic.trim();
            if (!v || busy) return;
            onTeachBack(v, level);
            setTopic("");
          }}
          title="Jump straight to teaching it back"
        >
          Teach back →
        </button>
      </div>
      {suggestions.length > 0 && (
        <div style={styles.topicChips}>
          {suggestions.map((s) => (
            <button
              key={s}
              style={styles.topicChip}
              disabled={busy}
              onClick={() => setTopic(s)}
              title={`Fill the box with ${s}`}
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Home-dashboard card: the flip side of teach-back. Pick a topic and a student
// who learns a certain way, and Eliora role-plays that student for you to teach.
// Teaching one idea to a visual, an auditory, a reading, and a hands-on learner
// is the deepest way to prove — and deepen — that you really understand it.
function TeachStudentStarter({
  subjects,
  missed,
  busy,
  style,
  onStyle,
  level,
  onLevel,
  onTeach,
}: {
  subjects: string[];
  missed: string[];
  busy: boolean;
  style: StudentStyle;
  onStyle: (s: StudentStyle) => void;
  level: TeachLevel;
  onLevel: (level: TeachLevel) => void;
  onTeach: (topic: string, style: StudentStyle, level: TeachLevel) => void;
}) {
  const [topic, setTopic] = useState("");
  const picked = studentStyleInfo(style);
  // Weak spots first — teaching a topic you got wrong is where explaining it to
  // a different kind of learner pays off most.
  const suggestions = Array.from(
    new Set(
      [...missed.slice(0, 3), ...subjects].map((s) => s.trim()).filter(Boolean),
    ),
  ).slice(0, 5);
  const run = () => {
    const v = topic.trim();
    if (!v || busy) return;
    onTeach(v, style, level);
    setTopic("");
  };
  return (
    <div style={styles.card}>
      <div style={styles.cardHead}>
        <span style={styles.cardClass}>🧑‍🏫 Teach a student</span>
      </div>
      <p style={{ color: "var(--muted)", margin: "2px 0 10px", fontSize: 13 }}>
        Pick a topic and a student. I&apos;ll play <b>{picked.name}</b>, who
        learns best the <b>{picked.label.toLowerCase()}</b> way — you teach me,
        and it only counts once it clicks for how I learn. Teaching every style
        is the real test of what you know.
      </p>
      <div style={styles.topicRow}>
        <input
          style={styles.topicInput}
          value={topic}
          placeholder="e.g. fractions, photosynthesis, supply & demand…"
          onChange={(e) => setTopic(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") run();
          }}
          disabled={busy}
        />
        <button
          style={styles.topicBtn}
          disabled={busy || !topic.trim()}
          onClick={run}
          title={`Teach ${picked.name} — a ${picked.label.toLowerCase()} learner`}
        >
          Teach {picked.name} →
        </button>
      </div>
      <div
        style={styles.teachLevelGroup}
        role="group"
        aria-label="Student learning style"
      >
        <span style={styles.teachLevelLabel}>Student</span>
        {STUDENT_STYLES.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => onStyle(s.id)}
            disabled={busy}
            title={s.hint}
            aria-pressed={style === s.id}
            style={{
              ...styles.teachLevelBtn,
              ...(style === s.id ? styles.teachLevelBtnActive : null),
            }}
          >
            {s.emoji} {s.label}
          </button>
        ))}
      </div>
      <div
        style={{ ...styles.teachLevelGroup, marginTop: 8 }}
        role="group"
        aria-label="Student grade level"
      >
        <span style={styles.teachLevelLabel}>Level</span>
        {TEACH_LEVELS.map((lvl) => (
          <button
            key={lvl.id}
            type="button"
            onClick={() => onLevel(lvl.id)}
            disabled={busy}
            title={lvl.hint}
            aria-pressed={level === lvl.id}
            style={{
              ...styles.teachLevelBtn,
              ...(level === lvl.id ? styles.teachLevelBtnActive : null),
            }}
          >
            {lvl.emoji} {lvl.label}
          </button>
        ))}
      </div>
      {suggestions.length > 0 && (
        <div style={styles.topicChips}>
          {suggestions.map((s) => (
            <button
              key={s}
              style={styles.topicChip}
              disabled={busy}
              onClick={() => setTopic(s)}
              title={`Fill the box with ${s}`}
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Home-dashboard card: "what to study next", ranked from the learner's weak
// areas (topics they've gotten wrong / low grades in `missed`). Each suggestion
// opens a lesson via the same startTopicChat path the LearnStarter's Learn button uses.
// Only shown once we actually know some weak areas, so it stays honest to its name.
function StudyNextCard({
  profile,
  missed,
  events,
  career,
  busy,
  onStart,
}: {
  profile: LearnerProfile | null;
  missed: string[];
  events: StudyEvent[];
  career?: string;
  busy: boolean;
  onStart: (topic: string) => void;
}) {
  if (!missed.length) return null;
  return (
    <div style={styles.card}>
      <div style={styles.cardHead}>
        <span style={styles.cardClass}>🎯 Study next</span>
      </div>
      <p style={{ color: "var(--muted)", margin: "2px 0 10px", fontSize: 13 }}>
        What to focus on, based on the topics you&apos;ve gotten wrong.
      </p>
      <Suggestions
        kind="focus"
        label="Suggest what to study next"
        resultKey="suggestions"
        body={{
          missed,
          events: events.length ? events : undefined,
          career,
          profile: profile ?? undefined,
        }}
        renderItem={(s, i, drop) => (
          <div key={i} style={styles.sugItem}>
            <div style={{ flex: 1 }}>
              <div style={styles.sugText}>
                {s.subject ? <b>{s.subject}: </b> : null}
                {s.topic}
              </div>
              {s.why && <div style={styles.sugMeta}>{s.why}</div>}
            </div>
            <button
              style={styles.topicBtn}
              disabled={busy || !s.topic}
              title={`Start a lesson on ${s.topic ?? "this topic"}`}
              onClick={() => {
                if (s.topic) {
                  onStart(s.topic);
                  drop();
                }
              }}
            >
              Start →
            </button>
          </div>
        )}
      />
    </div>
  );
}

// Urgency colour for a countdown: the fewer days left, the hotter it reads.
// Overdue and same-day items are red; a comfortable runway stays calm green.
function urgencyColor(days: number): string {
  if (days <= 1) return "#c0392b"; // today / tomorrow / overdue — act now
  if (days <= 3) return "#b8742a"; // this is close
  if (days <= 7) return "#2f6f8f"; // within the week
  return "#3f7d5a"; // plenty of runway
}
function countdownBig(days: number): string {
  if (days < 0) return `${-days}d overdue`;
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  return `${days} days`;
}

// Home-dashboard card: a single, prominent countdown to the learner's biggest
// upcoming deadlines. It pulls from every dated source the app already tracks —
// calendar events (exams/finals/projects), assignments with a due date, and
// SMART goals with a target date — merges them, sorts by soonest, and highlights
// the very next one with a big number. No new storage: it's a live view over
// existing state, so anything the learner adds elsewhere shows up here.
function DeadlineCountdownCard({
  events,
  assignments,
  goals,
  onOpen,
}: {
  events: StudyEvent[];
  assignments: Assignment[];
  goals: SmartGoal[];
  onOpen: () => void;
}) {
  const kindEmoji: Record<string, string> = {
    exam: "📝",
    final: "🎓",
    quiz: "❓",
    assignment: "📌",
    project: "📊",
    other: "📅",
  };
  const kindLabel: Record<string, string> = {
    exam: "Exam",
    final: "Final",
    quiz: "Quiz",
    assignment: "Assignment",
    project: "Project",
    other: "Event",
  };
  type Item = {
    id: string;
    title: string;
    date: string;
    days: number;
    emoji: string;
    tag: string;
  };
  const items: Item[] = [];
  for (const e of events)
    items.push({
      id: `e:${e.id}`,
      title: e.title,
      date: e.date,
      days: daysUntil(e.date),
      emoji: kindEmoji[e.kind ?? "other"] ?? "📅",
      tag: kindLabel[e.kind ?? "other"] ?? "Event",
    });
  for (const a of assignments)
    if (!a.done && a.due)
      items.push({
        id: `a:${a.id}`,
        title: a.title,
        date: a.due,
        days: daysUntil(a.due),
        emoji: "📌",
        tag: a.subject ? a.subject : "Assignment",
      });
  for (const g of goals)
    if (!g.done && g.timeBound)
      items.push({
        id: `g:${g.id}`,
        title: g.statement || g.specific,
        date: g.timeBound,
        days: daysUntil(g.timeBound),
        emoji: "🎯",
        tag: "Goal",
      });
  // Keep what's still ahead (or overdue but unfinished by no more than a week —
  // those are the ones still worth chasing), soonest first, and cap the list so
  // the card stays a glanceable summary rather than a full calendar.
  const upcoming = items
    .filter((it) => it.days >= -7)
    .sort((a, b) => a.days - b.days)
    .slice(0, 5);
  if (!upcoming.length) return null;
  const next = upcoming[0];
  const rest = upcoming.slice(1);

  return (
    <div style={styles.card}>
      <div style={styles.cardHead}>
        <span style={styles.cardClass}>⏳ Countdown</span>
        <button style={styles.linkBtn} onClick={onOpen}>
          Calendar →
        </button>
      </div>
      <button
        className="eliora-row-btn"
        onClick={onOpen}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          width: "100%",
          textAlign: "left",
          background: "var(--surface)",
          border: `1px solid ${urgencyColor(next.days)}`,
          borderLeft: `5px solid ${urgencyColor(next.days)}`,
          borderRadius: 12,
          padding: "12px 14px",
          cursor: "pointer",
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            minWidth: 76,
          }}
        >
          <span
            style={{
              fontSize: 26,
              fontWeight: 800,
              lineHeight: 1,
              color: urgencyColor(next.days),
            }}
          >
            {next.days > 1 ? next.days : next.emoji}
          </span>
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: urgencyColor(next.days),
              marginTop: 3,
            }}
          >
            {next.days > 1 ? "days left" : countdownBig(next.days)}
          </span>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 15,
              fontWeight: 700,
              color: "var(--text)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {next.emoji} {next.title}
          </div>
          <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>
            {next.tag} · {countdownBig(next.days)}
          </div>
        </div>
      </button>
      {rest.length > 0 && (
        <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
          {rest.map((it) => (
            <button
              key={it.id}
              className="eliora-row-btn"
              onClick={onOpen}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                width: "100%",
                textAlign: "left",
                background: "transparent",
                border: "none",
                padding: "6px 4px",
                cursor: "pointer",
              }}
            >
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  color: urgencyColor(it.days),
                  minWidth: 62,
                }}
              >
                {countdownBig(it.days)}
              </span>
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: 13,
                  color: "var(--text)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {it.emoji} {it.title}
              </span>
              <span style={{ fontSize: 11, color: "var(--muted)" }}>{it.tag}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// A progress-aware nudge for the day's task list. Picks an encouraging line from
// how far the learner has gotten so momentum itself becomes the reward: an empty
// list invites a first small win, a partial list names the streak, a full list
// celebrates. `seed` (the done count) rotates the copy so it doesn't feel canned.
function taskCheer(done: number, total: number, seed: number): string {
  const pick = (msgs: string[]) => msgs[seed % msgs.length];
  if (total === 0) return "";
  if (done === 0)
    return pick([
      "🚀 One small task to start — momentum beats motivation. Pick the top one.",
      "🌱 Every plan begins with a single check. You've got this.",
      "🎯 Just start with one. Future-you is already grateful.",
    ]);
  if (done === total)
    return pick([
      "🏆 Every task done — that's a full day earned. Proud of you.",
      "🎉 Clean sweep! You showed up and finished. Rest well.",
      "🌟 100% today. This is exactly how big goals get built.",
    ]);
  const left = total - done;
  if (done / total >= 0.5)
    return pick([
      `🔥 Over halfway — just ${left} to go. Don't stop now.`,
      `💪 ${done} down, ${left} left. You're closer than you think.`,
      `⚡ Momentum's on your side — ${left} more and it's a wrap.`,
    ]);
  return pick([
    `✅ ${done} done — that first win is the hardest. Keep rolling.`,
    `👏 On the board! ${left} left, one at a time.`,
    `📈 Progress logged. Small steps stack up fast.`,
  ]);
}

// Home-dashboard card: a fresh, tiny to-do list Eliora generates for TODAY from
// the learner's plan, goals, calendar, assignments, and weak spots. It refreshes
// on its own each new day; the learner can check tasks off or ask for a new set.
function DailyTasksCard({
  state,
  loading,
  budgetMin,
  onGenerate,
  onToggle,
  onSetMin,
  onSetPriority,
  onBudget,
}: {
  state: DailyTasksState | null;
  loading: boolean;
  budgetMin: number; // study minutes in today's schedule (0 = no schedule yet)
  onGenerate: () => void;
  onToggle: (i: number) => void;
  onSetMin: (i: number, min: number) => void;
  onSetPriority: (i: number, p: Priority) => void;
  onBudget: (blockMin: number) => void;
}) {
  const today = localISO();
  const fresh = state?.date === today;
  const tasks = fresh ? state!.tasks : [];
  const doneCount = tasks.filter((t) => t.done).length;
  // How many minutes to split across tasks by priority. Seeds from today's
  // scheduled study time; the learner can override it before splitting.
  const [blockMin, setBlockMin] = useState<number>(budgetMin || 60);
  useEffect(() => {
    if (budgetMin > 0) setBlockMin(budgetMin);
  }, [budgetMin]);
  // Show tasks highest-priority first (stable within a priority, so generation
  // order is preserved for ties). Keep each task's real index for the handlers.
  const ordered = tasks
    .map((t, i) => ({ t, i }))
    .sort((a, b) => PRIORITY_RANK[taskPriority(a.t)] - PRIORITY_RANK[taskPriority(b.t)]);
  const fmtMin = (m: number) =>
    m >= 60 ? `${Math.round((m / 60) * 10) / 10} hr` : `${m} min`;
  // Time budget: total estimated minutes and how much is still left to do.
  const totalMin = tasks.reduce((n, t) => n + (t.estMin ?? 0), 0);
  const leftMin = tasks
    .filter((t) => !t.done)
    .reduce((n, t) => n + (t.estMin ?? 0), 0);
  const allDone = tasks.length > 0 && doneCount === tasks.length;
  // A friendly "Mon, Jul 7" for the header.
  const prettyDate = new Date(`${today}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

  return (
    <div style={styles.card}>
      <div style={styles.cardHead}>
        <span style={styles.cardClass}>🌞 Today&apos;s tasks</span>
        <span style={styles.subjectsCount}>
          {tasks.length
            ? `${doneCount}/${tasks.length} done · ${prettyDate}`
            : prettyDate}
        </span>
      </div>

      {!tasks.length ? (
        loading ? (
          <p style={styles.assignEmpty}>Putting together today&apos;s tasks…</p>
        ) : (
          <>
            <p style={styles.assignEmpty}>
              A fresh set of small tasks for today, built from your plan and
              what&apos;s coming up.
            </p>
            <button
              style={styles.goalSuggestBtn}
              disabled={loading}
              onClick={onGenerate}
            >
              ✨ Generate today&apos;s tasks
            </button>
          </>
        )
      ) : (
        <>
          <div style={styles.taskCheer}>{taskCheer(doneCount, tasks.length, doneCount)}</div>
          {totalMin > 0 && (
            <div style={styles.taskBudget}>
              ⏳ Time budget: <b>{fmtMin(totalMin)}</b>
              {budgetMin > 0 ? (
                <>
                  {" "}
                  of <b>{fmtMin(budgetMin)}</b> scheduled study
                </>
              ) : (
                " of tasks today"
              )}
              {budgetMin > 0 && totalMin > budgetMin
                ? ` · ${fmtMin(totalMin - budgetMin)} over your schedule`
                : leftMin > 0 && leftMin !== totalMin
                  ? ` · ${fmtMin(leftMin)} left`
                  : ""}
              {leftMin === 0 ? " · all done 🎉" : ""}
            </div>
          )}

          {/* Split a fixed block of time across today's tasks by priority. */}
          <div style={styles.budgetSplit}>
            <span style={styles.budgetSplitLabel}>Split</span>
            <input
              type="number"
              min={5}
              step={5}
              style={styles.timeInput}
              value={blockMin || ""}
              aria-label="Minutes to split across tasks"
              onChange={(e) =>
                setBlockMin(Math.max(0, parseInt(e.target.value, 10) || 0))
              }
            />
            <span style={styles.budgetSplitLabel}>
              min by priority
              {budgetMin > 0 ? " (from your schedule)" : ""}
            </span>
            <button
              style={styles.budgetSplitBtn}
              disabled={blockMin < 5}
              onClick={() => onBudget(blockMin)}
              title="Give each task minutes based on its priority"
            >
              ⚖️ Budget it
            </button>
          </div>

          {ordered.map(({ t, i }) => {
            const p = taskPriority(t);
            const next =
              PRIORITY_ORDER[(PRIORITY_ORDER.indexOf(p) + 1) % 3];
            return (
              <div key={i} style={styles.assignItem}>
                <button
                  style={{
                    ...styles.assignCheck,
                    ...(t.done ? styles.assignCheckDone : {}),
                  }}
                  onClick={() => onToggle(i)}
                  aria-label={t.done ? "Mark not done" : "Mark done"}
                >
                  {t.done ? "✓" : ""}
                </button>
                <div style={{ flex: 1 }}>
                  <div style={styles.taskTitleRow}>
                    <button
                      style={{ ...styles.prioBadge, ...styles[`prio_${p}`] }}
                      onClick={() => onSetPriority(i, next)}
                      title={`Priority: ${PRIORITY_LABEL[p]} — tap to change`}
                      aria-label={`Priority ${PRIORITY_LABEL[p]}, tap to set ${PRIORITY_LABEL[next]}`}
                    >
                      {PRIORITY_LABEL[p]}
                    </button>
                    <span
                      style={t.done ? styles.assignTitleDone : styles.assignTitle}
                    >
                      {t.title}
                    </span>
                  </div>
                  {(t.subject || t.why) && (
                    <div style={styles.assignMeta}>
                      {t.subject}
                      {t.subject && t.why ? " · " : ""}
                      {t.why}
                    </div>
                  )}
                  <div style={styles.timeRow}>
                    <input
                      type="number"
                      min={0}
                      step={5}
                      style={styles.timeInput}
                      value={t.estMin ?? ""}
                      placeholder="min"
                      aria-label="Time budget in minutes"
                      onChange={(e) =>
                        onSetMin(i, parseInt(e.target.value, 10) || 0)
                      }
                    />
                    <span style={styles.timeLabel}>min to budget</span>
                  </div>
                </div>
              </div>
            );
          })}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              marginTop: 10,
            }}
          >
            <span style={{ fontSize: 13, color: "var(--muted)" }}>
              {allDone
                ? "🎉 All done for today — nice work!"
                : "New tasks arrive each day."}
            </span>
            <button style={styles.linkBtn} disabled={loading} onClick={onGenerate}>
              {loading ? "…" : "↻ New tasks"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// Compact 4-year-plan summary for the Home dashboard: the destination + how many
// courses are done, tappable to open the full roadmap.
// Local YYYY-MM-DD (not UTC) so streaks line up with the learner's own day.
function localISO(dt = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}
const DAILY_XP_GOAL = 100;
// Reward system: study-room backgrounds unlocked with total XP, then equipped.
type StudyRoom = { id: string; name: string; emoji: string; cost: number; bg: string };
const STUDY_ROOMS: StudyRoom[] = [
  { id: "meadow", name: "Meadow", emoji: "🌿", cost: 0, bg: "linear-gradient(135deg,#c6ecc8,#8fd0a5)" },
  { id: "library", name: "Cozy Library", emoji: "📚", cost: 50, bg: "linear-gradient(135deg,#ecd8b6,#c9a878)" },
  { id: "night", name: "Night Sky", emoji: "🌌", cost: 150, bg: "linear-gradient(135deg,#2b2f6b,#6a5aa0)" },
  { id: "cafe", name: "Café", emoji: "☕", cost: 300, bg: "linear-gradient(135deg,#dcb890,#a8794f)" },
  { id: "beach", name: "Beach", emoji: "🏖️", cost: 500, bg: "linear-gradient(135deg,#bfeaf3,#f5e6b8)" },
  { id: "forest", name: "Forest", emoji: "🌲", cost: 800, bg: "linear-gradient(135deg,#2f5e36,#5da152)" },
  { id: "space", name: "Space", emoji: "🚀", cost: 1200, bg: "linear-gradient(135deg,#0f1030,#3a2a6a)" },
  { id: "sakura", name: "Sakura", emoji: "🌸", cost: 1800, bg: "linear-gradient(135deg,#ffd6e8,#ff9dc4)" },
  { id: "rain", name: "Rainy Window", emoji: "🌧️", cost: 2500, bg: "linear-gradient(135deg,#6b7a8f,#aebccd)" },
  { id: "aurora", name: "Aurora", emoji: "🌠", cost: 3200, bg: "linear-gradient(135deg,#0b2a3a,#3ad6a0)" },
  { id: "autumn", name: "Autumn", emoji: "🍂", cost: 4000, bg: "linear-gradient(135deg,#e0a15a,#c25b2c)" },
  { id: "reef", name: "Coral Reef", emoji: "🐠", cost: 5000, bg: "linear-gradient(135deg,#1b6ca8,#3fc1c9)" },
  { id: "volcano", name: "Volcano", emoji: "🌋", cost: 6500, bg: "linear-gradient(135deg,#4a1717,#c0392b)" },
  { id: "candlelit", name: "Candlelit", emoji: "🕯️", cost: 8000, bg: "linear-gradient(135deg,#241c12,#a3701f)" },
  { id: "rainbow", name: "Rainbow", emoji: "🌈", cost: 10000, bg: "linear-gradient(135deg,#ff9a9e,#a18cd1)" },
];
const roomById = (id?: string) =>
  STUDY_ROOMS.find((r) => r.id === id) ?? STUDY_ROOMS[0];

// The rewards shop: unlock study rooms with total XP, equip your favorite.
function RewardsCard({
  totalXp,
  equipped,
  onEquip,
}: {
  totalXp: number;
  equipped: string;
  onEquip: (id: string) => void;
}) {
  const next = STUDY_ROOMS.find((r) => r.cost > totalXp);
  return (
    <div style={styles.card}>
      <div style={styles.cardHead}>
        <span style={styles.cardClass}>🎁 Study rooms</span>
        <span style={styles.subjectsCount}>⭐ {totalXp} XP</span>
      </div>
      <p style={{ color: "var(--muted)", margin: "2px 0 8px", fontSize: 13 }}>
        Unlock backgrounds with XP, then equip your favorite.
        {next ? ` Next: ${next.emoji} ${next.name} at ${next.cost} XP.` : ""}
      </p>
      <div style={styles.roomGrid}>
        {STUDY_ROOMS.map((r) => {
          const unlocked = totalXp >= r.cost;
          const isEq = equipped === r.id;
          return (
            <button
              key={r.id}
              disabled={!unlocked}
              onClick={() => unlocked && onEquip(r.id)}
              style={{
                ...styles.roomChip,
                background: r.bg,
                ...(isEq ? styles.roomChipEq : {}),
                ...(unlocked ? {} : { filter: "grayscale(0.7)", opacity: 0.55 }),
              }}
              title={
                unlocked
                  ? isEq
                    ? "Equipped"
                    : "Tap to equip"
                  : `Reach ${r.cost} XP to unlock`
              }
            >
              <span style={styles.roomEmoji}>{r.emoji}</span>
              <span style={styles.roomName}>{r.name}</span>
              <span style={styles.roomStatus}>
                {isEq
                  ? "✓ Equipped"
                  : unlocked
                    ? "Tap to equip"
                    : `🔒 ${r.cost} XP`}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Learner-created rewards: personal treats the student defines and "buys" with
// the XP they earn. Redeeming spends from an AVAILABLE balance (earned − spent)
// so cumulative XP for badges, streaks, and study rooms is never reduced.
type CustomReward = {
  id: string;
  emoji: string;
  title: string;
  cost: number;
  redeemed: number; // how many times it's been claimed
  log?: string[]; // what the student typed each time they redeemed ("their output")
};

const REWARD_EMOJIS = [
  "🎁", "🍦", "🎮", "📺", "🍕", "☕", "🛍️", "😴", "🎧", "🍫", "⚽", "🎬",
];

function MyRewardsCard({
  availableXp,
  rewards,
  goals,
  onAdd,
  onRedeem,
  onRemove,
}: {
  availableXp: number;
  rewards: CustomReward[];
  goals: SmartGoal[];
  onAdd: (emoji: string, title: string, cost: number) => void;
  onRedeem: (id: string, note?: string) => void;
  onRemove: (id: string) => void;
}) {
  const [emoji, setEmoji] = useState(REWARD_EMOJIS[0]);
  const [title, setTitle] = useState("");
  const [cost, setCost] = useState("");
  // Which reward is mid-redeem (its compose box is open) and what the student
  // is typing as "their output" — a note about what they did to earn it.
  const [redeemingId, setRedeemingId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const claim = (id: string) => {
    onRedeem(id, note.trim() || undefined);
    setRedeemingId(null);
    setNote("");
  };
  const costNum = parseInt(cost, 10);
  const canAdd = !!title.trim() && Number.isFinite(costNum) && costNum > 0;
  const add = () => {
    if (!canAdd) return;
    onAdd(emoji, title.trim(), costNum);
    setTitle("");
    setCost("");
    setEmoji(REWARD_EMOJIS[0]);
  };
  return (
    <div style={styles.card}>
      <div style={styles.cardHead}>
        <span style={styles.cardClass}>🎁 My rewards</span>
        <span style={styles.subjectsCount}>⭐ {availableXp} to spend</span>
      </div>
      <p style={{ color: "var(--muted)", margin: "2px 0 10px", fontSize: 13 }}>
        Set your own rewards and treat yourself with the XP you earn. Redeeming
        spends XP but keeps your badges, streak, and study rooms.
      </p>
      {rewards.length === 0 ? (
        <p style={styles.assignEmpty}>
          No rewards yet — add one below (e.g. &ldquo;30 min of gaming&rdquo; for
          100 XP).
        </p>
      ) : (
        rewards.map((r) => {
          const afford = availableXp >= r.cost;
          const pct = Math.min(
            100,
            Math.round((availableXp / Math.max(1, r.cost)) * 100),
          );
          // A reward can be the prize for an active goal — surface that tie so
          // the learner sees which goal unlocks this treat for free.
          const prizeGoal = goals.find((g) => g.rewardId === r.id && !g.done);
          const composing = redeemingId === r.id;
          const log = r.log ?? [];
          return (
            <div key={r.id} style={styles.rewardWrap}>
              <div style={styles.rewardItem}>
                <span style={styles.rewardEmoji}>{r.emoji}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={styles.rewardTitle}>
                    {r.title}
                    {r.redeemed > 0 && (
                      <span style={styles.rewardRedeemed}>
                        {" "}
                        · claimed ×{r.redeemed}
                      </span>
                    )}
                  </div>
                  {prizeGoal && (
                    <div style={styles.rewardGoalTag} title="Achieve this goal to unlock this reward free">
                      🎯 Prize for: {prizeGoal.statement?.trim() || prizeGoal.specific}
                    </div>
                  )}
                  <div style={styles.rewardTrack}>
                    <div style={{ ...styles.rewardFill, width: `${pct}%` }} />
                  </div>
                </div>
                <span style={styles.rewardCost}>{r.cost} XP</span>
                <button
                  style={{
                    ...styles.rewardRedeemBtn,
                    ...(afford ? {} : styles.rewardRedeemOff),
                  }}
                  disabled={!afford}
                  onClick={() =>
                    composing
                      ? setRedeemingId(null)
                      : (setRedeemingId(r.id), setNote(""))
                  }
                  title={
                    afford
                      ? "Redeem this reward"
                      : `Earn ${r.cost - availableXp} more XP`
                  }
                >
                  {afford ? (composing ? "Cancel" : "Redeem") : "🔒"}
                </button>
                <button
                  style={styles.assignRemove}
                  onClick={() => onRemove(r.id)}
                  aria-label="Remove reward"
                >
                  ×
                </button>
              </div>
              {composing && (
                <div style={styles.rewardComposeBox}>
                  <textarea
                    style={styles.rewardComposeInput}
                    value={note}
                    autoFocus
                    placeholder="Type what you did to earn this (optional) — e.g. finished 3 practice sets and hit my study streak…"
                    onChange={(e) => setNote(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) claim(r.id);
                    }}
                  />
                  <button style={styles.rewardClaimBtn} onClick={() => claim(r.id)}>
                    🎉 Claim · −{r.cost} XP
                  </button>
                </div>
              )}
              {log.length > 0 && (
                <div style={styles.rewardLog}>
                  {log
                    .slice()
                    .reverse()
                    .map((entry, i) => (
                      <div key={i} style={styles.rewardLogItem}>
                        <span style={styles.rewardLogDot}>·</span> {entry}
                      </div>
                    ))}
                </div>
              )}
            </div>
          );
        })
      )}
      <div style={styles.rewardAddBox}>
        <div style={styles.rewardEmojiRow}>
          {REWARD_EMOJIS.map((e) => (
            <button
              key={e}
              onClick={() => setEmoji(e)}
              style={{
                ...styles.rewardEmojiPick,
                ...(emoji === e ? styles.rewardEmojiPickOn : {}),
              }}
              aria-label={`Use ${e}`}
            >
              {e}
            </button>
          ))}
        </div>
        <div style={styles.rewardAddRow}>
          <input
            style={styles.assignInput}
            value={title}
            placeholder="Reward (e.g. 30 min of gaming)"
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
          />
          <input
            type="number"
            min={1}
            step={10}
            style={styles.rewardCostInput}
            value={cost}
            placeholder="XP"
            onChange={(e) => setCost(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
          />
          <button style={styles.rewardAddBtn} onClick={add} disabled={!canAdd}>
            ＋ Add
          </button>
        </div>
      </div>
    </div>
  );
}
// Profile badges. Each has its own designed medallion (a gradient + emoji), a
// bit of flavor text, and the criteria to earn it. `met` is checked against the
// learner's live stats so we can show earned ones in color and the rest dimmed.
type BadgeStats = {
  total: number;
  activeDays: number;
  streak: number;
  goalsAchieved: number; // how many goals the learner has marked achieved
  goalHorizons: number; // distinct horizons (short/mid/long) among achieved goals
};
type BadgeDef = {
  id: string;
  emoji: string;
  label: string;
  blurb: string; // what the badge celebrates
  hint: string; // how to earn it
  bg: string; // medallion gradient
  reward: number; // bonus XP granted the first time it's earned
  met: (s: BadgeStats) => boolean;
};

// Ordered easiest → hardest within each family (streak, active days, XP).
const BADGE_DEFS: BadgeDef[] = [
  {
    id: "on-a-roll",
    emoji: "🔥",
    label: "On a Roll",
    blurb: "You showed up three days running — momentum is building.",
    hint: "Study 3 days in a row.",
    bg: "linear-gradient(135deg,#ffb347,#ff7a3c)",
    reward: 25,
    met: (s) => s.streak >= 3,
  },
  {
    id: "week-warrior",
    emoji: "📅",
    label: "Week Warrior",
    blurb: "A full week without missing a day. That's a real habit forming.",
    hint: "Keep a 7-day streak.",
    bg: "linear-gradient(135deg,#ff8a5c,#ff5e62)",
    reward: 50,
    met: (s) => s.streak >= 7,
  },
  {
    id: "fortnight-focus",
    emoji: "🌟",
    label: "Fortnight Focus",
    blurb: "Two straight weeks of showing up. Your future self says thanks.",
    hint: "Keep a 14-day streak.",
    bg: "linear-gradient(135deg,#f7971e,#ffd200)",
    reward: 100,
    met: (s) => s.streak >= 14,
  },
  {
    id: "month-master",
    emoji: "💎",
    label: "Month Master",
    blurb: "Thirty days in a row — this is elite consistency.",
    hint: "Keep a 30-day streak.",
    bg: "linear-gradient(135deg,#43cea2,#185a9d)",
    reward: 200,
    met: (s) => s.streak >= 30,
  },
  {
    id: "focus-master",
    emoji: "🧠",
    label: "Focus Master",
    blurb: "Five days of real focus in the bank.",
    hint: "Study on 5 different days.",
    bg: "linear-gradient(135deg,#56ab2f,#a8e063)",
    reward: 30,
    met: (s) => s.activeDays >= 5,
  },
  {
    id: "study-habit",
    emoji: "📚",
    label: "Study Habit",
    blurb: "Fifteen active days — studying is becoming second nature.",
    hint: "Study on 15 different days.",
    bg: "linear-gradient(135deg,#11998e,#38ef7d)",
    reward: 75,
    met: (s) => s.activeDays >= 15,
  },
  {
    id: "dedicated-scholar",
    emoji: "🦉",
    label: "Dedicated Scholar",
    blurb: "Thirty days of effort. You've made learning part of who you are.",
    hint: "Study on 30 different days.",
    bg: "linear-gradient(135deg,#136a8a,#267871)",
    reward: 150,
    met: (s) => s.activeDays >= 30,
  },
  {
    id: "xp-500",
    emoji: "⭐",
    label: "500 XP Club",
    blurb: "Your first 500 XP — the effort is adding up.",
    hint: "Earn 500 total XP.",
    bg: "linear-gradient(135deg,#f6d365,#fda085)",
    reward: 40,
    met: (s) => s.total >= 500,
  },
  {
    id: "xp-1000",
    emoji: "🏆",
    label: "1000 XP Legend",
    blurb: "A thousand XP of hard work. Legendary.",
    hint: "Earn 1,000 total XP.",
    bg: "linear-gradient(135deg,#f7971e,#ffd200)",
    reward: 80,
    met: (s) => s.total >= 1000,
  },
  {
    id: "xp-2500",
    emoji: "🚀",
    label: "2500 XP Star",
    blurb: "2,500 XP and climbing — you're on a serious trajectory.",
    hint: "Earn 2,500 total XP.",
    bg: "linear-gradient(135deg,#8e2de2,#4a00e0)",
    reward: 160,
    met: (s) => s.total >= 2500,
  },
  {
    id: "xp-5000",
    emoji: "👑",
    label: "5000 XP Royalty",
    blurb: "Five thousand XP. You wear the crown.",
    hint: "Earn 5,000 total XP.",
    bg: "linear-gradient(135deg,#734b6d,#42275a)",
    reward: 300,
    met: (s) => s.total >= 5000,
  },
  // Goal achievements — earned by marking SMART goals as achieved.
  {
    id: "goal-getter",
    emoji: "🎯",
    label: "Goal Getter",
    blurb: "You set a goal and saw it through. That's how big things start.",
    hint: "Achieve your first goal.",
    bg: "linear-gradient(135deg,#f6d365,#f9a03f)",
    reward: 30,
    met: (s) => s.goalsAchieved >= 1,
  },
  {
    id: "goal-triple",
    emoji: "🥉",
    label: "Triple Threat",
    blurb: "Three goals achieved — you're building real momentum.",
    hint: "Achieve 3 goals.",
    bg: "linear-gradient(135deg,#f7971e,#ffd200)",
    reward: 60,
    met: (s) => s.goalsAchieved >= 3,
  },
  {
    id: "goal-crusher",
    emoji: "🏅",
    label: "Goal Crusher",
    blurb: "Five goals done. Following through is becoming your habit.",
    hint: "Achieve 5 goals.",
    bg: "linear-gradient(135deg,#43cea2,#185a9d)",
    reward: 90,
    met: (s) => s.goalsAchieved >= 5,
  },
  {
    id: "goal-champion",
    emoji: "🏆",
    label: "Goal Champion",
    blurb: "Ten goals achieved. You finish what you start — that's rare.",
    hint: "Achieve 10 goals.",
    bg: "linear-gradient(135deg,#8e2de2,#4a00e0)",
    reward: 180,
    met: (s) => s.goalsAchieved >= 10,
  },
  {
    id: "goal-horizons",
    emoji: "🧭",
    label: "Big-Picture Thinker",
    blurb: "A short, a mid, and a long-term goal — all achieved. Balance!",
    hint: "Achieve a short-, mid-, and long-term goal.",
    bg: "linear-gradient(135deg,#11998e,#38ef7d)",
    reward: 120,
    met: (s) => s.goalHorizons >= 3,
  },
];

function badgeStats(
  log: Record<string, number>,
  streak: number,
  goals: SmartGoal[] = [],
): BadgeStats {
  const achieved = goals.filter((g) => g.done);
  const horizons = new Set(achieved.map((g) => g.horizon).filter(Boolean));
  return {
    total: Object.values(log).reduce((a, b) => a + b, 0),
    activeDays: Object.values(log).filter((v) => v > 0).length,
    streak,
    goalsAchieved: achieved.length,
    goalHorizons: horizons.size,
  };
}

// Consecutive active days ending today (or yesterday if today's blank yet).
function computeStreak(log: Record<string, number>): number {
  let streak = 0;
  const d = new Date();
  if (!(log[localISO(d)] > 0)) d.setDate(d.getDate() - 1);
  while (log[localISO(d)] > 0) {
    streak++;
    d.setDate(d.getDate() - 1);
  }
  return streak;
}

// The set of badge ids currently earned for a given progress log.
function earnedBadgeIds(
  log: Record<string, number>,
  goals: SmartGoal[] = [],
): string[] {
  const s = badgeStats(log, computeStreak(log), goals);
  return BADGE_DEFS.filter((b) => b.met(s)).map((b) => b.id);
}
// A Duolingo-style progress card: daily streak 🔥, total XP ⭐, this week's
// activity, and a daily-goal ring. `log` maps YYYY-MM-DD → XP earned that day.
function ProgressCard({
  log,
  study = {},
  goals = [],
}: {
  log: Record<string, number>;
  study?: Record<string, number>; // minutes studied per YYYY-MM-DD
  goals?: SmartGoal[];
}) {
  // Which badge's detail card is open (null = closed).
  const [openBadge, setOpenBadge] = useState<BadgeDef | null>(null);
  const total = Object.values(log).reduce((a, b) => a + b, 0);
  const todayXp = log[localISO()] || 0;
  // Streak = consecutive active days ending today (or yesterday if today's blank).
  let streak = 0;
  const d = new Date();
  if (!(log[localISO(d)] > 0)) d.setDate(d.getDate() - 1);
  while (log[localISO(d)] > 0) {
    streak++;
    d.setDate(d.getDate() - 1);
  }
  const now = new Date();
  const sunday = new Date(now);
  sunday.setDate(now.getDate() - now.getDay());
  const todayISO = localISO(now);
  const week = Array.from({ length: 7 }, (_, i) => {
    const dt = new Date(sunday);
    dt.setDate(sunday.getDate() + i);
    const iso = localISO(dt);
    return {
      label: ["S", "M", "T", "W", "T", "F", "S"][i],
      active: (log[iso] || 0) > 0,
      isToday: iso === todayISO,
      future: iso > todayISO,
    };
  });
  const pct = Math.min(100, Math.round((todayXp / DAILY_XP_GOAL) * 100));
  const stats = badgeStats(log, streak, goals);
  const earnedCount = BADGE_DEFS.filter((b) => b.met(stats)).length;
  // Everyday progress: XP earned each of the last 14 days, as a bar chart.
  const days14 = Array.from({ length: 14 }, (_, i) => {
    const dt = new Date(now);
    dt.setDate(now.getDate() - (13 - i));
    const iso = localISO(dt);
    return { xp: log[iso] || 0, isToday: iso === todayISO };
  });
  const maxXp = Math.max(DAILY_XP_GOAL, ...days14.map((d) => d.xp));
  // Cumulative XP over the last 30 days → a growth graph.
  const N = 30;
  const startDt = new Date(now);
  startDt.setDate(now.getDate() - (N - 1));
  const startISO = localISO(startDt);
  let base = 0;
  for (const [d, v] of Object.entries(log)) if (d < startISO) base += v;
  let cum = base;
  const series: number[] = [];
  for (let i = 0; i < N; i++) {
    const dt = new Date(now);
    dt.setDate(now.getDate() - (N - 1 - i));
    cum += log[localISO(dt)] || 0;
    series.push(cum);
  }
  const GW = 300;
  const GH = 70;
  const lo = base;
  const hi = Math.max(cum, base + 1);
  const gpts = series.map(
    (v, i) =>
      [(i / (N - 1)) * GW, GH - ((v - lo) / (hi - lo)) * GH] as [number, number],
  );
  const gLine = gpts
    .map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(" ");
  const gArea = `M0,${GH} ${gpts
    .map(([x, y]) => `L${x.toFixed(1)},${y.toFixed(1)}`)
    .join(" ")} L${GW},${GH} Z`;
  const gained30 = cum - base;
  // Y-axis ticks (cumulative XP) + X-axis start label + today's point, for the
  // growth graph's axes, scale, and end-marker.
  const gTop = Math.round(hi);
  const gMid = Math.round((hi + lo) / 2);
  const gBot = Math.round(lo);
  const gStartLabel = startDt.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  const gLastYPct = (gpts[gpts.length - 1][1] / GH) * 100;
  const gEmpty = gained30 === 0;
  // Hours studied each week: the last 6 weeks (Sunday-started, to match the week
  // strip above). Each week sums that week's daily study minutes into hours.
  const WEEKS = 6;
  const thisSunday = new Date(now);
  thisSunday.setDate(now.getDate() - now.getDay());
  thisSunday.setHours(0, 0, 0, 0);
  const weeks = Array.from({ length: WEEKS }, (_, i) => {
    const wStart = new Date(thisSunday);
    wStart.setDate(thisSunday.getDate() - (WEEKS - 1 - i) * 7);
    let mins = 0;
    for (let d = 0; d < 7; d++) {
      const dt = new Date(wStart);
      dt.setDate(wStart.getDate() + d);
      mins += study[localISO(dt)] || 0;
    }
    return {
      hours: mins / 60,
      isThisWeek: i === WEEKS - 1,
      label: wStart.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      }),
    };
  });
  const maxWeekHours = Math.max(1, ...weeks.map((w) => w.hours));
  const thisWeekHours = weeks[WEEKS - 1].hours;
  const totalStudyMin = Object.values(study).reduce((a, b) => a + b, 0);
  // "3h 20m" / "45m" / "0m" — friendly hours+minutes from a minute count.
  const fmtDuration = (mins: number) => {
    const m = Math.round(mins);
    const h = Math.floor(m / 60);
    const r = m % 60;
    return h > 0 ? (r ? `${h}h ${r}m` : `${h}h`) : `${r}m`;
  };
  return (
    <div style={styles.progCard}>
      <div style={styles.progTop}>
        <div style={styles.progStat}>
          <span style={styles.progBig}>🔥 {streak}</span>
          <span style={styles.progLbl}>day streak</span>
        </div>
        <div style={styles.progStat}>
          <span style={styles.progBig}>⭐ {total}</span>
          <span style={styles.progLbl}>total XP</span>
        </div>
      </div>
      <div style={styles.badgeSection}>
        <div style={styles.badgeSectionHead}>
          <span style={styles.badgeSectionTitle}>🎖️ Badges</span>
          <span style={styles.badgeSectionCount}>
            {earnedCount}/{BADGE_DEFS.length} earned
          </span>
        </div>
        <div style={styles.badgeGrid}>
          {BADGE_DEFS.map((bd) => {
            const earned = bd.met(stats);
            return (
              <button
                key={bd.id}
                style={styles.badgeItem}
                onClick={() => setOpenBadge(bd)}
                title={earned ? bd.label : `Locked — ${bd.hint}`}
                aria-label={`${bd.label}${earned ? " (earned)" : " (locked)"}`}
              >
                <span
                  style={{
                    ...styles.badgeMedal,
                    background: bd.bg,
                    ...(earned ? {} : styles.badgeMedalLocked),
                  }}
                >
                  {bd.emoji}
                  {!earned && <span style={styles.badgeLockPip}>🔒</span>}
                </span>
                <span
                  style={{
                    ...styles.badgeItemLabel,
                    ...(earned ? {} : { color: "var(--muted)" }),
                  }}
                >
                  {bd.label}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {openBadge &&
        (() => {
          const earned = openBadge.met(stats);
          return (
            <div style={styles.overlay} onClick={() => setOpenBadge(null)}>
              <div
                style={styles.badgeModal}
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  style={styles.badgeModalClose}
                  onClick={() => setOpenBadge(null)}
                  aria-label="Close"
                >
                  ×
                </button>
                <div
                  style={{
                    ...styles.badgeModalMedal,
                    background: openBadge.bg,
                    ...(earned ? {} : styles.badgeMedalLocked),
                  }}
                >
                  {openBadge.emoji}
                </div>
                <div style={styles.badgeModalTitle}>{openBadge.label}</div>
                <div
                  style={{
                    ...styles.badgeModalStatus,
                    ...(earned
                      ? { background: "var(--accent-soft)", color: "var(--accent)" }
                      : { background: "var(--surface)", color: "var(--muted)" }),
                  }}
                >
                  {earned ? "✓ Earned" : "🔒 Locked"}
                </div>
                <p style={styles.badgeModalBlurb}>{openBadge.blurb}</p>
                <div style={styles.badgeModalHint}>
                  <span style={styles.badgeModalHintLabel}>How to earn it</span>
                  <span>{openBadge.hint}</span>
                </div>
                <div style={styles.badgeModalReward}>
                  🎁 {earned ? "Earned reward:" : "Reward:"} +{openBadge.reward} XP
                </div>
              </div>
            </div>
          );
        })()}
      <div style={styles.progWeek}>
        {week.map((w, i) => (
          <div key={i} style={styles.progDay}>
            <span style={styles.progDayLbl}>{w.label}</span>
            <span
              style={{
                ...styles.progDot,
                ...(w.active ? styles.progDotActive : {}),
                ...(w.isToday ? styles.progDotToday : {}),
                ...(w.future ? { opacity: 0.35 } : {}),
              }}
            >
              {w.active ? "🔥" : ""}
            </span>
          </div>
        ))}
      </div>
      <div style={styles.progGoalRow}>
        <div style={styles.progTrack}>
          <div style={{ ...styles.progFill, width: `${pct}%` }} />
        </div>
        <span style={styles.progGoalLbl}>
          {todayXp >= DAILY_XP_GOAL
            ? "🎉 Daily goal done!"
            : `${todayXp}/${DAILY_XP_GOAL} XP today`}
        </span>
      </div>
      <div style={styles.progBarsHead}>📊 Every day · last 2 weeks</div>
      <div style={styles.progBars}>
        {days14.map((d, i) => (
          <div key={i} style={styles.progBarCol} title={`${d.xp} XP`}>
            <div style={styles.progBarTrack}>
              <div
                style={{
                  ...styles.progBarFill,
                  height: `${Math.max(d.xp > 0 ? 10 : 3, Math.round((d.xp / maxXp) * 100))}%`,
                  ...(d.isToday ? styles.progBarToday : {}),
                  ...(d.xp === 0 ? { background: "var(--border)" } : {}),
                }}
              />
            </div>
          </div>
        ))}
      </div>
      <div style={styles.progBarsHead}>
        📈 Progress over time
        <span style={styles.growthGain}>
          {gained30 > 0 ? `+${gained30} XP` : "no XP yet"} · 30 days
        </span>
      </div>
      <div style={styles.growthWrap}>
        <div style={styles.growthYAxis}>
          <span>{gTop}</span>
          <span>{gMid}</span>
          <span>{gBot}</span>
        </div>
        <div style={styles.growthPlot}>
          <svg
            viewBox={`0 0 ${GW} ${GH}`}
            preserveAspectRatio="none"
            style={styles.progGraph}
            aria-hidden
          >
            {[0, GH / 2, GH].map((y, i) => (
              <line
                key={i}
                x1={0}
                y1={y}
                x2={GW}
                y2={y}
                stroke="var(--border)"
                strokeWidth={1}
                strokeDasharray={i === 2 ? undefined : "3 4"}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            <path d={gArea} fill="var(--accent-soft)" />
            <path
              d={gLine}
              fill="none"
              stroke="var(--accent)"
              strokeWidth={2.5}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          {gEmpty ? (
            <span style={styles.growthEmpty}>Earn XP to grow this line 🌱</span>
          ) : (
            <span
              style={{ ...styles.growthDot, top: `${gLastYPct}%` }}
              title={`${gTop} XP so far`}
            />
          )}
        </div>
      </div>
      <div style={styles.growthXAxis}>
        <span>{gStartLabel}</span>
        <span>Today</span>
      </div>
      <div style={styles.progBarsHead}>
        ⏱️ Hours studied · per week
        <span style={styles.growthGain}>
          {thisWeekHours > 0 ? fmtDuration(thisWeekHours * 60) : "0m"} this week
        </span>
      </div>
      {totalStudyMin === 0 ? (
        <div style={styles.studyEmpty}>
          Run a focus timer on a study block to start banking hours ⏱️
        </div>
      ) : (
        <div style={styles.studyWeeks}>
          {weeks.map((w, i) => (
            <div
              key={i}
              style={styles.studyWeekCol}
              title={`Week of ${w.label}: ${fmtDuration(w.hours * 60)}`}
            >
              <span style={styles.studyWeekVal}>
                {w.hours > 0
                  ? w.hours >= 1
                    ? `${w.hours.toFixed(w.hours < 10 ? 1 : 0)}h`
                    : `${Math.round(w.hours * 60)}m`
                  : ""}
              </span>
              <div style={styles.studyWeekTrack}>
                <div
                  style={{
                    ...styles.studyWeekFill,
                    height: `${Math.max(w.hours > 0 ? 8 : 0, Math.round((w.hours / maxWeekHours) * 100))}%`,
                    ...(w.isThisWeek ? styles.studyWeekFillNow : {}),
                  }}
                />
              </div>
              <span
                style={{
                  ...styles.studyWeekLbl,
                  ...(w.isThisWeek ? styles.studyWeekLblNow : {}),
                }}
              >
                {w.isThisWeek ? "This wk" : w.label}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Consecutive active days ending today (or yesterday if today is still blank).
function currentStreak(log: Record<string, number>): number {
  let streak = 0;
  const d = new Date();
  if (!(log[localISO(d)] > 0)) d.setDate(d.getDate() - 1);
  while (log[localISO(d)] > 0) {
    streak++;
    d.setDate(d.getDate() - 1);
  }
  return streak;
}

// "☀️ Today" recap: a plain-language headline, today's XP toward the daily goal,
// the current streak, and anything due (or overdue) today. Built only from data
// that's actually time-stamped — the XP log and item due dates — so it never
// overstates what happened.
function DailyRecap({
  log,
  assignments,
  events,
}: {
  log: Record<string, number>;
  assignments: Assignment[];
  events: StudyEvent[];
}) {
  const todayISO = localISO();
  const todayXp = log[todayISO] || 0;
  const streak = currentStreak(log);
  const goalPct = Math.min(100, Math.round((todayXp / DAILY_XP_GOAL) * 100));
  const dueToday = [
    ...assignments
      .filter((a) => !a.done && a.due === todayISO)
      .map((a) => a.title),
    ...events.filter((e) => e.date === todayISO).map((e) => e.title),
  ];
  const overdue = assignments.filter(
    (a) => !a.done && a.due && a.due < todayISO,
  );
  const headline =
    todayXp >= DAILY_XP_GOAL
      ? "🎉 Daily goal smashed — great work today!"
      : todayXp > 0
        ? `Good start — ${todayXp}/${DAILY_XP_GOAL} XP so far today.`
        : streak > 0
          ? "Nothing logged yet — a few minutes keeps your streak alive. 🔥"
          : "Ready when you are — check off one thing to get rolling.";
  const dateLabel = new Date(`${todayISO}T00:00:00`).toLocaleDateString(
    "en-US",
    { weekday: "short", month: "short", day: "numeric" },
  );
  return (
    <div style={styles.card}>
      <div style={styles.cardHead}>
        <span style={styles.cardClass}>☀️ Today</span>
        <span style={styles.subjectsCount}>{dateLabel}</span>
      </div>
      <p style={styles.recapHeadline}>{headline}</p>
      <div style={styles.planProgTrack}>
        <div style={{ ...styles.planProgFill, width: `${goalPct}%` }} />
      </div>
      <div style={styles.planProgMeta}>
        ⭐ {todayXp} XP today · 🔥 {streak}-day streak
      </div>
      {(dueToday.length > 0 || overdue.length > 0) && (
        <div style={styles.recapList}>
          {dueToday.map((t, i) => (
            <div key={`d${i}`} style={styles.recapItem}>
              <span>📌</span>
              <span style={{ flex: 1 }}>{t}</span>
              <span style={styles.recapTag}>due today</span>
            </div>
          ))}
          {overdue.map((a, i) => (
            <div key={`o${i}`} style={styles.recapItem}>
              <span>⚠️</span>
              <span style={{ flex: 1 }}>{a.title}</span>
              <span style={{ ...styles.recapTag, ...styles.recapTagWarn }}>
                overdue
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// "📅 This week" recap: XP this week with a trend vs last week, active days,
// the best day, and a snapshot of open + overdue work. Weeks start Sunday to
// match the ProgressCard week strip.
function WeeklyRecap({
  log,
  plan,
  goals,
  assignments,
  fourYearPlan,
}: {
  log: Record<string, number>;
  plan: Milestone[];
  goals: SmartGoal[];
  assignments: Assignment[];
  fourYearPlan: FourYearPlan | null;
}) {
  const now = new Date();
  const todayISO = localISO(now);
  const sunday = new Date(now);
  sunday.setDate(now.getDate() - now.getDay());
  const weekISOs = Array.from({ length: 7 }, (_, i) => {
    const dt = new Date(sunday);
    dt.setDate(sunday.getDate() + i);
    return localISO(dt);
  });
  const lastWeekISOs = weekISOs.map((_, i) => {
    const dt = new Date(sunday);
    dt.setDate(sunday.getDate() - 7 + i);
    return localISO(dt);
  });
  const sum = (isos: string[]) =>
    isos.reduce((n, iso) => n + (log[iso] || 0), 0);
  const thisWeekXp = sum(weekISOs);
  const lastWeekXp = sum(lastWeekISOs);
  const activeDays = weekISOs.filter((iso) => (log[iso] || 0) > 0).length;
  const delta = thisWeekXp - lastWeekXp;
  let bestIso = weekISOs[0];
  for (const iso of weekISOs)
    if ((log[iso] || 0) > (log[bestIso] || 0)) bestIso = iso;
  const bestXp = log[bestIso] || 0;
  const bestLabel = new Date(`${bestIso}T00:00:00`).toLocaleDateString("en-US", {
    weekday: "long",
  });
  const fyCourses = fourYearPlan
    ? fourYearPlan.years.flatMap((y) => y.courses)
    : [];
  const openItems =
    plan.filter((m) => !m.done).length +
    goals.filter((g) => !g.done).length +
    assignments.filter((a) => !a.done).length +
    fyCourses.filter((c) => !c.done).length;
  const overdue = assignments.filter(
    (a) => !a.done && a.due && a.due < todayISO,
  ).length;
  const trend =
    lastWeekXp === 0
      ? thisWeekXp > 0
        ? "off to a fresh start 🌱"
        : "a quiet week so far"
      : delta > 0
        ? `up ${Math.round((delta / lastWeekXp) * 100)}% vs last week ↑`
        : delta < 0
          ? `down ${Math.round((-delta / lastWeekXp) * 100)}% vs last week ↓`
          : "level with last week";
  return (
    <div style={styles.card}>
      <div style={styles.cardHead}>
        <span style={styles.cardClass}>📅 This week</span>
        <span style={styles.subjectsCount}>{activeDays}/7 active days</span>
      </div>
      <div style={styles.recapStatRow}>
        <div style={styles.recapStat}>
          <span style={styles.recapStatBig}>⭐ {thisWeekXp}</span>
          <span style={styles.recapStatLbl}>XP this week</span>
        </div>
        <div style={styles.recapStat}>
          <span style={styles.recapStatBig}>{activeDays}</span>
          <span style={styles.recapStatLbl}>active days</span>
        </div>
        <div style={styles.recapStat}>
          <span style={styles.recapStatBig}>{bestXp > 0 ? bestXp : "—"}</span>
          <span style={styles.recapStatLbl}>
            {bestXp > 0 ? `best · ${bestLabel}` : "best day"}
          </span>
        </div>
      </div>
      <p style={styles.recapHeadline}>📊 You&rsquo;re {trend}.</p>
      <div style={styles.recapList}>
        <div style={styles.recapItem}>
          <span>🗂️</span>
          <span style={{ flex: 1 }}>Open items to finish</span>
          <span style={styles.recapTag}>{openItems}</span>
        </div>
        {overdue > 0 && (
          <div style={styles.recapItem}>
            <span>⚠️</span>
            <span style={{ flex: 1 }}>Overdue</span>
            <span style={{ ...styles.recapTag, ...styles.recapTagWarn }}>
              {overdue}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// "📈 Monthly report": one calendar month at a time. The top half is a factual
// recap built only from time-stamped data (the XP log, study-minutes log, mistake
// timestamps, and item due dates) plus current standings (goals, GPA) — so it never
// overstates. The bottom half is Eliora's warm AI recap, generated on demand and
// cached per month. Navigate months with the arrows; you can't go past this month.
function MonthlyReport({
  log,
  study,
  goals,
  assignments,
  mistakes,
  fourYearPlan,
  reports,
  busyKey,
  onGenerate,
}: {
  log: Record<string, number>;
  study: Record<string, number>;
  goals: SmartGoal[];
  assignments: Assignment[];
  mistakes: Mistake[];
  fourYearPlan: FourYearPlan | null;
  reports: Record<string, { message: string; focus: string[]; generatedAt: string }>;
  busyKey: string | null;
  onGenerate: (monthKey: string, payload: Record<string, unknown>) => void;
}) {
  const now = new Date();
  const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  // Offset in months back from the current month (0 = this month).
  const [offset, setOffset] = useState(0);
  const sel = new Date(now.getFullYear(), now.getMonth() - offset, 1);
  const year = sel.getFullYear();
  const month = sel.getMonth();
  const isCurrentMonth = offset === 0;
  const monthKey = `${year}-${String(month + 1).padStart(2, "0")}`; // YYYY-MM
  const monthLabel = sel.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const monthISOs = Array.from({ length: daysInMonth }, (_, i) =>
    localISO(new Date(year, month, i + 1)),
  );

  const xp = monthISOs.reduce((n, iso) => n + (log[iso] || 0), 0);
  const minutes = monthISOs.reduce((n, iso) => n + (study[iso] || 0), 0);
  const hours = Math.round((minutes / 60) * 10) / 10;
  const activeDays = monthISOs.filter(
    (iso) => (log[iso] || 0) > 0 || (study[iso] || 0) > 0,
  ).length;
  let bestIso = monthISOs[0];
  for (const iso of monthISOs)
    if ((log[iso] || 0) > (log[bestIso] || 0)) bestIso = iso;
  const bestDayXp = log[bestIso] || 0;
  const bestLabel = new Date(`${bestIso}T00:00:00`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
  // Streak only means something as of *now* — don't show it for past months.
  const streak = isCurrentMonth ? currentStreak(log) : undefined;

  const activeGoals = goals.filter((g) => !g.done);
  const goalsDone = goals.filter((g) => g.done).length;
  const goalProgress = activeGoals
    .filter((g) => typeof g.target === "number")
    .map(
      (g) =>
        `${g.statement?.trim() || g.specific} — ${g.current ?? 0}/${g.target}`,
    );
  // Goals whose deadline lands in this month (or is already overdue this month).
  const goalsDueSoon = activeGoals
    .filter((g) => g.timeBound && g.timeBound.slice(0, 7) <= monthKey)
    .filter((g) => g.timeBound!.slice(0, 7) === monthKey || isCurrentMonth)
    .map((g) => {
      const head = g.statement?.trim() || g.specific;
      return `${head} (by ${g.timeBound})`;
    });

  const assignmentsDue = assignments.filter(
    (a) => a.due && a.due.slice(0, 7) === monthKey,
  ).length;
  const assignmentsDone = assignments.filter((a) => a.done).length;

  const mistakesLogged = mistakes.filter(
    (m) => typeof m.createdAt === "string" && m.createdAt.slice(0, 7) === monthKey,
  ).length;
  const mistakesOpen = mistakes
    .filter((m) => !m.resolved)
    .map((m) => (m.subject ? `${m.subject}: ${m.concept}` : m.concept));

  const gpa = fourYearPlan ? fypCredits(fourYearPlan).weightedGpa : undefined;
  const projectedGpa = fourYearPlan
    ? fypProjection(fourYearPlan).projectedWeightedGpa
    : undefined;

  const quiet = xp === 0 && minutes === 0;
  const report = reports[monthKey];
  const busy = busyKey === monthKey;

  const payload: Record<string, unknown> = {
    monthLabel,
    career: fourYearPlan?.destination,
    xp,
    studyHours: hours,
    activeDays,
    daysInMonth,
    bestDayXp,
    streak,
    gpa,
    projectedGpa,
    goalsActive: activeGoals.length,
    goalsDone,
    goalsDueSoon,
    goalProgress,
    mistakesLogged,
    mistakesOpen,
    assignmentsDue,
    assignmentsDone,
    quiet,
  };

  return (
    <div style={styles.card}>
      <div style={styles.cardHead}>
        <span style={styles.cardClass}>📈 {monthLabel}</span>
        <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <button
            style={styles.monthNavBtn}
            onClick={() => setOffset((o) => o + 1)}
            aria-label="Previous month"
            title="Previous month"
          >
            ‹
          </button>
          <button
            style={{
              ...styles.monthNavBtn,
              ...(isCurrentMonth ? styles.monthNavBtnOff : {}),
            }}
            onClick={() => setOffset((o) => Math.max(0, o - 1))}
            disabled={isCurrentMonth}
            aria-label="Next month"
            title="Next month"
          >
            ›
          </button>
        </span>
      </div>

      <div style={styles.recapStatRow}>
        <div style={styles.recapStat}>
          <span style={styles.recapStatBig}>⭐ {xp}</span>
          <span style={styles.recapStatLbl}>XP this month</span>
        </div>
        <div style={styles.recapStat}>
          <span style={styles.recapStatBig}>{hours > 0 ? hours : "—"}</span>
          <span style={styles.recapStatLbl}>hours studied</span>
        </div>
        <div style={styles.recapStat}>
          <span style={styles.recapStatBig}>
            {activeDays}
            <span style={{ fontSize: 15, color: "var(--muted)" }}>
              /{daysInMonth}
            </span>
          </span>
          <span style={styles.recapStatLbl}>active days</span>
        </div>
      </div>

      <div style={styles.recapList}>
        {bestDayXp > 0 && (
          <div style={styles.recapItem}>
            <span>🏆</span>
            <span style={{ flex: 1 }}>Best day · {bestLabel}</span>
            <span style={styles.recapTag}>{bestDayXp} XP</span>
          </div>
        )}
        {typeof streak === "number" && streak > 0 && (
          <div style={styles.recapItem}>
            <span>🔥</span>
            <span style={{ flex: 1 }}>Current streak</span>
            <span style={styles.recapTag}>{streak} days</span>
          </div>
        )}
        {(goalsDone > 0 || activeGoals.length > 0) && (
          <div style={styles.recapItem}>
            <span>🌟</span>
            <span style={{ flex: 1 }}>Goals</span>
            <span style={styles.recapTag}>
              {goalsDone} done · {activeGoals.length} active
            </span>
          </div>
        )}
        {assignmentsDue > 0 && (
          <div style={styles.recapItem}>
            <span>📌</span>
            <span style={{ flex: 1 }}>Assignments due this month</span>
            <span style={styles.recapTag}>{assignmentsDue}</span>
          </div>
        )}
        {mistakesLogged > 0 && (
          <div style={styles.recapItem}>
            <span>🧩</span>
            <span style={{ flex: 1 }}>Mistakes captured to work on</span>
            <span style={styles.recapTag}>{mistakesLogged}</span>
          </div>
        )}
        {typeof gpa === "number" && (
          <div style={styles.recapItem}>
            <span>🎓</span>
            <span style={{ flex: 1 }}>Weighted GPA so far</span>
            <span style={styles.recapTag}>{gpa.toFixed(2)}</span>
          </div>
        )}
      </div>

      {/* Eliora's AI recap for the month — generated on demand, cached per month. */}
      <div style={styles.reflSection}>
        {report ? (
          <>
            <div style={styles.reflBox}>
              <p style={styles.reflSavedMsg}>{report.message}</p>
              {report.focus.length > 0 && (
                <div style={styles.reflFocusList}>
                  {report.focus.map((f, i) => (
                    <div key={i} style={styles.reflFocusItem}>
                      → {f}
                    </div>
                  ))}
                </div>
              )}
            </div>
            <button
              style={styles.linkBtn}
              disabled={busy}
              onClick={() => onGenerate(monthKey, payload)}
            >
              {busy ? "…" : "↻ Regenerate recap"}
            </button>
          </>
        ) : (
          <>
            <p style={styles.fypJoinsSub}>
              {quiet
                ? "No tracked activity yet this month — a recap will be light, but you can still get an encouraging note and a fresh focus for the month ahead."
                : "Get a warm recap of your month from Eliora — what went well, and a few focuses for next month."}
            </p>
            <button
              style={styles.reflOpenBtn}
              disabled={busy}
              onClick={() => onGenerate(monthKey, payload)}
            >
              {busy ? "Writing your recap…" : "✨ Generate monthly recap"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// "What you learned this week" recap: a Monday–Sunday window of the learner's
// tracked activity (XP/effort, study hours, active days, streak, subjects &
// concepts practiced, goal progress, what's due) plus Eliora's warm AI recap +
// focuses for next week. Mirrors MonthlyReport, scoped to a 7-day week and cached
// per week (keyed by the Monday's YYYY-MM-DD).
function WeeklyLearnedRecap({
  log,
  study,
  goals,
  assignments,
  mistakes,
  fourYearPlan,
  reports,
  busyKey,
  onGenerate,
}: {
  log: Record<string, number>;
  study: Record<string, number>;
  goals: SmartGoal[];
  assignments: Assignment[];
  mistakes: Mistake[];
  fourYearPlan: FourYearPlan | null;
  reports: Record<string, { message: string; focus: string[]; generatedAt: string }>;
  busyKey: string | null;
  onGenerate: (weekKey: string, payload: Record<string, unknown>) => void;
}) {
  const now = new Date();
  // Offset in weeks back from the current week (0 = this week).
  const [offset, setOffset] = useState(0);
  // Monday-start week. dow: 0 = Monday … 6 = Sunday.
  const dow = (now.getDay() + 6) % 7;
  const weekStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - dow - offset * 7,
  );
  const weekEnd = new Date(
    weekStart.getFullYear(),
    weekStart.getMonth(),
    weekStart.getDate() + 6,
  );
  const isCurrentWeek = offset === 0;
  const weekKey = localISO(weekStart); // Monday's YYYY-MM-DD
  const weekISOs = Array.from({ length: 7 }, (_, i) =>
    localISO(
      new Date(
        weekStart.getFullYear(),
        weekStart.getMonth(),
        weekStart.getDate() + i,
      ),
    ),
  );
  const weekSet = new Set(weekISOs);
  const fmt = (d: Date) =>
    d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const weekLabel = `${fmt(weekStart)} – ${fmt(weekEnd)}`;

  const xp = weekISOs.reduce((n, iso) => n + (log[iso] || 0), 0);
  const minutes = weekISOs.reduce((n, iso) => n + (study[iso] || 0), 0);
  const hours = Math.round((minutes / 60) * 10) / 10;
  const activeDays = weekISOs.filter(
    (iso) => (log[iso] || 0) > 0 || (study[iso] || 0) > 0,
  ).length;
  let bestIso = weekISOs[0];
  for (const iso of weekISOs)
    if ((log[iso] || 0) > (log[bestIso] || 0)) bestIso = iso;
  const bestDayXp = log[bestIso] || 0;
  const bestLabel = new Date(`${bestIso}T00:00:00`).toLocaleDateString("en-US", {
    weekday: "short",
  });
  // Streak only means something as of *now* — don't show it for past weeks.
  const streak = isCurrentWeek ? currentStreak(log) : undefined;

  // Concepts they engaged this week (captured to work on), and the subjects/
  // topics those touch — the honest, timestamped signal for "what you practiced".
  const mistakesThisWeek = mistakes.filter(
    (m) => typeof m.createdAt === "string" && weekSet.has(m.createdAt.slice(0, 10)),
  );
  const assignmentsDueList = assignments.filter(
    (a) => a.due && weekSet.has(a.due),
  );
  const topics = Array.from(
    new Set(
      [
        ...mistakesThisWeek.map((m) => m.subject?.trim() || m.concept?.trim()),
        ...assignmentsDueList.map((a) => a.subject?.trim()),
      ].filter((t): t is string => Boolean(t)),
    ),
  );
  const mistakesLogged = mistakesThisWeek.length;
  const mistakesOpen = mistakes
    .filter((m) => !m.resolved)
    .map((m) => (m.subject ? `${m.subject}: ${m.concept}` : m.concept));

  const activeGoals = goals.filter((g) => !g.done);
  const goalsDone = goals.filter((g) => g.done).length;
  const goalProgress = activeGoals
    .filter((g) => typeof g.target === "number")
    .map(
      (g) =>
        `${g.statement?.trim() || g.specific} — ${g.current ?? 0}/${g.target}`,
    );
  // Goals whose deadline lands in this week.
  const goalsDueSoon = activeGoals
    .filter((g) => g.timeBound && weekSet.has(g.timeBound))
    .map((g) => {
      const head = g.statement?.trim() || g.specific;
      return `${head} (by ${g.timeBound})`;
    });
  const assignmentsDue = assignmentsDueList.length;

  const quiet = xp === 0 && minutes === 0;
  const report = reports[weekKey];
  const busy = busyKey === weekKey;

  const payload: Record<string, unknown> = {
    weekLabel,
    career: fourYearPlan?.destination,
    xp,
    studyHours: hours,
    activeDays,
    bestDayXp,
    bestDayLabel: bestDayXp > 0 ? bestLabel : undefined,
    streak,
    topics,
    mistakesLogged,
    mistakesOpen,
    goalsActive: activeGoals.length,
    goalsDone,
    goalsDueSoon,
    goalProgress,
    assignmentsDue,
    quiet,
  };

  return (
    <div style={styles.card}>
      <div style={styles.cardHead}>
        <span style={styles.cardClass}>📚 What you learned</span>
        <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <button
            style={styles.monthNavBtn}
            onClick={() => setOffset((o) => o + 1)}
            aria-label="Previous week"
            title="Previous week"
          >
            ‹
          </button>
          <button
            style={{
              ...styles.monthNavBtn,
              ...(isCurrentWeek ? styles.monthNavBtnOff : {}),
            }}
            onClick={() => setOffset((o) => Math.max(0, o - 1))}
            disabled={isCurrentWeek}
            aria-label="Next week"
            title="Next week"
          >
            ›
          </button>
        </span>
      </div>
      <p
        style={{
          color: "var(--muted)",
          margin: "0 0 10px",
          fontSize: 13,
          fontWeight: 600,
        }}
      >
        {isCurrentWeek ? "This week" : "Week of"} · {weekLabel}
      </p>

      <div style={styles.recapStatRow}>
        <div style={styles.recapStat}>
          <span style={styles.recapStatBig}>⭐ {xp}</span>
          <span style={styles.recapStatLbl}>XP this week</span>
        </div>
        <div style={styles.recapStat}>
          <span style={styles.recapStatBig}>{hours > 0 ? hours : "—"}</span>
          <span style={styles.recapStatLbl}>hours studied</span>
        </div>
        <div style={styles.recapStat}>
          <span style={styles.recapStatBig}>
            {activeDays}
            <span style={{ fontSize: 15, color: "var(--muted)" }}>/7</span>
          </span>
          <span style={styles.recapStatLbl}>active days</span>
        </div>
      </div>

      <div style={styles.recapList}>
        {topics.length > 0 && (
          <div style={styles.recapItem}>
            <span>🧠</span>
            <span style={{ flex: 1 }}>Practiced</span>
            <span style={styles.recapTag}>{topics.slice(0, 3).join(", ")}</span>
          </div>
        )}
        {bestDayXp > 0 && (
          <div style={styles.recapItem}>
            <span>🏆</span>
            <span style={{ flex: 1 }}>Best day · {bestLabel}</span>
            <span style={styles.recapTag}>{bestDayXp} XP</span>
          </div>
        )}
        {typeof streak === "number" && streak > 0 && (
          <div style={styles.recapItem}>
            <span>🔥</span>
            <span style={{ flex: 1 }}>Current streak</span>
            <span style={styles.recapTag}>{streak} days</span>
          </div>
        )}
        {mistakesLogged > 0 && (
          <div style={styles.recapItem}>
            <span>🧩</span>
            <span style={{ flex: 1 }}>Concepts captured to work on</span>
            <span style={styles.recapTag}>{mistakesLogged}</span>
          </div>
        )}
        {assignmentsDue > 0 && (
          <div style={styles.recapItem}>
            <span>📌</span>
            <span style={{ flex: 1 }}>Assignments due this week</span>
            <span style={styles.recapTag}>{assignmentsDue}</span>
          </div>
        )}
        {(goalsDone > 0 || activeGoals.length > 0) && (
          <div style={styles.recapItem}>
            <span>🌟</span>
            <span style={{ flex: 1 }}>Goals</span>
            <span style={styles.recapTag}>
              {goalsDone} done · {activeGoals.length} active
            </span>
          </div>
        )}
      </div>

      {/* Eliora's AI recap for the week — generated on demand, cached per week. */}
      <div style={styles.reflSection}>
        {report ? (
          <>
            <div style={styles.reflBox}>
              <p style={styles.reflSavedMsg}>{report.message}</p>
              {report.focus.length > 0 && (
                <div style={styles.reflFocusList}>
                  {report.focus.map((f, i) => (
                    <div key={i} style={styles.reflFocusItem}>
                      → {f}
                    </div>
                  ))}
                </div>
              )}
            </div>
            <button
              style={styles.linkBtn}
              disabled={busy}
              onClick={() => onGenerate(weekKey, payload)}
            >
              {busy ? "…" : "↻ Regenerate recap"}
            </button>
          </>
        ) : (
          <>
            <p style={styles.fypJoinsSub}>
              {quiet
                ? "No tracked activity yet this week — a recap will be light, but you can still get an encouraging note and a fresh focus for the week ahead."
                : "Get a warm recap from Eliora of what you learned this week — and a few focuses for next week."}
            </p>
            <button
              style={styles.reflOpenBtn}
              disabled={busy}
              onClick={() => onGenerate(weekKey, payload)}
            >
              {busy ? "Writing your recap…" : "✨ Recap what I learned"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function FourYearStrip({
  plan,
  onOpen,
}: {
  plan: FourYearPlan | null;
  onOpen: () => void;
}) {
  if (!plan || !plan.years.length) return null;
  const total = plan.years.reduce((n, y) => n + y.courses.length, 0);
  const done = plan.years.reduce(
    (n, y) => n + y.courses.filter((c) => c.done).length,
    0,
  );
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div style={styles.planStrip}>
      <div style={styles.planStripHead}>
        <span style={styles.planStripLabel}>🗺️ 4-year plan</span>
        <button style={styles.linkBtn} onClick={onOpen}>
          View
        </button>
      </div>
      <button style={styles.planStripNext} onClick={onOpen}>
        <span style={{ flex: 1, textAlign: "left" }}>
          {plan.destination || "Your roadmap"}
        </span>
        {total > 0 && (
          <span style={styles.goalCount}>
            {done}/{total}
          </span>
        )}
      </button>
      {total > 0 && (
        <div style={styles.goalTrack}>
          <div style={{ ...styles.goalFill, width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

// One year card in the roadmap: its courses (checkable) and milestones, each
// with inline add inputs. Local state keeps the add fields per-card.
function FourYearYearCard({
  year,
  index,
  onAddCourse,
  onRemoveCourse,
  onToggleCourse,
  onSetCourse,
  onAddMilestone,
  onRemoveMilestone,
  onToggleMilestone,
  onToggleCheckpoint,
  onAddToPlan,
  onResources,
  planTitles,
}: {
  year: FourYearYear;
  index: number;
  onAddCourse: (i: number, title: string) => void;
  onRemoveCourse: (i: number, ci: number) => void;
  onToggleCourse: (i: number, ci: number) => void;
  onSetCourse: (i: number, ci: number, patch: Partial<FourYearCourse>) => void;
  onAddMilestone: (i: number, title: string) => void;
  onRemoveMilestone: (i: number, mi: number) => void;
  onToggleMilestone: (i: number, mi: number) => void;
  onToggleCheckpoint: (i: number, mi: number) => void;
  onAddToPlan: (title: string) => void;
  onResources: (title: string) => void;
  planTitles: Set<string>;
}) {
  // A small "add to my study plan" control, shown per course/milestone. Once the
  // item is already a plan step it switches to a non-interactive "✓ In plan".
  const planBtn = (title: string) =>
    planTitles.has(title.trim()) ? (
      <span style={styles.fypInPlan} title="Already in your plan">
        ✓ In plan
      </span>
    ) : (
      <button
        style={styles.fypAddPlan}
        onClick={() => onAddToPlan(title)}
        title="Add this to my study plan"
      >
        ＋ Plan
      </button>
    );
  const [course, setCourse] = useState("");
  const [ms, setMs] = useState("");
  const doneCount = year.courses.filter((c) => c.done).length;
  const addCourse = () => {
    if (!course.trim()) return;
    onAddCourse(index, course);
    setCourse("");
  };
  const addMs = () => {
    if (!ms.trim()) return;
    onAddMilestone(index, ms);
    setMs("");
  };
  return (
    <div style={styles.fypYear}>
      <div style={styles.fypYearHead}>
        <span style={styles.fypYearLabel}>{year.label}</span>
        <span style={styles.subjectsCount}>
          {doneCount}/{year.courses.length} done
        </span>
      </div>

      <div style={styles.fypSectionLabel}>Courses</div>
      {year.courses.map((c, ci) => (
        <div key={ci} style={styles.fypRow}>
          <button
            style={{ ...styles.goalTaskToggle, flex: 1 }}
            onClick={() => onToggleCourse(index, ci)}
          >
            <span
              style={{
                ...styles.checkbox,
                borderColor: "var(--accent)",
                background: c.done ? "var(--accent)" : "transparent",
                color: c.done ? "#fff" : "transparent",
              }}
            >
              ✓
            </span>
            <span
              style={{
                textDecoration: c.done ? "line-through" : "none",
                color: c.done ? "var(--muted)" : "var(--assistant-text)",
              }}
            >
              {c.title}
              <span style={styles.fypCr}>
                {" "}
                · {c.credits ?? 1} cr{c.category ? ` · ${c.category}` : ""}
              </span>
              {c.note ? <span style={styles.fypNote}> — {c.note}</span> : null}
            </span>
          </button>
          <select
            style={styles.fypCourseSelect}
            value={c.level ?? "Regular"}
            onChange={(e) =>
              onSetCourse(index, ci, {
                level: e.target.value as CourseLevel,
              })
            }
            title="Course level (affects weighted GPA)"
            aria-label={`Level for ${c.title}`}
          >
            {LEVEL_OPTIONS.map((lv) => (
              <option key={lv} value={lv}>
                {lv}
              </option>
            ))}
          </select>
          <select
            style={styles.fypCourseSelect}
            value={c.grade ?? ""}
            onChange={(e) =>
              onSetCourse(index, ci, { grade: e.target.value || undefined })
            }
            title="Grade earned (counts toward GPA once done)"
            aria-label={`Grade for ${c.title}`}
          >
            <option value="">Grade</option>
            {GRADE_OPTIONS.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
          {planBtn(c.title)}
          <button
            style={styles.folderRemove}
            onClick={() => onRemoveCourse(index, ci)}
            aria-label={`Remove ${c.title}`}
          >
            ×
          </button>
        </div>
      ))}
      <div style={styles.fypAddRow}>
        <input
          style={styles.assignInput}
          value={course}
          placeholder="Add a course…"
          onChange={(e) => setCourse(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") addCourse();
          }}
        />
        <button style={styles.assignAddBtn} onClick={addCourse}>
          Add
        </button>
      </div>

      <div style={styles.fypSectionLabel}>Milestones</div>
      {year.milestones.map((m, mi) => (
        <div key={mi} style={styles.fypRow}>
          <button
            style={{ ...styles.goalTaskToggle, flex: 1 }}
            onClick={() => onToggleMilestone(index, mi)}
          >
            <span
              style={{
                ...styles.checkbox,
                borderColor: "#b8742a",
                background: m.done ? "#b8742a" : "transparent",
                color: m.done ? "#fff" : "transparent",
              }}
            >
              ✓
            </span>
            <span
              style={{
                textDecoration: m.done ? "line-through" : "none",
                color: m.done ? "var(--muted)" : "var(--assistant-text)",
              }}
            >
              {m.checkpoint && (
                <span style={styles.fypCheckpointBadge}>🚩 Checkpoint</span>
              )}
              {m.title}
            </span>
          </button>
          <button
            style={{
              ...styles.fypFlagBtn,
              ...(m.checkpoint ? styles.fypFlagBtnActive : {}),
            }}
            onClick={() => onToggleCheckpoint(index, mi)}
            title={
              m.checkpoint ? "Remove checkpoint" : "Mark as a review checkpoint"
            }
            aria-label="Toggle checkpoint"
          >
            🚩
          </button>
          <button
            style={styles.fypResBtn}
            onClick={() => onResources(m.title)}
            title="Find resources to complete this"
          >
            💡 Resources
          </button>
          {planBtn(m.title)}
          <button
            style={styles.folderRemove}
            onClick={() => onRemoveMilestone(index, mi)}
            aria-label={`Remove ${m.title}`}
          >
            ×
          </button>
        </div>
      ))}
      <div style={styles.fypAddRow}>
        <input
          style={styles.assignInput}
          value={ms}
          placeholder="Add a milestone…"
          onChange={(e) => setMs(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") addMs();
          }}
        />
        <button style={styles.assignAddBtn} onClick={addMs}>
          Add
        </button>
      </div>
    </div>
  );
}

// One year column in the spreadsheet grid view. Same data + handlers as the card,
// laid out as compact bordered cells so the whole roadmap reads like a spreadsheet.
function FypGridColumn({
  year,
  index,
  onAddCourse,
  onRemoveCourse,
  onToggleCourse,
  onSetCourse,
  onAddMilestone,
  onRemoveMilestone,
  onToggleMilestone,
  onToggleCheckpoint,
}: {
  year: FourYearYear;
  index: number;
  onAddCourse: (i: number, title: string) => void;
  onRemoveCourse: (i: number, ci: number) => void;
  onToggleCourse: (i: number, ci: number) => void;
  onSetCourse: (i: number, ci: number, patch: Partial<FourYearCourse>) => void;
  onAddMilestone: (i: number, title: string) => void;
  onRemoveMilestone: (i: number, mi: number) => void;
  onToggleMilestone: (i: number, mi: number) => void;
  onToggleCheckpoint: (i: number, mi: number) => void;
}) {
  const [course, setCourse] = useState("");
  const [ms, setMs] = useState("");
  const doneCount = year.courses.filter((c) => c.done).length;
  const credits = year.courses.reduce((n, c) => n + (c.credits ?? 1), 0);
  const yearGpa = fypYearGpa(year);
  const addCourse = () => {
    if (!course.trim()) return;
    onAddCourse(index, course);
    setCourse("");
  };
  const addMs = () => {
    if (!ms.trim()) return;
    onAddMilestone(index, ms);
    setMs("");
  };
  return (
    <div style={styles.fypGridCol}>
      <div style={styles.fypGridHead}>
        <div style={styles.fypGridYear}>{year.label}</div>
        <div style={styles.fypGridSub}>
          {doneCount}/{year.courses.length} done · {credits} cr
          {yearGpa != null && (
            <span style={styles.fypGridGpa}> · GPA {yearGpa.toFixed(2)}</span>
          )}
        </div>
      </div>

      <div style={styles.fypGridSection}>Courses</div>
      {year.courses.map((c, ci) => (
        <div key={ci} style={styles.fypGridCell}>
          <button
            style={styles.fypGridCheck}
            onClick={() => onToggleCourse(index, ci)}
          >
            <span
              style={{
                ...styles.checkbox,
                borderColor: "var(--accent)",
                background: c.done ? "var(--accent)" : "transparent",
                color: c.done ? "#fff" : "transparent",
              }}
            >
              ✓
            </span>
            <span
              style={{
                textDecoration: c.done ? "line-through" : "none",
                color: c.done ? "var(--muted)" : "var(--assistant-text)",
              }}
            >
              {c.title}
            </span>
          </button>
          <div style={styles.fypGridMeta}>
            <span style={styles.fypCr}>{c.credits ?? 1} cr</span>
            <select
              style={styles.fypGridSelect}
              value={c.grade ?? ""}
              onChange={(e) =>
                onSetCourse(index, ci, { grade: e.target.value || undefined })
              }
              title="Grade earned"
              aria-label={`Grade for ${c.title}`}
            >
              <option value="">–</option>
              {GRADE_OPTIONS.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
            <button
              style={styles.fypGridRemove}
              onClick={() => onRemoveCourse(index, ci)}
              aria-label={`Remove ${c.title}`}
            >
              ×
            </button>
          </div>
        </div>
      ))}
      <div style={styles.fypGridAdd}>
        <input
          style={styles.fypGridInput}
          value={course}
          placeholder="+ course"
          onChange={(e) => setCourse(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") addCourse();
          }}
        />
      </div>

      <div style={styles.fypGridSection}>Milestones</div>
      {year.milestones.map((m, mi) => (
        <div key={mi} style={styles.fypGridCell}>
          <button
            style={styles.fypGridCheck}
            onClick={() => onToggleMilestone(index, mi)}
          >
            <span
              style={{
                ...styles.checkbox,
                borderColor: "#b8742a",
                background: m.done ? "#b8742a" : "transparent",
                color: m.done ? "#fff" : "transparent",
              }}
            >
              ✓
            </span>
            <span
              style={{
                textDecoration: m.done ? "line-through" : "none",
                color: m.done ? "var(--muted)" : "var(--assistant-text)",
              }}
            >
              {m.checkpoint && <span style={styles.fypGridFlag}>🚩</span>}
              {m.title}
            </span>
          </button>
          <div style={styles.fypGridMeta}>
            <button
              style={{
                ...styles.fypGridFlagBtn,
                ...(m.checkpoint ? styles.fypFlagBtnActive : {}),
              }}
              onClick={() => onToggleCheckpoint(index, mi)}
              title={m.checkpoint ? "Remove checkpoint" : "Mark as checkpoint"}
              aria-label="Toggle checkpoint"
            >
              🚩
            </button>
            <button
              style={styles.fypGridRemove}
              onClick={() => onRemoveMilestone(index, mi)}
              aria-label={`Remove ${m.title}`}
            >
              ×
            </button>
          </div>
        </div>
      ))}
      <div style={styles.fypGridAdd}>
        <input
          style={styles.fypGridInput}
          value={ms}
          placeholder="+ milestone"
          onChange={(e) => setMs(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") addMs();
          }}
        />
      </div>
    </div>
  );
}

// The whole roadmap as a horizontally-scrolling spreadsheet: one column per year.
function FourYearGrid({
  plan,
  onAddCourse,
  onRemoveCourse,
  onToggleCourse,
  onSetCourse,
  onAddMilestone,
  onRemoveMilestone,
  onToggleMilestone,
  onToggleCheckpoint,
}: {
  plan: FourYearPlan;
  onAddCourse: (i: number, title: string) => void;
  onRemoveCourse: (i: number, ci: number) => void;
  onToggleCourse: (i: number, ci: number) => void;
  onSetCourse: (i: number, ci: number, patch: Partial<FourYearCourse>) => void;
  onAddMilestone: (i: number, title: string) => void;
  onRemoveMilestone: (i: number, mi: number) => void;
  onToggleMilestone: (i: number, mi: number) => void;
  onToggleCheckpoint: (i: number, mi: number) => void;
}) {
  return (
    <div style={styles.fypGridScroll}>
      <div style={styles.fypGrid}>
        {plan.years.map((y, i) => (
          <FypGridColumn
            key={i}
            year={y}
            index={i}
            onAddCourse={onAddCourse}
            onRemoveCourse={onRemoveCourse}
            onToggleCourse={onToggleCourse}
            onSetCourse={onSetCourse}
            onAddMilestone={onAddMilestone}
            onRemoveMilestone={onRemoveMilestone}
            onToggleMilestone={onToggleMilestone}
            onToggleCheckpoint={onToggleCheckpoint}
          />
        ))}
      </div>
    </div>
  );
}

// Live credit tracker: how many credits earned (completed courses) vs. required
// to graduate, overall and per subject — plus an editor for the requirements so
// the learner never has to tally credits by hand.
function CreditTracker({
  plan,
  onSetRequirement,
  onAddRequirement,
  onRemoveRequirement,
  onSetTotalRequired,
  onSetGpaGoal,
  onSetProjectedGrade,
  onUseDefaultRequirements,
  onApplyGrades,
}: {
  plan: FourYearPlan;
  onSetRequirement: (i: number, required: number) => void;
  onAddRequirement: (subject: string, required: number) => void;
  onRemoveRequirement: (i: number) => void;
  onSetTotalRequired: (n: number | undefined) => void;
  onSetGpaGoal: (n: number | undefined) => void;
  onSetProjectedGrade: (grade: string) => void;
  onUseDefaultRequirements: () => void;
  onApplyGrades: (
    entries: {
      title: string;
      grade: string;
      credits?: number;
      level?: CourseLevel;
    }[],
  ) => { matched: number; added: number };
}) {
  const [editing, setEditing] = useState(false);
  const [gradeBusy, setGradeBusy] = useState(false);
  const [gradeMsg, setGradeMsg] = useState<string | null>(null);
  // Read an uploaded transcript / report card, ask the API to pull out the
  // graded courses, then fold them into the plan's GPA via onApplyGrades.
  async function onGradeFiles(files: FileList | null) {
    if (!files?.length || gradeBusy) return;
    setGradeBusy(true);
    setGradeMsg(null);
    const read = (file: File) =>
      new Promise<{ base64: string; mediaType: string; name: string }>(
        (resolve, reject) => {
          const r = new FileReader();
          r.onload = () => {
            const s = String(r.result);
            resolve({
              base64: s.slice(s.indexOf(",") + 1),
              mediaType: file.type || "text/plain",
              name: file.name,
            });
          };
          r.onerror = reject;
          r.readAsDataURL(file);
        },
      );
    try {
      const docs = await Promise.all(Array.from(files).slice(0, 4).map(read));
      const courseTitles = plan.years.flatMap((y) =>
        y.courses.map((c) => c.title),
      );
      const res = await fetch("/api/grades/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ docs, courseTitles }),
      });
      const data = (await res.json()) as {
        courses?: {
          title: string;
          grade: string;
          credits?: number;
          level?: CourseLevel;
        }[];
        error?: string;
      };
      if (!data.courses?.length) {
        setGradeMsg(
          data.error
            ? "Couldn't read those grades — try a clearer file."
            : "No graded courses found in that file.",
        );
        return;
      }
      const { matched, added } = onApplyGrades(data.courses);
      const parts = [
        `Found ${data.courses.length} grade${data.courses.length === 1 ? "" : "s"}`,
        matched ? `${matched} matched to your plan` : "",
        added ? `${added} added to Year 1` : "",
      ].filter(Boolean);
      setGradeMsg(`✓ ${parts.join(" · ")}.`);
    } catch {
      setGradeMsg("Couldn't read those grades — try again.");
    } finally {
      setGradeBusy(false);
    }
  }
  const [newSubject, setNewSubject] = useState("");
  const [newReq, setNewReq] = useState("");
  const {
    earned,
    planned,
    required,
    byCategory,
    gpa,
    weightedGpa,
    perYear,
    shortOverall,
    shortCats,
    onTrack,
    uncategorized,
  } = fypCredits(plan);
  const proj = fypProjection(plan);
  const left = required != null ? Math.max(0, required - earned) : null;
  const pct =
    required && required > 0
      ? Math.min(100, Math.round((earned / required) * 100))
      : 0;
  // Flag a year that's carrying a lot more credits than the others (ADHD pacing).
  const avgLoad =
    perYear.length > 0
      ? perYear.reduce((n, y) => n + y.planned, 0) / perYear.length
      : 0;
  const overloaded = perYear.filter(
    (y) => avgLoad > 0 && y.planned > avgLoad + 2 && y.planned >= 8,
  );
  return (
    <div style={styles.fypCredits}>
      <div style={styles.fypCreditsHead}>
        <span style={styles.fypCreditsTitle}>🎓 Credits toward graduation</span>
        <button style={styles.linkBtn} onClick={() => setEditing((e) => !e)}>
          {editing ? "Done" : "Edit requirements"}
        </button>
      </div>
      <div style={styles.fypCreditsBig}>
        <span style={styles.fypCreditsEarned}>{earned}</span>
        <span style={styles.fypCreditsOf}>
          {" "}
          / {required ?? planned} {required != null ? "required" : "planned"}
        </span>
      </div>
      {required != null && (
        <>
          <div style={styles.goalTrack}>
            <div style={{ ...styles.goalFill, width: `${pct}%` }} />
          </div>
          <div style={styles.fypProgressMeta}>
            {left} credit{left === 1 ? "" : "s"} to go · {planned} planned of{" "}
            {required} required
          </div>
          {/* Projection: does the plan as written reach graduation? */}
          {onTrack ? (
            <div style={{ ...styles.fypStatus, ...styles.fypStatusOk }}>
              ✓ On track — the plan meets every requirement.
            </div>
          ) : (
            <div style={{ ...styles.fypStatus, ...styles.fypStatusWarn }}>
              ⚠︎ Plan is short
              {shortOverall > 0
                ? ` ${shortOverall} credit${shortOverall === 1 ? "" : "s"} overall`
                : ""}
              {shortCats.length
                ? `${shortOverall > 0 ? " and" : " in"} ${shortCats
                    .map((c) => c.subject)
                    .join(", ")}`
                : ""}
              . Add more to graduate on time.
            </div>
          )}
        </>
      )}
      {(gpa != null || weightedGpa != null) && (
        <div style={styles.fypGpaRow}>
          <span style={styles.fypGpaItem}>
            <span style={styles.fypGpaNum}>{weightedGpa?.toFixed(2)}</span> GPA
            <span style={styles.fypGpaSub}> weighted</span>
          </span>
          <span style={styles.fypGpaItem}>
            <span style={styles.fypGpaNum}>{gpa?.toFixed(2)}</span> GPA
            <span style={styles.fypGpaSub}> unweighted</span>
          </span>
        </div>
      )}
      <label style={styles.fypGradeUpload}>
        <span style={styles.fypGradeUploadHead}>
          📄 Upload your grades
          <span style={styles.fypGradeUploadHint}>
            {" "}
            — transcript or report card (PDF, image, or text). Eliora reads the
            letter grades and drops them onto your courses to fill in your GPA.
          </span>
        </span>
        <input
          type="file"
          multiple
          accept=".pdf,.txt,.md,.csv,image/*,application/pdf"
          disabled={gradeBusy}
          style={styles.fypFileInput}
          onChange={(e) => {
            onGradeFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </label>
      {gradeBusy && (
        <div style={styles.mcHint}>Reading your grades…</div>
      )}
      {gradeMsg && !gradeBusy && (
        <div
          style={{
            ...styles.fypStatus,
            ...(gradeMsg.startsWith("✓") ? styles.fypStatusOk : {}),
          }}
        >
          {gradeMsg}
        </div>
      )}
      {proj.hasCourses && (
        <div style={styles.fypProjBox}>
          <div style={styles.fypProjHead}>
            <span style={styles.fypProjTitle}>📈 Projected GPA</span>
            <label style={styles.fypProjAssume}>
              assume
              <select
                style={styles.fypProjSelect}
                value={proj.assumed}
                onChange={(e) => onSetProjectedGrade(e.target.value)}
              >
                {GRADE_OPTIONS.map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
              </select>
              on the rest
            </label>
          </div>
          <div style={styles.fypGpaRow}>
            <span style={styles.fypGpaItem}>
              <span style={styles.fypGpaNum}>
                {proj.projectedWeightedGpa?.toFixed(2)}
              </span>{" "}
              proj.<span style={styles.fypGpaSub}> weighted</span>
            </span>
            <span style={styles.fypGpaItem}>
              <span style={styles.fypGpaNum}>
                {proj.projectedGpa?.toFixed(2)}
              </span>{" "}
              proj.<span style={styles.fypGpaSub}> unweighted</span>
            </span>
          </div>
          <label style={styles.fypProjGoalRow}>
            <span>🎯 Goal (weighted GPA)</span>
            <input
              type="number"
              min={0}
              max={5}
              step={0.1}
              style={styles.fypProjGoalInput}
              value={proj.goal ?? ""}
              placeholder="e.g. 3.5"
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                onSetGpaGoal(Number.isFinite(v) && v > 0 ? v : undefined);
              }}
            />
          </label>
          {proj.goal != null &&
            (proj.meetsGoal ? (
              <div style={{ ...styles.fypStatus, ...styles.fypStatusOk }}>
                ✓ On pace for a {proj.goal.toFixed(2)} weighted GPA (if you get{" "}
                {proj.assumed} on the rest).
              </div>
            ) : (
              <div style={{ ...styles.fypStatus, ...styles.fypStatusWarn }}>
                {proj.neededBase == null
                  ? `Below your ${proj.goal.toFixed(2)} goal — add graded courses to project.`
                  : proj.neededBase > 4.001
                    ? `A ${proj.goal.toFixed(2)} goal isn't reachable with the courses left — even straight A's fall short. Add rigor (Honors/AP) or adjust the goal.`
                    : `To reach ${proj.goal.toFixed(2)}, average about ${fypLetterFor(
                        proj.neededBase,
                      )} on your remaining ${proj.remainingCredits} credits.`}
              </div>
            ))}
        </div>
      )}
      {overloaded.length > 0 && (
        <div style={{ ...styles.fypStatus, ...styles.fypStatusWarn }}>
          ⚠︎ Heavy load in {overloaded.map((y) => y.label).join(", ")} — consider
          spreading courses out.
        </div>
      )}
      {byCategory.length > 0 && (
        <div style={styles.fypReqList}>
          <div style={styles.fypReqLegend}>earned ▸ planned / required</div>
          {byCategory.map((c, i) => {
            const short = c.planned < c.required;
            // Earned = solid progress; planned = lighter fill behind it. Both are
            // shown against the required total so earned and planned stay consistent.
            const ep =
              c.required > 0
                ? Math.min(100, Math.round((c.earned / c.required) * 100))
                : 0;
            const pp =
              c.required > 0
                ? Math.min(100, Math.round((c.planned / c.required) * 100))
                : 0;
            return (
              <div key={i} style={styles.fypReqRow}>
                <span style={styles.fypReqSubject}>{c.subject}</span>
                <div style={styles.fypReqBarTrack}>
                  <div
                    style={{
                      ...styles.fypReqBarFill,
                      position: "absolute",
                      width: `${pp}%`,
                      background: short ? "#e6b27a" : "var(--accent-soft)",
                    }}
                  />
                  <div
                    style={{
                      ...styles.fypReqBarFill,
                      position: "absolute",
                      width: `${ep}%`,
                      background: short ? "#c9781f" : "var(--accent)",
                    }}
                  />
                </div>
                {editing ? (
                  <>
                    <input
                      type="number"
                      min={0}
                      step={0.5}
                      style={styles.fypReqInput}
                      value={c.required}
                      onChange={(e) =>
                        onSetRequirement(i, Number(e.target.value) || 0)
                      }
                    />
                    <button
                      style={styles.folderRemove}
                      onClick={() => onRemoveRequirement(i)}
                      aria-label={`Remove ${c.subject}`}
                    >
                      ×
                    </button>
                  </>
                ) : (
                  <span
                    style={styles.fypReqCount}
                    title={`${c.earned} earned · ${c.planned} planned / ${c.required} required`}
                  >
                    {c.earned}▸{c.planned}/{c.required}
                    {short ? " ⚠︎" : " ✓"}
                  </span>
                )}
              </div>
            );
          })}
          {uncategorized > 0 && (
            <div style={styles.fypProgressMeta}>
              ⚠︎ {uncategorized} credit{uncategorized === 1 ? "" : "s"} aren&apos;t
              tagged with a subject above, so they don&apos;t count in these bars —
              set each course&apos;s category to fix the tally.
            </div>
          )}
        </div>
      )}
      {byCategory.length === 0 && (
        <div style={styles.fypProgressMeta}>
          No graduation requirements set yet —{" "}
          <button style={styles.linkBtn} onClick={onUseDefaultRequirements}>
            use typical US requirements
          </button>{" "}
          or add your school&apos;s own with &ldquo;Edit requirements&rdquo;.
        </div>
      )}
      {editing && (
        <>
          <div style={styles.fypAddRow}>
            <input
              style={styles.assignInput}
              value={newSubject}
              placeholder="Subject (e.g. Math)"
              onChange={(e) => setNewSubject(e.target.value)}
            />
            <input
              type="number"
              min={0}
              step={0.5}
              style={styles.fypReqInput}
              value={newReq}
              placeholder="Cr"
              onChange={(e) => setNewReq(e.target.value)}
            />
            <button
              style={styles.assignAddBtn}
              onClick={() => {
                const n = parseFloat(newReq);
                if (newSubject.trim() && isFinite(n)) {
                  onAddRequirement(newSubject, n);
                  setNewSubject("");
                  setNewReq("");
                }
              }}
            >
              Add
            </button>
          </div>
          <label style={{ ...styles.classSurveyLabel, marginTop: 8 }}>
            Total credits to graduate
            <input
              type="number"
              min={0}
              step={0.5}
              style={styles.assignInput}
              value={required ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                onSetTotalRequired(v === "" ? undefined : parseFloat(v) || 0);
              }}
            />
          </label>
        </>
      )}
    </div>
  );
}

// Multiple-choice options for the "Not sure what career?" survey. Multi-select
// groups (tap several) and single-select groups (tap one).
const CAREER_MC: Record<string, string[]> = {
  subjects: ["Math", "Science", "English / Writing", "History", "Art & Design", "Music", "PE / Sports", "Computers / Tech", "Business", "Hands-on / Shop"],
  strengths: ["Explaining things", "Building & fixing", "Drawing / design", "Numbers & logic", "Writing", "Organizing", "Talking to people", "Solving problems", "Creativity", "Leading a group"],
  interests: ["Gaming", "Sports", "Art & creating", "Helping people", "Technology", "Music", "Being outdoors", "Reading", "Making content", "Animals"],
  workStyle: ["With people", "On my own", "Hands-on", "With ideas", "Outdoors", "At a desk", "Moving around", "On a team"],
  values: ["Helping others", "Good pay", "Creativity", "Independence", "Stability", "Adventure", "Respect", "Work-life balance"],
  dislikes: ["Lots of writing", "Public speaking", "Sitting still", "Heavy math", "Indoors all day", "Memorizing", "Working alone", "Repetitive tasks"],
  environment: ["Office", "Outdoors", "Lab", "Hospital / clinic", "Workshop / garage", "From home", "School", "On the move"],
  curious: ["Space & science", "How things work", "Animals & nature", "Art & design", "Music", "People & minds", "Business & money", "Games & tech", "History"],
  impact: ["Help sick people", "Protect nature", "Build technology", "Teach others", "Fix & build things", "Create art / media", "Keep people safe", "Grow businesses"],
  admire: ["Healthcare workers", "Tech people", "Tradespeople", "Creatives / artists", "Business people", "Scientists", "Teachers", "Public service / safety"],
};
const CAREER_SINGLE: Record<string, string[]> = {
  structure: ["Steady routine", "Lots of variety", "A mix of both"],
  income: ["Very important", "Comfortable is enough", "Don't mind"],
  education: ["4-year college", "2-year / community", "Trade school", "Certificate / bootcamp", "Straight to work", "Not sure yet"],
};
// Post-survey: ways the learner can nudge the next round of career matches.
const REFINE_OPTIONS = ["More hands-on", "More creative", "More helping people", "More tech / computers", "More outdoors", "Higher pay", "Less school", "Something different"];

// Options for the end-of-semester reflection survey.
const REFLECT_FEEL = ["Great 🎉", "Good 🙂", "Mixed 😐", "Rough 😮‍💨"];
const REFLECT_WINS = ["Stayed organized", "Studied regularly", "Asked for help", "Managed my time", "Enjoyed my classes", "Balanced school & life"];
const REFLECT_HARD = ["Time management", "Staying motivated", "Hard material", "Focus / distractions", "Test anxiety", "Too much on my plate"];
const REFLECT_CHANGE = ["Start work earlier", "Ask for help sooner", "Better sleep & routine", "Join a study group", "Use the planner more", "Cut distractions"];

// End-of-semester reflection for one finished year: shows the saved reflection, or
// a short multiple-choice survey that generates one.
function SemesterReflection({
  index,
  year,
  gpa,
  saved,
  onReflect,
}: {
  index: number;
  year: FourYearYear;
  gpa?: number;
  saved?: { message: string; focus: string[] };
  onReflect: (
    yearIndex: number,
    answers: { feel: string; wins: string; hard: string; change: string; note: string },
  ) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [feel, setFeel] = useState("");
  const [wins, setWins] = useState<string[]>([]);
  const [hard, setHard] = useState<string[]>([]);
  const [change, setChange] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const toggle =
    (set: React.Dispatch<React.SetStateAction<string[]>>) => (v: string) =>
      set((p) => (p.includes(v) ? p.filter((x) => x !== v) : [...p, v]));
  const chips = (
    label: string,
    opts: string[],
    selected: string[],
    onToggle: (v: string) => void,
  ) => (
    <div style={styles.mcGroup}>
      <span style={styles.mcLabel}>{label}</span>
      <div style={styles.mcChips}>
        {opts.map((o) => {
          const on = selected.includes(o);
          return (
            <button
              key={o}
              type="button"
              aria-pressed={on}
              style={{ ...styles.mcChip, ...(on ? styles.mcChipOn : {}) }}
              onClick={() => onToggle(o)}
            >
              {o}
            </button>
          );
        })}
      </div>
    </div>
  );
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    await onReflect(index, {
      feel,
      wins: wins.join(", "),
      hard: hard.join(", "),
      change: change.join(", "),
      note: note.trim(),
    });
    setBusy(false);
    setOpen(false);
  };

  if (saved) {
    return (
      <div style={styles.reflSaved}>
        <div style={styles.reflSavedHead}>
          🪞 {year.label}
          {gpa != null && (
            <span style={styles.reflSavedGpa}> · GPA {gpa.toFixed(2)}</span>
          )}
        </div>
        <p style={styles.reflSavedMsg}>{saved.message}</p>
        {saved.focus.length > 0 && (
          <div style={styles.reflFocusList}>
            {saved.focus.map((f, i) => (
              <div key={i} style={styles.reflFocusItem}>
                🎯 {f}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }
  return (
    <div style={styles.reflBox}>
      {!open ? (
        <button style={styles.reflOpenBtn} onClick={() => setOpen(true)}>
          🪞 Reflect on {year.label}
        </button>
      ) : (
        <>
          <div style={styles.reflTitle}>
            🪞 {year.label} — how did it go?
            {gpa != null && (
              <span style={styles.reflSavedGpa}> · GPA {gpa.toFixed(2)}</span>
            )}
          </div>
          {chips("How did this year feel?", REFLECT_FEEL, feel ? [feel] : [], (v) =>
            setFeel((cur) => (cur === v ? "" : v)),
          )}
          {chips("What went well?", REFLECT_WINS, wins, toggle(setWins))}
          {chips("What was hardest?", REFLECT_HARD, hard, toggle(setHard))}
          {chips(
            "What do you want to do differently?",
            REFLECT_CHANGE,
            change,
            toggle(setChange),
          )}
          <textarea
            style={styles.fypTextarea}
            value={note}
            placeholder="Anything else about this year? (optional)"
            onChange={(e) => setNote(e.target.value)}
          />
          <div style={styles.classSurveyActions}>
            <button
              style={styles.classSurveyCancel}
              onClick={() => setOpen(false)}
            >
              Cancel
            </button>
            <button
              style={{
                ...styles.assignAddBtn,
                ...(busy ? { opacity: 0.6, cursor: "default" } : {}),
              }}
              disabled={busy}
              onClick={submit}
            >
              {busy ? "Reflecting…" : "🪞 Get my reflection"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// The 4-year academic roadmap. When empty, prompts the learner for a destination
// and lets Eliora draft it (or start blank). When set, shows the destination +
// overall progress and each year's courses & milestones, all editable.
function FourYearPlanPanel({
  plan,
  profile,
  generating,
  onGenerate,
  onSetDestination,
  onAddCourse,
  onRemoveCourse,
  onToggleCourse,
  onSetCourse,
  onAddMilestone,
  onRemoveMilestone,
  onToggleMilestone,
  onToggleCheckpoint,
  onAddToPlan,
  onResources,
  onAdvise,
  onSetRequirement,
  onAddRequirement,
  onRemoveRequirement,
  onSetTotalRequired,
  onSetGpaGoal,
  onSetProjectedGrade,
  onUseDefaultRequirements,
  onApplyGrades,
  planTitles,
  reflections,
  onReflect,
  reflectionSummary,
  onSummarizeReflections,
  summarizingReflections,
  onCreateGoalsFromReflections,
  creatingReflGoals,
  onClear,
}: {
  plan: FourYearPlan | null;
  profile: LearnerProfile | null;
  generating: boolean;
  onGenerate: (input: FypGenInput) => void;
  onSetDestination: (dest: string) => void;
  onAddCourse: (i: number, title: string) => void;
  onRemoveCourse: (i: number, ci: number) => void;
  onToggleCourse: (i: number, ci: number) => void;
  onSetCourse: (i: number, ci: number, patch: Partial<FourYearCourse>) => void;
  onAddMilestone: (i: number, title: string) => void;
  onRemoveMilestone: (i: number, mi: number) => void;
  onToggleMilestone: (i: number, mi: number) => void;
  onToggleCheckpoint: (i: number, mi: number) => void;
  onAddToPlan: (title: string) => void;
  onResources: (title: string) => void;
  onAdvise: () => void;
  onSetRequirement: (i: number, required: number) => void;
  onAddRequirement: (subject: string, required: number) => void;
  onRemoveRequirement: (i: number) => void;
  onSetTotalRequired: (n: number | undefined) => void;
  onSetGpaGoal: (n: number | undefined) => void;
  onSetProjectedGrade: (grade: string) => void;
  onUseDefaultRequirements: () => void;
  onApplyGrades: (
    entries: {
      title: string;
      grade: string;
      credits?: number;
      level?: CourseLevel;
    }[],
  ) => { matched: number; added: number };
  planTitles: Set<string>;
  reflections: Record<string, { message: string; focus: string[] }>;
  onReflect: (
    yearIndex: number,
    answers: { feel: string; wins: string; hard: string; change: string; note: string },
  ) => Promise<void>;
  reflectionSummary: { message: string; focus: string[] } | null;
  onSummarizeReflections: () => void;
  summarizingReflections: boolean;
  onCreateGoalsFromReflections: () => void;
  creatingReflGoals: boolean;
  onClear: () => void;
}) {
  const [destInput, setDestInput] = useState("");
  const [classesInput, setClassesInput] = useState(
    profile?.subjectsStudying?.trim() || profile?.klass?.trim() || "",
  );
  const [gradeInput, setGradeInput] = useState(profile?.gradeYear?.trim() || "");
  const [strengthsInput, setStrengthsInput] = useState("");
  const [interestsInput, setInterestsInput] = useState(
    profile?.interests?.trim() || profile?.hobbies?.trim() || "",
  );
  const [afterInput, setAfterInput] = useState("");
  const [notesInput, setNotesInput] = useState("");
  const [reqInput, setReqInput] = useState("");
  const [catalogInput, setCatalogInput] = useState("");
  const [docs, setDocs] = useState<
    { base64: string; mediaType: string; name: string }[]
  >([]);
  const [editingDest, setEditingDest] = useState(false);
  const [destEdit, setDestEdit] = useState("");
  // Spreadsheet grid vs. detailed cards for the populated roadmap.
  const [fypView, setFypView] = useState<"grid" | "cards">("grid");

  // "Not sure what career?" survey — multiple-choice, suggests careers from who
  // they are. Multi-select answers are string[]; single-select are string.
  const [showCareerSurvey, setShowCareerSurvey] = useState(false);
  const [csSubjects, setCsSubjects] = useState<string[]>([]);
  const [csStrengths, setCsStrengths] = useState<string[]>([]);
  const [csInterests, setCsInterests] = useState<string[]>([]);
  const [csWorkStyle, setCsWorkStyle] = useState<string[]>([]);
  const [csValues, setCsValues] = useState<string[]>([]);
  const [csDislikes, setCsDislikes] = useState<string[]>([]);
  const [csEnvironment, setCsEnvironment] = useState<string[]>([]);
  const [csCurious, setCsCurious] = useState<string[]>([]);
  const [csImpact, setCsImpact] = useState<string[]>([]);
  const [csAdmire, setCsAdmire] = useState<string[]>([]);
  const [csStructure, setCsStructure] = useState(""); // single
  const [csIncome, setCsIncome] = useState(""); // single
  const [csEducation, setCsEducation] = useState(""); // single
  const [careerIdeas, setCareerIdeas] = useState<
    { title: string; why?: string; path?: string }[] | null
  >(null);
  const [loadingCareers, setLoadingCareers] = useState(false);
  // Post-survey (2nd round): which suggestions they liked + what to lean toward.
  const [csLiked, setCsLiked] = useState<string[]>([]);
  const [csRefine, setCsRefine] = useState<string[]>([]);
  // Toggle a value in a multi-select answer array.
  const toggleMc = (set: React.Dispatch<React.SetStateAction<string[]>>) => (v: string) =>
    set((prev) => (prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v]));
  // Fetch career ideas. Pass refine=true for the post-survey second round.
  async function fetchCareers(refine = false) {
    if (loadingCareers) return;
    const previous = refine && careerIdeas ? careerIdeas.map((c) => c.title) : [];
    setLoadingCareers(true);
    setCareerIdeas(null);
    try {
      const res = await fetch("/api/career-suggestions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subjects: csSubjects.join(", "),
          strengths: csStrengths.join(", "),
          interests: csInterests.join(", "),
          workStyle: csWorkStyle.join(", "),
          values: csValues.join(", "),
          education: csEducation.trim(),
          dislikes: csDislikes.join(", "),
          environment: csEnvironment.join(", "),
          curious: csCurious.join(", "),
          impact: csImpact.join(", "),
          structure: csStructure.trim(),
          admire: csAdmire.join(", "),
          income: csIncome.trim(),
          liked: refine ? csLiked.join(", ") : "",
          refine: refine ? csRefine.join(", ") : "",
          previous,
          profile: profile ?? undefined,
        }),
      });
      const data = (await res.json()) as {
        suggestions?: { title: string; why?: string; path?: string }[];
      };
      if (data.suggestions?.length) {
        setCareerIdeas(data.suggestions);
        setCsLiked([]); // clear likes for the new round
      }
    } catch {
      /* ignore — button can be tapped again */
    } finally {
      setLoadingCareers(false);
    }
  }
  // Render a multiple-choice question — multi-select (tap several) or single.
  const mcMulti = (
    label: string,
    opts: string[],
    selected: string[],
    onToggle: (v: string) => void,
  ) => (
    <div style={styles.mcGroup}>
      <span style={styles.mcLabel}>{label}</span>
      <div style={styles.mcChips}>
        {opts.map((o) => {
          const on = selected.includes(o);
          return (
            <button
              key={o}
              type="button"
              aria-pressed={on}
              style={{ ...styles.mcChip, ...(on ? styles.mcChipOn : {}) }}
              onClick={() => onToggle(o)}
            >
              {o}
            </button>
          );
        })}
      </div>
    </div>
  );
  const mcSingle = (
    label: string,
    opts: string[],
    value: string,
    onSet: (v: string) => void,
  ) => (
    <div style={styles.mcGroup}>
      <span style={styles.mcLabel}>{label}</span>
      <div style={styles.mcChips}>
        {opts.map((o) => {
          const on = value === o;
          return (
            <button
              key={o}
              type="button"
              aria-pressed={on}
              style={{ ...styles.mcChip, ...(on ? styles.mcChipOn : {}) }}
              onClick={() => onSet(on ? "" : o)}
            >
              {o}
            </button>
          );
        })}
      </div>
    </div>
  );

  // Read uploaded school docs (PDF / image / text) into base64 for the API.
  async function onDocFiles(files: FileList | null) {
    if (!files?.length) return;
    const read = (file: File) =>
      new Promise<{ base64: string; mediaType: string; name: string }>(
        (resolve, reject) => {
          const r = new FileReader();
          r.onload = () => {
            const s = String(r.result);
            resolve({
              base64: s.slice(s.indexOf(",") + 1),
              mediaType: file.type || "text/plain",
              name: file.name,
            });
          };
          r.onerror = reject;
          r.readAsDataURL(file);
        },
      );
    try {
      const loaded = await Promise.all(Array.from(files).slice(0, 4).map(read));
      setDocs((prev) => [...prev, ...loaded].slice(0, 4));
    } catch {
      /* ignore unreadable files */
    }
  }
  // "What to join" suggestions (clubs/teams/orgs) — fetched on demand.
  const [joins, setJoins] = useState<
    { title: string; why?: string; yearIndex: number }[] | null
  >(null);
  const [loadingJoins, setLoadingJoins] = useState(false);
  const [addedJoins, setAddedJoins] = useState<Set<string>>(new Set());
  async function fetchJoins() {
    if (loadingJoins || !plan) return;
    setLoadingJoins(true);
    try {
      const existing = plan.years.flatMap((y) =>
        y.milestones.map((m) => m.title),
      );
      const res = await fetch("/api/join-suggestions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          career: plan.destination,
          grade: plan.years[0]?.label,
          existing,
          profile: profile ?? undefined,
        }),
      });
      const data = (await res.json()) as {
        suggestions?: { title: string; why?: string; yearIndex: number }[];
      };
      if (data.suggestions?.length) setJoins(data.suggestions);
    } catch {
      /* ignore — button can be tapped again */
    } finally {
      setLoadingJoins(false);
    }
  }
  // "How your interests align with your ultimate goal" — fetched on demand.
  const [alignInterests, setAlignInterests] = useState(
    profile?.interests?.trim() || profile?.hobbies?.trim() || "",
  );
  const [alignment, setAlignment] = useState<{
    alignments: { interest: string; connection: string }[];
    overall?: string;
  } | null>(null);
  const [loadingAlign, setLoadingAlign] = useState(false);
  async function fetchAlignment() {
    if (loadingAlign || !plan || !alignInterests.trim()) return;
    setLoadingAlign(true);
    try {
      const res = await fetch("/api/interest-alignment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          goal: plan.destination,
          interests: alignInterests.trim(),
          profile: profile ?? undefined,
        }),
      });
      const data = (await res.json()) as {
        alignments?: { interest: string; connection: string }[];
        overall?: string;
      };
      if (data.alignments?.length)
        setAlignment({ alignments: data.alignments, overall: data.overall });
    } catch {
      /* ignore — button can be tapped again */
    } finally {
      setLoadingAlign(false);
    }
  }

  if (!plan) {
    const canBuild = destInput.trim().length > 0 && !generating;
    const survey = (): FypGenInput => ({
      career: destInput.trim(),
      grade: gradeInput.trim(),
      classes: classesInput.trim(),
      strengths: strengthsInput.trim(),
      interests: interestsInput.trim(),
      afterPlan: afterInput.trim(),
      notes: notesInput.trim(),
      requirements: reqInput.trim(),
      catalog: catalogInput.trim(),
      docs: docs.length ? docs : undefined,
    });
    const build = () => onGenerate({ ...survey(), advise: true });
    const field = (
      label: string,
      value: string,
      set: (s: string) => void,
      placeholder: string,
      submitOnEnter = true,
    ) => (
      <label style={styles.classSurveyLabel}>
        {label}
        <input
          style={styles.assignInput}
          value={value}
          placeholder={placeholder}
          onChange={(e) => set(e.target.value)}
          onKeyDown={(e) => {
            if (submitOnEnter && e.key === "Enter" && canBuild) build();
          }}
        />
      </label>
    );
    return (
      <div style={styles.card}>
        <div style={styles.cardHead}>
          <span style={styles.cardClass}>🗺️ 4-Year Plan</span>
        </div>
        <p style={{ color: "var(--muted)", margin: "8px 0 14px" }}>
          A few quick questions and Eliora will draft a year-by-year roadmap that
          builds toward your career — then tell you what to do next. Only the
          career is required.
        </p>
        {field(
          "1. What career are you working toward? *",
          destInput,
          setDestInput,
          "e.g. Software engineer, Nurse, Architect",
        )}
        {field(
          "2. What classes are you taking now (or want to)?",
          classesInput,
          setClassesInput,
          "e.g. Algebra 1, Biology, Intro to CS",
        )}
        {field(
          "3. What grade / year are you starting from?",
          gradeInput,
          setGradeInput,
          "e.g. Freshman (Grade 9), Year 1",
          false,
        )}
        {field(
          "4. What are your favorite subjects or strengths?",
          strengthsInput,
          setStrengthsInput,
          "e.g. Math, hands-on projects, writing",
        )}
        {field(
          "5. What are your interests, clubs & activities?",
          interestsInput,
          setInterestsInput,
          "e.g. Robotics club, soccer, video games",
        )}
        {field(
          "6. After high school — college & major, trade, or work?",
          afterInput,
          setAfterInput,
          "e.g. Study nursing at a state university",
        )}
        {field(
          "7. Anything else Eliora should consider?",
          notesInput,
          setNotesInput,
          "e.g. I work part-time, or a target school",
          false,
        )}
        <label style={styles.classSurveyLabel}>
          8. Paste your school&apos;s graduation credit requirements{" "}
          <span style={{ color: "var(--muted)", fontWeight: 400 }}>
            (optional — so you don&apos;t have to plan credits by hand)
          </span>
          <textarea
            style={styles.fypTextarea}
            value={reqInput}
            placeholder={
              "e.g. English 4 credits, Math 3, Science 3, Social Studies 3,\nWorld Language 2, PE/Health 1, Arts 1, Electives 7 — 24 total"
            }
            onChange={(e) => setReqInput(e.target.value)}
          />
        </label>
        <label style={styles.classSurveyLabel}>
          9. Paste your school&apos;s course catalog{" "}
          <span style={{ color: "var(--muted)", fontWeight: 400 }}>
            (optional — Eliora picks real courses from it)
          </span>
          <textarea
            style={styles.fypTextarea}
            value={catalogInput}
            placeholder="Paste the list of courses your school offers (with credits if listed)…"
            onChange={(e) => setCatalogInput(e.target.value)}
          />
        </label>
        <label style={styles.classSurveyLabel}>
          Or upload your school docs{" "}
          <span style={{ color: "var(--muted)", fontWeight: 400 }}>
            (catalog, requirements, or transcript — PDF, image, or text)
          </span>
          <input
            type="file"
            multiple
            accept=".pdf,.txt,.md,.csv,image/*,application/pdf"
            style={styles.fypFileInput}
            onChange={(e) => onDocFiles(e.target.files)}
          />
        </label>
        {docs.length > 0 && (
          <div style={styles.fypDocList}>
            {docs.map((d, i) => (
              <span key={i} style={styles.fypDocChip}>
                📄 {d.name}
                <button
                  style={styles.fypDocRemove}
                  onClick={() =>
                    setDocs((prev) => prev.filter((_, x) => x !== i))
                  }
                  aria-label={`Remove ${d.name}`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <button
          style={{
            ...styles.studyToolBtn,
            width: "100%",
            marginTop: 12,
            ...(canBuild ? {} : { opacity: 0.5, cursor: "default" }),
          }}
          disabled={!canBuild}
          onClick={build}
        >
          {generating
            ? "Building your roadmap…"
            : "🗺️ Build my 4-year plan & advise me"}
        </button>
        <button
          style={{ ...styles.goalNewBtn, marginTop: 10 }}
          disabled={generating}
          onClick={() =>
            onGenerate({
              career: destInput.trim(),
              grade: gradeInput.trim(),
              blank: true,
            })
          }
        >
          ＋ Start a blank roadmap instead
        </button>

        <div style={styles.careerHelpBox}>
          {!showCareerSurvey ? (
            <>
              <span style={styles.careerHelpTitle}>
                🤔 Not sure what career you want?
              </span>
              <p style={styles.careerHelpText}>
                Take a quick personality quiz — tap what sounds like you and
                Eliora will match you to careers, then you can pick one to build
                your plan.
              </p>
              <button
                style={styles.careerHelpBtn}
                onClick={() => setShowCareerSurvey(true)}
              >
                🧭 Take the career quiz
              </button>
            </>
          ) : (
            <>
              <span style={styles.careerHelpTitle}>
                🧭 Career personality quiz
              </span>
              <p style={styles.mcHint}>
                No wrong answers — just tap whatever feels like you. Pick as many
                as you want.
              </p>
              {mcMulti("📚 Which class would you happily sit through?", CAREER_MC.subjects, csSubjects, toggleMc(setCsSubjects))}
              {mcMulti("💪 In a group project, you're the one who…", CAREER_MC.strengths, csStrengths, toggleMc(setCsStrengths))}
              {mcMulti("🎮 A free afternoon — you'd rather…", CAREER_MC.interests, csInterests, toggleMc(setCsInterests))}
              {mcMulti("🧭 Your ideal way to work is…", CAREER_MC.workStyle, csWorkStyle, toggleMc(setCsWorkStyle))}
              {mcMulti("✨ A job is worth it if it gives you…", CAREER_MC.values, csValues, toggleMc(setCsValues))}
              {mcMulti("😩 What drains you the fastest?", CAREER_MC.dislikes, csDislikes, toggleMc(setCsDislikes))}
              {mcMulti("🏙️ Where do you see yourself most days?", CAREER_MC.environment, csEnvironment, toggleMc(setCsEnvironment))}
              {mcMulti("🤯 You could fall down a rabbit hole about…", CAREER_MC.curious, csCurious, toggleMc(setCsCurious))}
              {mcMulti("🌍 The kind of difference you want to make…", CAREER_MC.impact, csImpact, toggleMc(setCsImpact))}
              {mcMulti("🌟 Whose work makes you go 'that's so cool'?", CAREER_MC.admire, csAdmire, toggleMc(setCsAdmire))}
              {mcSingle("🔁 Routine or variety?", CAREER_SINGLE.structure, csStructure, setCsStructure)}
              {mcSingle("💰 How much does a big paycheck matter?", CAREER_SINGLE.income, csIncome, setCsIncome)}
              {mcSingle("🎓 How much more school sounds right?", CAREER_SINGLE.education, csEducation, setCsEducation)}
              <div style={styles.classSurveyActions}>
                <button
                  style={styles.classSurveyCancel}
                  onClick={() => setShowCareerSurvey(false)}
                >
                  Close
                </button>
                <button
                  style={{
                    ...styles.assignAddBtn,
                    ...(loadingCareers ? { opacity: 0.6, cursor: "default" } : {}),
                  }}
                  disabled={loadingCareers}
                  onClick={() => fetchCareers(false)}
                >
                  {loadingCareers ? "Finding your matches…" : "✨ See my matches"}
                </button>
              </div>
              {careerIdeas && careerIdeas.length > 0 && (
                <>
                  <div style={styles.careerIdeaList}>
                    <span style={styles.careerIdeaHint}>
                      ✨ Your top matches — tap one to make it your career goal:
                    </span>
                    {careerIdeas.map((c, i) => (
                      <button
                        key={i}
                        style={styles.careerIdeaCard}
                        onClick={() => {
                          setDestInput(c.title);
                          setShowCareerSurvey(false);
                          setCareerIdeas(null);
                        }}
                        title={`Use "${c.title}" as your career goal`}
                      >
                        <span style={styles.careerIdeaTitle}>🎯 {c.title}</span>
                        {c.why && (
                          <span style={styles.careerIdeaWhy}>{c.why}</span>
                        )}
                        {c.path && (
                          <span style={styles.careerIdeaPath}>📚 {c.path}</span>
                        )}
                      </button>
                    ))}
                  </div>
                  {/* Post-survey: refine the matches for a second round. */}
                  <div style={styles.postSurveyBox}>
                    <span style={styles.postSurveyTitle}>
                      💬 Not quite right? Let's refine
                    </span>
                    {mcMulti(
                      "Which of these felt most like you?",
                      careerIdeas.map((c) => c.title),
                      csLiked,
                      toggleMc(setCsLiked),
                    )}
                    {mcMulti(
                      "Want the next round to lean…",
                      REFINE_OPTIONS,
                      csRefine,
                      toggleMc(setCsRefine),
                    )}
                    <button
                      style={{
                        ...styles.careerHelpBtn,
                        marginTop: 4,
                        ...(loadingCareers
                          ? { opacity: 0.6, cursor: "default" }
                          : {}),
                      }}
                      disabled={loadingCareers}
                      onClick={() => fetchCareers(true)}
                    >
                      {loadingCareers ? "Rethinking…" : "🔁 Refine my matches"}
                    </button>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    );
  }

  const total = plan.years.reduce((n, y) => n + y.courses.length, 0);
  const done = plan.years.reduce(
    (n, y) => n + y.courses.filter((c) => c.done).length,
    0,
  );
  const pct = total ? Math.round((done / total) * 100) : 0;

  return (
    <div style={styles.card}>
      <div style={styles.cardHead}>
        <span style={styles.cardClass}>🗺️ 4-Year Plan</span>
        <button
          style={styles.linkBtn}
          disabled={generating}
          onClick={() => onGenerate({ career: plan.destination })}
          title="Have Eliora rebuild the roadmap toward this career"
        >
          {generating ? "Rebuilding…" : "↻ Rebuild"}
        </button>
      </div>

      <div style={styles.fypDestRow}>
        <span style={styles.fypDestLabel}>🎯 Headed toward</span>
        {editingDest ? (
          <div style={{ ...styles.fypAddRow, flex: 1, marginTop: 0 }}>
            <input
              style={styles.assignInput}
              autoFocus
              value={destEdit}
              onChange={(e) => setDestEdit(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  onSetDestination(destEdit.trim());
                  setEditingDest(false);
                }
              }}
            />
            <button
              style={styles.assignAddBtn}
              onClick={() => {
                onSetDestination(destEdit.trim());
                setEditingDest(false);
              }}
            >
              Save
            </button>
          </div>
        ) : (
          <button
            style={styles.fypDest}
            onClick={() => {
              setDestEdit(plan.destination);
              setEditingDest(true);
            }}
            title="Edit destination"
          >
            {plan.destination || "Set your destination"} ✎
          </button>
        )}
      </div>

      <div style={styles.goalTrack}>
        <div style={{ ...styles.goalFill, width: `${pct}%` }} />
      </div>
      <div style={styles.fypProgressMeta}>
        {done}/{total} courses complete
      </div>

      <button style={styles.fypAdviseBtn} onClick={onAdvise}>
        🧭 What should I do next?
      </button>

      <CreditTracker
        plan={plan}
        onSetRequirement={onSetRequirement}
        onAddRequirement={onAddRequirement}
        onRemoveRequirement={onRemoveRequirement}
        onSetTotalRequired={onSetTotalRequired}
        onSetGpaGoal={onSetGpaGoal}
        onSetProjectedGrade={onSetProjectedGrade}
        onUseDefaultRequirements={onUseDefaultRequirements}
        onApplyGrades={onApplyGrades}
      />

      <div style={styles.fypJoins}>
        <div style={styles.fypJoinsHead}>
          <span style={styles.fypCreditsTitle}>🤝 What to join</span>
          <button
            style={styles.linkBtn}
            disabled={loadingJoins}
            onClick={fetchJoins}
          >
            {loadingJoins
              ? "Finding…"
              : joins
                ? "↻ Refresh"
                : "Suggest clubs & activities"}
          </button>
        </div>
        <p style={styles.fypJoinsSub}>
          Clubs, teams & activities that build toward {plan.destination || "your career"}.
        </p>
        {joins?.map((s, i) => {
          const yr = plan.years[s.yearIndex];
          const added = addedJoins.has(s.title);
          return (
            <div key={i} style={styles.fypJoinRow}>
              <div style={{ flex: 1 }}>
                <div style={styles.fypJoinTitle}>{s.title}</div>
                {s.why && <div style={styles.assignMeta}>{s.why}</div>}
                {yr && (
                  <div style={styles.fypJoinYear}>Best in {yr.label}</div>
                )}
              </div>
              {added ? (
                <span style={styles.fypInPlan}>✓ Added</span>
              ) : (
                <button
                  style={styles.fypAddPlan}
                  onClick={() => {
                    onAddMilestone(s.yearIndex, s.title);
                    setAddedJoins((p) => new Set(p).add(s.title));
                  }}
                  title="Add to that year's milestones"
                >
                  ＋ Add
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div style={styles.fypAlignBox}>
        <div style={styles.fypJoinsHead}>
          <span style={styles.fypCreditsTitle}>
            🧭 Your interests ↔ {plan.destination || "your goal"}
          </span>
          <button
            style={styles.linkBtn}
            disabled={loadingAlign || !alignInterests.trim()}
            onClick={fetchAlignment}
          >
            {loadingAlign
              ? "Connecting…"
              : alignment
                ? "↻ Refresh"
                : "See how they align"}
          </button>
        </div>
        <p style={styles.fypJoinsSub}>
          See how what you love connects to your ultimate goal.
        </p>
        <input
          style={styles.assignInput}
          value={alignInterests}
          placeholder="Your interests (e.g. gaming, art, helping people)"
          onChange={(e) => setAlignInterests(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") fetchAlignment();
          }}
        />
        {alignment && (
          <div style={styles.fypAlignList}>
            {alignment.overall && (
              <p style={styles.fypAlignOverall}>{alignment.overall}</p>
            )}
            {alignment.alignments.map((a, i) => (
              <div key={i} style={styles.fypAlignRow}>
                <span style={styles.fypAlignInterest}>💜 {a.interest}</span>
                <span style={styles.fypAlignArrow}>→ {a.connection}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={styles.fypViewToggle}>
        <button
          style={{
            ...styles.fypViewBtn,
            ...(fypView === "grid" ? styles.fypViewBtnOn : {}),
          }}
          aria-pressed={fypView === "grid"}
          onClick={() => setFypView("grid")}
        >
          📊 Spreadsheet
        </button>
        <button
          style={{
            ...styles.fypViewBtn,
            ...(fypView === "cards" ? styles.fypViewBtnOn : {}),
          }}
          aria-pressed={fypView === "cards"}
          onClick={() => setFypView("cards")}
        >
          📋 Cards
        </button>
      </div>

      {fypView === "grid" ? (
        <FourYearGrid
          plan={plan}
          onAddCourse={onAddCourse}
          onRemoveCourse={onRemoveCourse}
          onToggleCourse={onToggleCourse}
          onSetCourse={onSetCourse}
          onAddMilestone={onAddMilestone}
          onRemoveMilestone={onRemoveMilestone}
          onToggleMilestone={onToggleMilestone}
          onToggleCheckpoint={onToggleCheckpoint}
        />
      ) : (
        plan.years.map((y, i) => (
          <FourYearYearCard
            key={i}
            year={y}
            index={i}
            onAddCourse={onAddCourse}
            onRemoveCourse={onRemoveCourse}
            onToggleCourse={onToggleCourse}
            onSetCourse={onSetCourse}
            onAddMilestone={onAddMilestone}
            onRemoveMilestone={onRemoveMilestone}
            onToggleMilestone={onToggleMilestone}
            onToggleCheckpoint={onToggleCheckpoint}
            onAddToPlan={onAddToPlan}
            onResources={onResources}
            planTitles={planTitles}
          />
        ))
      )}

      {plan.years.some(
        (y) => y.courses.length > 0 && y.courses.every((c) => c.done),
      ) && (
        <div style={styles.reflSection}>
          <div style={styles.fypCreditsTitle}>🪞 Semester reflections</div>
          <p style={styles.fypJoinsSub}>
            Finished a year? Reflect on how it went and set your focus for next
            semester.
          </p>

          {Object.keys(reflections).length >= 2 && (
            <div style={styles.reflSummaryBox}>
              <div style={styles.reflSummaryHead}>
                <span style={styles.reflSavedHead}>📖 Your journey so far</span>
                <button
                  style={styles.linkBtn}
                  disabled={summarizingReflections}
                  onClick={onSummarizeReflections}
                >
                  {summarizingReflections
                    ? "Summarizing…"
                    : reflectionSummary
                      ? "↻ Refresh"
                      : "Summarize my reflections"}
                </button>
              </div>
              {reflectionSummary && (
                <>
                  <p style={styles.reflSavedMsg}>{reflectionSummary.message}</p>
                  {reflectionSummary.focus.length > 0 && (
                    <div style={styles.reflFocusList}>
                      {reflectionSummary.focus.map((f, i) => (
                        <div key={i} style={styles.reflFocusItem}>
                          🎯 {f}
                        </div>
                      ))}
                    </div>
                  )}
                  <button
                    style={{
                      ...styles.reflOpenBtn,
                      marginTop: 12,
                      ...(creatingReflGoals
                        ? { opacity: 0.6, cursor: "default" }
                        : {}),
                    }}
                    disabled={creatingReflGoals}
                    onClick={onCreateGoalsFromReflections}
                  >
                    {creatingReflGoals
                      ? "Creating goals…"
                      : "🎯 Create goals from this"}
                  </button>
                </>
              )}
            </div>
          )}

          {plan.years.map((y, i) =>
            y.courses.length > 0 && y.courses.every((c) => c.done) ? (
              <SemesterReflection
                key={i}
                index={i}
                year={y}
                gpa={fypYearGpa(y)}
                saved={reflections[y.label]}
                onReflect={onReflect}
              />
            ) : null,
          )}
        </div>
      )}

      <button
        style={{
          ...styles.goalNewBtn,
          marginTop: 16,
          borderColor: "var(--border)",
          color: "var(--muted)",
        }}
        onClick={onClear}
      >
        Clear 4-year plan
      </button>
    </div>
  );
}

// Multiple-choice options for the study plan survey. `value` is stored on the
// answer string and forwarded to /api/study-plan, which weaves it into the plan
// prompt — so the labels read as plain phrases the model can use directly.
const PLAN_FOCUS_OPTIONS = [
  "Understanding new concepts",
  "Homework / practice problems",
  "Memorizing facts or terms",
  "Reviewing for a test",
  "Catching up on missed material",
] as const;
const PLAN_GOAL_OPTIONS = [
  "Ace an upcoming test or quiz",
  "Finish an assignment or project",
  "Understand the material better",
  "Raise my grade",
  "Get ahead / review early",
] as const;
const PLAN_DEADLINE_OPTIONS = [
  "In a few days",
  "Within 2 weeks",
  "This month",
  "No set deadline",
] as const;
const PLAN_STYLE_OPTIONS = [
  "Watching videos",
  "Practice problems",
  "Flashcards / quizzing",
  "Reading & notes",
  "Explaining it out loud",
] as const;
const PLAN_TIME_OPTIONS = [
  "15–30 min a day",
  "About an hour a day",
  "A few times a week",
  "Mostly weekends",
] as const;

// A guided survey that builds the study plan (milestones) from a few answers.
function StudyPlanSurvey({
  profile,
  generating,
  onBuild,
  onCancel,
}: {
  profile: LearnerProfile | null;
  generating: boolean;
  onBuild: (a: {
    subject: string;
    working: string;
    goal: string;
    deadline: string;
    learningStyle: string;
    time: string;
  }) => void;
  onCancel: () => void;
}) {
  const [subject, setSubject] = useState(profile?.klass?.trim() || "");
  const [working, setWorking] = useState("");
  const [goal, setGoal] = useState("");
  const [deadline, setDeadline] = useState("");
  const [learningStyle, setStyle] = useState(
    profile?.learningStyle?.trim() || "",
  );
  const [time, setTime] = useState("");
  const canBuild = subject.trim().length > 0 && !generating;
  const build = () =>
    onBuild({ subject, working, goal, deadline, learningStyle, time });
  // Free-text field — only the class/subject name, which is an open identifier.
  const field = (
    label: string,
    value: string,
    set: (s: string) => void,
    placeholder: string,
  ) => (
    <label style={styles.classSurveyLabel}>
      {label}
      <input
        style={styles.assignInput}
        value={value}
        placeholder={placeholder}
        onChange={(e) => set(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && canBuild) build();
        }}
      />
    </label>
  );
  // Multiple-choice field — a row of single-select toggle buttons. Clicking the
  // active option again clears it, so every choice stays optional.
  const choice = (
    label: string,
    value: string,
    set: (s: string) => void,
    options: readonly string[],
  ) => (
    <span style={styles.classSurveyLabel}>
      {label}
      <div style={styles.horizonRow}>
        {options.map((o) => (
          <button
            key={o}
            type="button"
            onClick={() => set(value === o ? "" : o)}
            style={{
              ...styles.horizonBtn,
              ...(value === o ? styles.horizonBtnActive : {}),
            }}
          >
            {o}
          </button>
        ))}
      </div>
    </span>
  );
  return (
    <div style={styles.card}>
      <div style={styles.cardHead}>
        <span style={styles.cardClass}>📝 Build a study plan</span>
      </div>
      <p style={{ color: "var(--muted)", margin: "4px 0 8px", fontSize: 13 }}>
        A few quick questions and Eliora will make you a step-by-step plan.
      </p>
      {field(
        "1. Which class or subject? *",
        subject,
        setSubject,
        "e.g. AP Biology, Algebra 2",
      )}
      {choice(
        "2. What do you want to focus on?",
        working,
        setWorking,
        PLAN_FOCUS_OPTIONS,
      )}
      {choice(
        "3. What do you want to accomplish?",
        goal,
        setGoal,
        PLAN_GOAL_OPTIONS,
      )}
      {choice("4. By when?", deadline, setDeadline, PLAN_DEADLINE_OPTIONS)}
      {choice(
        "5. How do you like to learn?",
        learningStyle,
        setStyle,
        PLAN_STYLE_OPTIONS,
      )}
      {choice(
        "6. How much time can you give it?",
        time,
        setTime,
        PLAN_TIME_OPTIONS,
      )}
      <div style={styles.classSurveyActions}>
        <button style={styles.classSurveyCancel} onClick={onCancel}>
          Cancel
        </button>
        <button
          style={{
            ...styles.assignAddBtn,
            ...(canBuild ? {} : { opacity: 0.5, cursor: "default" }),
          }}
          disabled={!canBuild}
          onClick={build}
        >
          {generating ? "Building…" : "📝 Build my plan"}
        </button>
      </div>
    </div>
  );
}

// Pre-survey (diagnostic) options — gauge where the learner is starting so
// Eliora can set the plan's starting difficulty. `value` is what the learner
// picks; `hint` is a one-line cue shown under the button.
const CLASS_LEVELS = [
  { value: "Brand new", hint: "just starting" },
  { value: "Some basics", hint: "seen a bit" },
  { value: "Fairly comfortable", hint: "mostly follow" },
  { value: "Pretty strong", hint: "want a stretch" },
] as const;
const CLASS_CONFIDENCE = ["Not confident", "A little", "Somewhat", "Very"] as const;

// A short survey to add ANOTHER class the learner needs help with. Opens with a
// quick diagnostic pre-survey (current level + confidence) so Eliora can tailor
// the plan's starting difficulty. On submit, Eliora extends the plan for it.
function ClassSurvey({
  onSubmit,
  onCancel,
}: {
  onSubmit: (d: {
    klass: string;
    struggles: string;
    goal: string;
    level: string;
    confidence: string;
  }) => void;
  onCancel: () => void;
}) {
  const [klass, setKlass] = useState("");
  const [struggles, setStruggles] = useState("");
  const [goal, setGoal] = useState("");
  const [level, setLevel] = useState("");
  const [confidence, setConfidence] = useState("");
  const canSubmit = klass.trim().length > 0;
  return (
    <div style={styles.card}>
      <div style={styles.cardHead}>
        <span style={styles.cardClass}>➕ Add a class you need help with</span>
      </div>
      <label style={styles.classSurveyLabel}>
        Which class? *
        <input
          style={styles.assignInput}
          value={klass}
          placeholder="e.g. Chemistry, Algebra 2, Spanish 3"
          onChange={(e) => setKlass(e.target.value)}
          autoFocus
        />
      </label>
      <span style={styles.classSurveyLabel}>
        Before we start — how much do you already know here?
        <div style={styles.horizonRow}>
          {CLASS_LEVELS.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => setLevel(level === o.value ? "" : o.value)}
              style={{
                ...styles.horizonBtn,
                ...(level === o.value ? styles.horizonBtnActive : {}),
              }}
            >
              {o.value}
              <span style={styles.horizonHint}>{o.hint}</span>
            </button>
          ))}
        </div>
      </span>
      <span style={styles.classSurveyLabel}>
        How confident do you feel about this class right now?
        <div style={styles.horizonRow}>
          {CLASS_CONFIDENCE.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setConfidence(confidence === c ? "" : c)}
              style={{
                ...styles.horizonBtn,
                ...(confidence === c ? styles.horizonBtnActive : {}),
              }}
            >
              {c}
            </button>
          ))}
        </div>
      </span>
      <label style={styles.classSurveyLabel}>
        What do you struggle with in this class?
        <input
          style={styles.assignInput}
          value={struggles}
          placeholder="e.g. balancing equations, word problems, memorizing"
          onChange={(e) => setStruggles(e.target.value)}
        />
      </label>
      <label style={styles.classSurveyLabel}>
        What do you want to get done?
        <input
          style={styles.assignInput}
          value={goal}
          placeholder="e.g. pass the unit test Friday, catch up on Unit 3"
          onChange={(e) => setGoal(e.target.value)}
        />
      </label>
      <div style={styles.classSurveyActions}>
        <button style={styles.classSurveyCancel} onClick={onCancel}>
          Cancel
        </button>
        <button
          style={{
            ...styles.assignAddBtn,
            ...(canSubmit ? {} : { opacity: 0.5, cursor: "default" }),
          }}
          disabled={!canSubmit}
          onClick={() =>
            onSubmit({ klass, struggles, goal, level, confidence })
          }
        >
          Add &amp; build plan
        </button>
      </div>
    </div>
  );
}

// Compact "today's one next step" strip — keeps the plan front-and-center.
function PlanStrip({
  plan,
  onToggleNext,
  onOpen,
}: {
  plan: Milestone[];
  onToggleNext: () => void;
  onOpen: () => void;
}) {
  if (!plan.length) return null;
  const done = plan.filter((m) => m.done).length;
  const next = plan.find((m) => !m.done);
  return (
    <div style={styles.planStrip}>
      <div style={styles.planStripHead}>
        <span style={styles.planStripLabel}>📋 Your plan · {done}/{plan.length}</span>
        <button style={styles.linkBtn} onClick={onOpen}>
          View
        </button>
      </div>
      {next ? (
        <button style={styles.planStripNext} onClick={onToggleNext}>
          <span style={styles.planStripCheck} />
          <span>
            <span style={styles.planStripNextLabel}>Next step: </span>
            {next.checkpoint ? "🚩 " : ""}
            {next.title}
          </span>
        </button>
      ) : (
        <div style={styles.planStripDone}>🎉 Plan complete — ask me for the next stage!</div>
      )}
    </div>
  );
}

// Compact goals summary for the Home dashboard: the soonest-due active goal
// (with progress) + a count, tappable to open the full Goals panel.
function GoalStrip({
  goals,
  onOpen,
}: {
  goals: SmartGoal[];
  onOpen: () => void;
}) {
  const active = goals.filter((g) => !g.done);
  if (!active.length) return null;
  // Soonest deadline first; undated goals last.
  const sorted = [...active].sort((a, b) => {
    if (a.timeBound && b.timeBound) return a.timeBound.localeCompare(b.timeBound);
    if (a.timeBound) return -1;
    if (b.timeBound) return 1;
    return 0;
  });
  const g = sorted[0];
  const headline = g.statement?.trim() || g.specific;
  const pct =
    typeof g.target === "number" && g.target > 0
      ? Math.round(((g.current ?? 0) / g.target) * 100)
      : null;
  const overdue = g.timeBound ? daysUntil(g.timeBound) < 0 : false;
  return (
    <div style={styles.planStrip}>
      <div style={styles.planStripHead}>
        <span style={styles.planStripLabel}>
          🌟 Your goals · {active.length} active
        </span>
        <button style={styles.linkBtn} onClick={onOpen}>
          View
        </button>
      </div>
      <button style={styles.planStripNext} onClick={onOpen}>
        <span style={{ flex: 1, textAlign: "left" }}>
          {headline}
        </span>
        {g.timeBound && (
          <span
            style={{
              ...styles.goalDue,
              ...(overdue ? styles.goalDueOver : {}),
            }}
          >
            {countdown(g.timeBound)}
          </span>
        )}
      </button>
      {pct != null && (
        <div style={styles.goalTrack}>
          <div style={{ ...styles.goalFill, width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

const MISTAKE_SOURCE_ICON: Record<MistakeSource, string> = {
  quiz: "📝",
  chat: "💬",
  feedback: "✍️",
  manual: "✋",
};

// The mistake tracker on the Home dashboard: a compact strip that expands in
// place into the full, manageable list of concepts the learner keeps missing.
// Open items sort most-missed first. Each can be re-taught (jump to chat), marked
// "Got it" (resolved), or removed; new concepts can be added by hand. Captured
// entries flow in from quizzes, chat, and assignment feedback (see `source`).
function MistakeCenter({
  mistakes,
  onAdd,
  onReview,
  onResolve,
  onRemove,
}: {
  mistakes: Mistake[];
  onAdd: (m: {
    concept: string;
    subject?: string;
    source: MistakeSource;
  }) => void;
  onReview: (m: Mistake) => void;
  onResolve: (id: string, resolved: boolean) => void;
  onRemove: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [showResolved, setShowResolved] = useState(false);
  const [draft, setDraft] = useState("");
  const [draftSubject, setDraftSubject] = useState("");

  const open = mistakes.filter((m) => !m.resolved);
  const resolved = mistakes.filter((m) => m.resolved);
  const sorted = [...open].sort(
    (a, b) => b.count - a.count || b.lastSeen.localeCompare(a.lastSeen),
  );

  function submitAdd() {
    const c = draft.trim();
    if (!c) return;
    onAdd({
      concept: c,
      subject: draftSubject.trim() || undefined,
      source: "manual",
    });
    setDraft("");
    setDraftSubject("");
  }

  const addForm = (
    <div style={styles.mtAddRow}>
      <input
        style={styles.mtInput}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submitAdd()}
        placeholder="A concept you keep missing…"
      />
      <input
        style={styles.mtInputSm}
        value={draftSubject}
        onChange={(e) => setDraftSubject(e.target.value)}
        placeholder="Subject"
      />
      <button style={styles.mtAddBtn} onClick={submitAdd} disabled={!draft.trim()}>
        Add
      </button>
    </div>
  );

  // Nothing tracked yet — offer a slim add affordance so manual entry stays
  // reachable without cluttering the dashboard.
  if (!mistakes.length) {
    return (
      <div style={styles.mtStrip}>
        {expanded ? (
          addForm
        ) : (
          <button style={styles.mtEmptyBtn} onClick={() => setExpanded(true)}>
            🧩 Track a concept you keep missing
          </button>
        )}
      </div>
    );
  }

  return (
    <div style={styles.mtStrip}>
      <div style={styles.mtHead}>
        <span style={styles.mtLabel}>🧩 Concepts to fix · {open.length}</span>
        <button style={styles.linkBtn} onClick={() => setExpanded((v) => !v)}>
          {expanded ? "Hide" : "Review"}
        </button>
      </div>

      {!expanded && sorted[0] && (
        <button style={styles.mtTop} onClick={() => setExpanded(true)}>
          <span style={{ flex: 1, textAlign: "left" }}>
            {sorted[0].subject ? `${sorted[0].subject}: ` : ""}
            {sorted[0].concept}
          </span>
          {sorted[0].count > 1 && (
            <span style={styles.mtCount}>missed {sorted[0].count}×</span>
          )}
        </button>
      )}

      {expanded && (
        <div style={styles.mtList}>
          {sorted.map((m) => (
            <div key={m.id} style={styles.mtItem}>
              <div style={styles.mtItemTop}>
                <span style={styles.mtItemTitle}>
                  <span title={m.source}>{MISTAKE_SOURCE_ICON[m.source]}</span>{" "}
                  {m.concept}
                </span>
                {m.count > 1 && <span style={styles.mtCount}>×{m.count}</span>}
              </div>
              {(m.subject || m.why || m.fix) && (
                <div style={styles.mtItemMeta}>
                  {m.subject && <span style={styles.mtChip}>{m.subject}</span>}
                  {m.why && <span style={styles.mtWhy}>{m.why}</span>}
                  {m.fix && <div style={styles.mtFix}>✓ {m.fix}</div>}
                </div>
              )}
              <div style={styles.mtBtnRow}>
                <button style={styles.mtReviewBtn} onClick={() => onReview(m)}>
                  Re-teach me
                </button>
                <button
                  style={styles.mtGotBtn}
                  onClick={() => onResolve(m.id, true)}
                >
                  Got it ✓
                </button>
                <button
                  style={styles.mtRemoveBtn}
                  title="Remove"
                  onClick={() => onRemove(m.id)}
                >
                  ✕
                </button>
              </div>
            </div>
          ))}

          {addForm}

          {resolved.length > 0 && (
            <div style={styles.mtResolvedBox}>
              <button
                style={styles.mtResolvedToggle}
                onClick={() => setShowResolved((v) => !v)}
              >
                {showResolved ? "▾" : "▸"} Mastered · {resolved.length}
              </button>
              {showResolved &&
                resolved.map((m) => (
                  <div key={m.id} style={styles.mtResolvedItem}>
                    <span style={{ flex: 1 }}>✅ {m.concept}</span>
                    <button
                      style={styles.linkBtn}
                      onClick={() => onResolve(m.id, false)}
                    >
                      Reopen
                    </button>
                    <button
                      style={styles.mtRemoveBtn}
                      title="Remove"
                      onClick={() => onRemove(m.id)}
                    >
                      ✕
                    </button>
                  </div>
                ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// A 9am–9pm day planner: one editable row per hour. Each block has a text field
// and a tappable tag (study / break / class / other) that colors the block. The
// row for the current hour is highlighted so "now" is easy to find.
function ScheduleGrid({
  schedule,
  onSet,
  onClear,
  homeHour,
  onSetHomeHour,
  onGenerate,
  onSetupSubmit,
  setupInitial,
  generating,
  onStudyMinutes,
}: {
  schedule: DaySchedule | null;
  onSet: (hour: number, patch: Partial<ScheduleBlock>) => void;
  onClear: () => void;
  homeHour: number;
  onSetHomeHour: (h: number) => void;
  onGenerate: () => void;
  onSetupSubmit: (a: {
    homeTime: string;
    budget: string;
    focusTime: string;
    sessionLength: string;
    focusHelp: string;
    focusNote: string;
  }) => void;
  setupInitial?: {
    focusTime?: string;
    sessionLength?: string;
    focusHelp?: string;
  };
  generating: boolean;
  onStudyMinutes: (mins: number) => void;
}) {
  const today = localISO();
  const fresh = schedule && schedule.date === today ? schedule : null;
  const blocks = fresh?.blocks ?? {};
  const currentHour = new Date().getHours();
  const filled = SCHEDULE_HOURS.filter(
    (h) => (blocks[h]?.text ?? "").trim(),
  ).length;
  const prettyDate = new Date(`${today}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const cycleKind = (h: number) => {
    const cur = blocks[h]?.kind ?? "study";
    const idx = SCHEDULE_KINDS.findIndex((k) => k.key === cur);
    onSet(h, { kind: SCHEDULE_KINDS[(idx + 1) % SCHEDULE_KINDS.length].key });
  };

  // Schedule-setup survey: a short intake shown when "Set up my schedule" is
  // tapped. Answers feed the schedule builder (when free, how long, what to focus
  // on) and are remembered on the learner's profile.
  const [setupOpen, setSetupOpen] = useState(false);
  const [suHomeTime, setSuHomeTime] = useState("");
  const [suBudget, setSuBudget] = useState("");
  const [suFocusTime, setSuFocusTime] = useState(setupInitial?.focusTime ?? "");
  const [suSessionLength, setSuSessionLength] = useState(
    setupInitial?.sessionLength ?? "",
  );
  const [suFocusHelp, setSuFocusHelp] = useState(setupInitial?.focusHelp ?? "");
  const [suFocusNote, setSuFocusNote] = useState("");
  const setupChoice = (
    question: string,
    options: string[],
    value: string,
    setValue: (s: string) => void,
  ) => (
    <div style={styles.label}>
      {question}
      <div style={styles.choiceList}>
        {options.map((opt) => {
          const selected = value === opt;
          return (
            <button
              key={opt}
              type="button"
              onClick={() => setValue(selected ? "" : opt)}
              style={{
                ...styles.choiceBtn,
                ...(selected ? styles.choiceBtnSelected : {}),
              }}
            >
              <span style={styles.choiceRadio}>{selected ? "●" : ""}</span>
              {opt}
            </button>
          );
        })}
      </div>
    </div>
  );

  // Like setupChoice but multi-select — value is a comma-joined list.
  const setupMultiChoice = (
    question: string,
    options: string[],
    value: string,
    setValue: (s: string) => void,
  ) => {
    const chosen = new Set(
      value ? value.split(",").map((s) => s.trim()).filter(Boolean) : [],
    );
    const toggle = (opt: string) => {
      const next = new Set(chosen);
      if (next.has(opt)) next.delete(opt);
      else next.add(opt);
      setValue([...next].join(", "));
    };
    return (
      <div style={styles.label}>
        {question}{" "}
        <span style={styles.choiceHint}>(select all that apply)</span>
        <div style={styles.choiceList}>
          {options.map((opt) => {
            const isSel = chosen.has(opt);
            return (
              <button
                key={opt}
                type="button"
                onClick={() => toggle(opt)}
                style={{
                  ...styles.choiceBtn,
                  ...(isSel ? styles.choiceBtnSelected : {}),
                }}
              >
                <span
                  style={{
                    ...styles.choiceCheckbox,
                    ...(isSel ? styles.choiceCheckboxSelected : {}),
                  }}
                >
                  {isSel ? "✓" : ""}
                </span>
                {opt}
              </button>
            );
          })}
        </div>
      </div>
    );
  };

  // Per-task countdown timer. One block runs at a time. `total`/`study` let us
  // credit the finished session's minutes toward "hours studied" (study blocks
  // only), logged once when the countdown runs out.
  const [timer, setTimer] = useState<{
    hour: number;
    left: number;
    running: boolean;
    total: number; // full session length, seconds
    study: boolean; // whether this block counts as study time
  } | null>(null);
  // Build a fresh running-timer state for an hour block, tagging it study or not.
  const mkTimer = (h: number, mins = TIMER_DEFAULT_MIN) => ({
    hour: h,
    left: mins * 60,
    running: true,
    total: mins * 60,
    study: (blocks[h]?.kind ?? "study") === "study",
  });
  useEffect(() => {
    if (!timer?.running) return;
    const id = setInterval(() => {
      setTimer((t) => {
        if (!t || !t.running) return t;
        if (t.left <= 1) {
          playTimerChime();
          // Credit the completed session. Defer out of the state updater so we
          // don't call the parent's setState while updating this component.
          if (t.study) {
            const mins = Math.round(t.total / 60);
            queueMicrotask(() => onStudyMinutes(mins));
          }
          return { ...t, left: 0, running: false };
        }
        return { ...t, left: t.left - 1 };
      });
    }, 1000);
    return () => clearInterval(id);
  }, [timer?.running, timer?.hour]);
  const startTimer = (h: number, mins = TIMER_DEFAULT_MIN) =>
    setTimer(mkTimer(h, mins));
  const toggleTimer = (h: number) =>
    setTimer((t) =>
      t && t.hour === h
        ? t.left <= 0
          ? mkTimer(h)
          : { ...t, running: !t.running }
        : mkTimer(h),
    );
  return (
    <div style={styles.card}>
      <div style={styles.cardHead}>
        <span style={styles.cardClass}>🕘 Today&apos;s schedule</span>
        <span style={styles.subjectsCount}>
          {filled ? `${filled} planned · ` : ""}
          {prettyDate}
        </span>
      </div>
      <p style={{ color: "var(--muted)", margin: "2px 0 10px", fontSize: 13 }}>
        Plan your day from 9 AM to 9 PM, or let me build your study time around
        when you get home. Tap a block&apos;s tag to change study / break / class.
      </p>
      <button
        type="button"
        style={styles.schedSetupBtn}
        onClick={() => setSetupOpen((v) => !v)}
      >
        📝 {setupOpen ? "Hide setup" : "Set up my schedule"}
      </button>
      {setupOpen && (
        <div style={styles.schedSetupPanel}>
          <p style={{ color: "var(--muted)", margin: "0 0 6px", fontSize: 13 }}>
            A few quick questions so I can build today&apos;s plan around you.
          </p>
          {setupChoice(
            "When are you usually free to study?",
            HOME_TIME_OPTIONS,
            suHomeTime,
            setSuHomeTime,
          )}
          {setupChoice(
            "How much study time do you want today?",
            STUDY_BUDGET_OPTIONS,
            suBudget,
            setSuBudget,
          )}
          {setupChoice(
            "When do you focus best?",
            FOCUS_TIME_OPTIONS,
            suFocusTime,
            setSuFocusTime,
          )}
          {setupChoice(
            "How long can you focus in one sitting?",
            SESSION_LENGTH_OPTIONS,
            suSessionLength,
            setSuSessionLength,
          )}
          {setupMultiChoice(
            "What helps you focus?",
            FOCUS_HELP_OPTIONS,
            suFocusHelp,
            setSuFocusHelp,
          )}
          <label style={styles.label}>
            Anything today&apos;s schedule should prioritize? (optional)
            <textarea
              style={{ ...styles.input, minHeight: 56, resize: "vertical" }}
              value={suFocusNote}
              onChange={(e) => setSuFocusNote(e.target.value)}
              placeholder="e.g. Bio exam Friday, catch up on algebra"
            />
          </label>
          <button
            type="button"
            style={{
              ...styles.schedBuildBtn,
              opacity: !suHomeTime || generating ? 0.5 : 1,
              width: "100%",
            }}
            disabled={!suHomeTime || generating}
            onClick={() => {
              onSetupSubmit({
                homeTime: suHomeTime,
                budget: suBudget,
                focusTime: suFocusTime,
                sessionLength: suSessionLength,
                focusHelp: suFocusHelp,
                focusNote: suFocusNote.trim(),
              });
              setSetupOpen(false);
            }}
          >
            {generating ? "Building…" : "✨ Build my schedule"}
          </button>
        </div>
      )}
      <div style={styles.schedBuildRow}>
        <label style={styles.schedBuildLabel}>
          I get home at
          <select
            style={styles.schedHomeSelect}
            value={homeHour}
            onChange={(e) => onSetHomeHour(parseInt(e.target.value, 10))}
          >
            {SCHEDULE_HOURS.filter((h) => h >= 11 && h <= 20).map((h) => (
              <option key={h} value={h}>
                {hourLabel(h)}
              </option>
            ))}
          </select>
        </label>
        <button
          style={styles.schedBuildBtn}
          disabled={generating}
          onClick={onGenerate}
        >
          {generating ? "Building…" : "✨ Build my study schedule"}
        </button>
      </div>
      <div style={styles.schedList}>
        {SCHEDULE_HOURS.map((h) => {
          const b = blocks[h];
          const hasText = !!(b?.text ?? "").trim();
          const kind = scheduleKind(b?.kind ?? "study");
          const isNow = h === currentHour;
          return (
            <div
              key={h}
              style={{
                ...styles.schedRow,
                ...(isNow ? styles.schedRowNow : {}),
                borderLeft: `4px solid ${
                  hasText ? kind.color : "var(--border)"
                }`,
              }}
            >
              <span style={styles.schedTime}>
                {hourLabel(h)}
                {isNow && <span style={styles.schedNowDot}>now</span>}
              </span>
              <button
                style={{
                  ...styles.schedKind,
                  ...(hasText ? { color: kind.color } : { opacity: 0.45 }),
                }}
                onClick={() => cycleKind(h)}
                aria-label={`Block type: ${kind.label}. Tap to change.`}
                title={`${kind.label} — tap to change`}
              >
                {kind.emoji}
              </button>
              <input
                style={styles.schedInput}
                value={b?.text ?? ""}
                placeholder={isNow ? "Now — what's the plan?" : "—"}
                onChange={(e) => onSet(h, { text: e.target.value })}
              />
              {hasText &&
                (timer?.hour === h ? (
                  <div style={styles.schedTimer}>
                    <button
                      style={styles.schedTimerBtn}
                      onClick={() => toggleTimer(h)}
                      title={
                        timer.left <= 0
                          ? "Restart"
                          : timer.running
                            ? "Pause"
                            : "Resume"
                      }
                      aria-label={
                        timer.left <= 0
                          ? "Restart timer"
                          : timer.running
                            ? "Pause timer"
                            : "Resume timer"
                      }
                    >
                      {timer.left <= 0 ? "↺" : timer.running ? "⏸" : "▶"}
                    </button>
                    <span
                      style={{
                        ...styles.schedTimerTime,
                        ...(timer.left <= 0 ? styles.schedTimerDone : {}),
                      }}
                    >
                      {timer.left <= 0 ? "done ✓" : fmtTimer(timer.left)}
                    </span>
                    <button
                      style={styles.schedTimerClear}
                      onClick={() => setTimer(null)}
                      title="Clear timer"
                      aria-label="Clear timer"
                    >
                      ✕
                    </button>
                  </div>
                ) : (
                  <button
                    style={styles.schedTimerStart}
                    onClick={() => startTimer(h)}
                    title={`Start a ${TIMER_DEFAULT_MIN}-min focus countdown`}
                    aria-label={`Start a ${TIMER_DEFAULT_MIN}-minute focus timer for this block`}
                  >
                    ⏱
                  </button>
                ))}
            </div>
          );
        })}
      </div>
      {filled > 0 && (
        <div style={{ marginTop: 12, textAlign: "right" }}>
          <button style={styles.linkBtn} onClick={onClear}>
            Clear day
          </button>
        </div>
      )}
    </div>
  );
}

// A Duolingo-style winding "snake path" view of the study plan. Each milestone
// is a node on an alternating left/right path: completed steps are filled, the
// first unfinished step is the highlighted "current" node, and checkpoints fly a
// flag. Clicking a node toggles that step's done state (same as the list view).
function PlanPathMap({
  plan,
  onToggle,
}: {
  plan: Milestone[];
  onToggle: (i: number) => void;
}) {
  const n = plan.length;
  const rowH = 96;
  const topPad = 52;
  const botPad = 88;
  const height = topPad + Math.max(0, n - 1) * rowH + botPad;
  // x in a 0..100 coordinate space (percent of width); alternate around the
  // centre in a sine wave so the path snakes down the screen.
  const nodes = plan.map((m, i) => ({
    m,
    i,
    x: 50 + 34 * Math.sin(i * 0.85 + 0.4),
    y: topPad + i * rowH,
  }));
  const currentIdx = plan.findIndex((m) => !m.done);
  const done = plan.filter((m) => m.done).length;
  const pct = n ? Math.round((done / n) * 100) : 0;
  const finishY = topPad + Math.max(0, n - 1) * rowH + 64;
  const finishX = n > 0 ? 50 + 34 * Math.sin(n * 0.85 + 0.4) : 50;

  // Smooth S-curve path string through a list of {x,y} points.
  const curve = (pts: { x: number; y: number }[]) => {
    let d = "";
    pts.forEach((p, i) => {
      if (i === 0) d += `M ${p.x} ${p.y}`;
      else {
        const prev = pts[i - 1];
        const midY = (prev.y + p.y) / 2;
        d += ` C ${prev.x} ${midY}, ${p.x} ${midY}, ${p.x} ${p.y}`;
      }
    });
    return d;
  };
  const allPts = [...nodes.map((p) => ({ x: p.x, y: p.y })), { x: finishX, y: finishY }];
  // How far along the path is "walked" (solid) — through the current node.
  const walkCount = currentIdx === -1 ? allPts.length : currentIdx + 1;
  const trackD = curve(allPts);
  const doneD = walkCount >= 2 ? curve(allPts.slice(0, walkCount)) : "";

  return (
    <div style={styles.card}>
      <style>{
        "@keyframes elioraPathPulse{0%{box-shadow:0 0 0 0 rgba(44,107,76,0.45)}70%{box-shadow:0 0 0 12px rgba(44,107,76,0)}100%{box-shadow:0 0 0 0 rgba(44,107,76,0)}}"
      }</style>
      <div style={styles.planHead}>
        <span style={styles.planTitle}>Your path</span>
        <span style={styles.planCount}>
          {done}/{n} · {pct}%
        </span>
      </div>
      <div style={styles.progressTrack}>
        <div style={{ ...styles.progressFill, width: `${pct}%` }} />
      </div>
      <div style={{ position: "relative", width: "100%", height, marginTop: 8 }}>
        <svg
          viewBox={`0 0 100 ${height}`}
          preserveAspectRatio="none"
          width="100%"
          height={height}
          style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
        >
          <path
            d={trackD}
            fill="none"
            stroke="var(--border)"
            strokeWidth={4}
            strokeLinecap="round"
            strokeDasharray="1 9"
            vectorEffect="non-scaling-stroke"
          />
          {doneD && (
            <path
              d={doneD}
              fill="none"
              stroke="var(--accent)"
              strokeWidth={4}
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
        {nodes.map(({ m, i, x, y }) => {
          const isDone = m.done;
          const isCurrent = i === currentIdx;
          const cp = m.checkpoint;
          const size = isCurrent ? 58 : 50;
          const bg = isDone
            ? cp
              ? "#b8742a"
              : "var(--accent)"
            : isCurrent
              ? "var(--surface)"
              : cp
                ? "#f3e7d7"
                : "var(--accent-soft)";
          const border = cp ? "#b8742a" : "var(--accent)";
          const borderW = isCurrent ? 3 : isDone ? 0 : 2;
          const content = isDone ? "✓" : cp ? "🚩" : String(i + 1);
          const fg = isDone
            ? "#fff"
            : isCurrent
              ? cp
                ? "#b8742a"
                : "var(--accent)"
              : "var(--muted)";
          return (
            <div
              key={i}
              style={{
                position: "absolute",
                left: `${x}%`,
                top: y,
                transform: "translate(-50%, -50%)",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                width: 148,
              }}
            >
              {isCurrent && (
                <span
                  style={{
                    position: "absolute",
                    top: -26,
                    fontSize: 11,
                    fontWeight: 800,
                    color: cp ? "#b8742a" : "var(--accent)",
                    background: "var(--surface)",
                    border: `1px solid ${cp ? "#b8742a" : "var(--accent)"}`,
                    borderRadius: 999,
                    padding: "2px 8px",
                    whiteSpace: "nowrap",
                  }}
                >
                  ▶ You're here
                </span>
              )}
              <button
                onClick={() => onToggle(i)}
                title={`${cp ? "🚩 Checkpoint — " : ""}${m.title}${m.detail ? ` — ${m.detail}` : ""}`}
                aria-label={`${isDone ? "Completed" : "Not done"}: ${m.title}. Click to toggle.`}
                style={{
                  width: size,
                  height: size,
                  borderRadius: "50%",
                  border: borderW ? `${borderW}px solid ${border}` : "none",
                  background: bg,
                  color: fg,
                  fontSize: cp && !isDone ? 22 : 20,
                  fontWeight: 800,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  boxShadow: isDone ? "0 2px 6px rgba(0,0,0,0.12)" : "none",
                  animation: isCurrent ? "elioraPathPulse 2s infinite" : "none",
                  transition: "transform 0.12s ease",
                }}
              >
                {content}
              </button>
              <span
                style={{
                  marginTop: 6,
                  fontSize: 12,
                  lineHeight: 1.25,
                  textAlign: "center",
                  color: isDone ? "var(--muted)" : "var(--assistant-text)",
                  fontWeight: isCurrent ? 700 : 500,
                  display: "-webkit-box",
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: "vertical",
                  overflow: "hidden",
                }}
              >
                {m.title}
              </span>
            </div>
          );
        })}
        {/* Finish trophy at the end of the path. */}
        <div
          style={{
            position: "absolute",
            left: `${finishX}%`,
            top: finishY,
            transform: "translate(-50%, -50%)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
          }}
        >
          <div
            style={{
              width: 54,
              height: 54,
              borderRadius: "50%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 26,
              background: pct === 100 ? "var(--accent-soft)" : "var(--elevated)",
              border: `2px ${pct === 100 ? "solid" : "dashed"} ${pct === 100 ? "var(--accent)" : "var(--border)"}`,
            }}
          >
            🏆
          </div>
          <span
            style={{
              marginTop: 6,
              fontSize: 12,
              fontWeight: 700,
              color: pct === 100 ? "var(--accent)" : "var(--muted)",
            }}
          >
            {pct === 100 ? "Plan complete!" : "Finish"}
          </span>
        </div>
      </div>
    </div>
  );
}

// Wraps the study plan in a Path / List view switch. The snake path is the
// default; the list keeps the full add/edit/remove controls.
function PlanBoard(props: {
  plan: Milestone[];
  onToggle: (i: number) => void;
  onAdd?: (title: string) => void;
  onRemove?: (i: number) => void;
  onEdit?: (
    i: number,
    patch: { title?: string; detail?: string; checkpoint?: boolean },
  ) => void;
}) {
  const [view, setView] = useState<"path" | "list">("path");
  const tabStyle = (active: boolean) => ({
    flex: 1,
    padding: "8px 10px",
    borderRadius: 10,
    border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
    background: active ? "var(--accent)" : "var(--surface)",
    color: active ? "#fff" : "var(--muted)",
    fontWeight: 700 as const,
    fontSize: 13,
    cursor: "pointer",
  });
  return (
    <>
      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
        <button style={tabStyle(view === "path")} onClick={() => setView("path")}>
          🗺️ Path
        </button>
        <button style={tabStyle(view === "list")} onClick={() => setView("list")}>
          📋 List
        </button>
      </div>
      {view === "path" ? (
        <PlanPathMap plan={props.plan} onToggle={props.onToggle} />
      ) : (
        <PlanPanel {...props} />
      )}
    </>
  );
}

function PlanPanel({
  plan,
  onToggle,
  onAdd,
  onRemove,
  onEdit,
}: {
  plan: Milestone[];
  onToggle: (i: number) => void;
  onAdd?: (title: string) => void;
  onRemove?: (i: number) => void;
  onEdit?: (
    i: number,
    patch: { title?: string; detail?: string; checkpoint?: boolean },
  ) => void;
}) {
  const [step, setStep] = useState("");
  // Which row is being edited, plus the draft fields for that row.
  const [editIdx, setEditIdx] = useState<number | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDetail, setEditDetail] = useState("");
  const [editCheckpoint, setEditCheckpoint] = useState(false);
  const done = plan.filter((m) => m.done).length;
  const pct = plan.length ? Math.round((done / plan.length) * 100) : 0;
  function addStep() {
    if (!step.trim() || !onAdd) return;
    onAdd(step);
    setStep("");
  }
  function startEdit(i: number) {
    const m = plan[i];
    setEditIdx(i);
    setEditTitle(m.title);
    setEditDetail(m.detail ?? "");
    setEditCheckpoint(!!m.checkpoint);
  }
  function cancelEdit() {
    setEditIdx(null);
  }
  function saveEdit() {
    if (editIdx == null || !onEdit) return;
    if (!editTitle.trim()) return;
    onEdit(editIdx, {
      title: editTitle,
      detail: editDetail,
      checkpoint: editCheckpoint,
    });
    setEditIdx(null);
  }
  return (
    <div style={styles.plan}>
      <div style={styles.planHead}>
        <span style={styles.planTitle}>Your plan</span>
        <span style={styles.planCount}>
          {done}/{plan.length} done
        </span>
      </div>
      <div style={styles.progressTrack}>
        <div style={{ ...styles.progressFill, width: `${pct}%` }} />
      </div>
      <div style={styles.planList}>
        {plan.map((m, i) =>
          editIdx === i ? (
            <div key={i} style={styles.planEditRow}>
              <input
                style={styles.planEditInput}
                value={editTitle}
                placeholder="Step title"
                autoFocus
                onChange={(e) => setEditTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveEdit();
                  if (e.key === "Escape") cancelEdit();
                }}
              />
              <input
                style={styles.planEditInput}
                value={editDetail}
                placeholder="Detail (optional) — e.g. Spend about 10 minutes…"
                onChange={(e) => setEditDetail(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveEdit();
                  if (e.key === "Escape") cancelEdit();
                }}
              />
              <div style={styles.planEditControls}>
                <label style={styles.planEditCheckpoint}>
                  <input
                    type="checkbox"
                    checked={editCheckpoint}
                    onChange={(e) => setEditCheckpoint(e.target.checked)}
                  />
                  🚩 Checkpoint
                </label>
                <span style={{ flex: 1 }} />
                <button
                  style={styles.planEditCancel}
                  onClick={cancelEdit}
                >
                  Cancel
                </button>
                <button
                  style={styles.planEditSave}
                  disabled={!editTitle.trim()}
                  onClick={saveEdit}
                >
                  Save
                </button>
              </div>
            </div>
          ) : (
            <div key={i} style={styles.planRow}>
              <button
                style={{ ...styles.planItem, flex: 1 }}
                onClick={() => onToggle(i)}
              >
                <span
                  style={{
                    ...styles.checkbox,
                    borderColor: m.checkpoint ? "#b8742a" : "var(--accent)",
                    background: m.done
                      ? m.checkpoint
                        ? "#b8742a"
                        : "var(--accent)"
                      : "transparent",
                    color: m.done ? "#fff" : "transparent",
                  }}
                >
                  ✓
                </span>
                <span
                  style={{
                    textDecoration: m.done ? "line-through" : "none",
                    color: m.done ? "var(--muted)" : "var(--assistant-text)",
                  }}
                >
                  {m.checkpoint && (
                    <span style={styles.checkpointBadge}>🚩 Checkpoint</span>
                  )}
                  {m.title}
                  {m.detail ? ` — ${m.detail}` : ""}
                </span>
              </button>
              {onEdit && (
                <button
                  style={styles.planRowAction}
                  onClick={() => startEdit(i)}
                  aria-label={`Edit step ${m.title}`}
                  title="Edit step"
                >
                  ✎
                </button>
              )}
              {onRemove && (
                <button
                  style={styles.folderRemove}
                  onClick={() => onRemove(i)}
                  aria-label={`Remove step ${m.title}`}
                  title="Delete step"
                >
                  ×
                </button>
              )}
            </div>
          ),
        )}
      </div>
      {onAdd && (
        <div style={styles.assignAddRow}>
          <input
            style={styles.assignInput}
            value={step}
            placeholder="Add your own step…"
            onChange={(e) => setStep(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") addStep();
            }}
          />
          <button style={styles.assignAddBtn} onClick={addStep}>
            Add
          </button>
        </div>
      )}
    </div>
  );
}

// A visual month grid that marks days with events and lets you tap a day to add.
function MonthGrid({
  events,
  assignments = [],
  dailyTasks = null,
  onPickDate,
}: {
  events: StudyEvent[];
  assignments?: Assignment[];
  dailyTasks?: DailyTasksState | null;
  onPickDate: (iso: string) => void;
}) {
  const now = new Date();
  const [view, setView] = useState({ y: now.getFullYear(), m: now.getMonth() });
  const pad = (n: number) => String(n).padStart(2, "0");
  const isoFor = (d: number) => `${view.y}-${pad(view.m + 1)}-${pad(d)}`;
  const todayIso = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(
    now.getDate(),
  )}`;
  const first = new Date(view.y, view.m, 1);
  const startWeekday = first.getDay();
  const daysInMonth = new Date(view.y, view.m + 1, 0).getDate();
  const monthLabel = first.toLocaleString("en-US", {
    month: "long",
    year: "numeric",
  });
  // Dots per day: exams/finals (by kind colour), assignment due dates (accent
  // green), and planned work sessions (amber, from time management).
  const dotsByDate: Record<string, { color: string; label: string }[]> = {};
  for (const e of events)
    (dotsByDate[e.date] ||= []).push({
      color: KIND_COLOR[e.kind ?? "other"],
      label: e.title,
    });
  for (const a of assignments)
    if (a.due)
      (dotsByDate[a.due] ||= []).push({
        color: "#2f6f4f",
        label: `📌 due: ${a.title}${a.done ? " ✓" : ""}`,
      });
  for (const a of assignments)
    if (a.planDate && !a.done)
      (dotsByDate[a.planDate] ||= []).push({
        color: "#d98a2b",
        label: `⏳ work on: ${a.title}${
          a.estMin ? ` (${a.estMin} min)` : ""
        }`,
      });
  // Daily to-do list (purple) — one dot per task on the day it's scheduled for.
  if (dailyTasks?.date)
    for (const t of dailyTasks.tasks)
      (dotsByDate[dailyTasks.date] ||= []).push({
        color: "#6b5bd6",
        label: `📝 ${t.title}${t.done ? " ✓" : ""}`,
      });
  const cells: (number | null)[] = [];
  for (let i = 0; i < startWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  const shift = (delta: number) => {
    const dt = new Date(view.y, view.m + delta, 1);
    setView({ y: dt.getFullYear(), m: dt.getMonth() });
  };

  return (
    <div style={styles.calGridWrap}>
      <div style={styles.calNav}>
        <button
          style={styles.calNavBtn}
          onClick={() => shift(-1)}
          aria-label="Previous month"
        >
          ‹
        </button>
        <span style={styles.calMonthLabel}>{monthLabel}</span>
        <button
          style={styles.calNavBtn}
          onClick={() => shift(1)}
          aria-label="Next month"
        >
          ›
        </button>
      </div>
      <div style={styles.calWeekRow}>
        {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
          <span key={i} style={styles.calWeekday}>
            {d}
          </span>
        ))}
      </div>
      <div style={styles.calGrid}>
        {cells.map((d, i) => {
          if (d === null)
            return <span key={`e${i}`} style={styles.calCellEmpty} />;
          const iso = isoFor(d);
          const dots = dotsByDate[iso] || [];
          const isToday = iso === todayIso;
          return (
            <button
              key={iso}
              onClick={() => onPickDate(iso)}
              title={
                dots.length
                  ? dots.map((x) => x.label).join(", ")
                  : `Add a date on ${iso}`
              }
              style={{
                ...styles.calCell,
                ...(isToday ? styles.calCellToday : {}),
              }}
            >
              <span>{d}</span>
              {dots.length > 0 && (
                <span style={styles.calDots}>
                  {dots.slice(0, 3).map((x, j) => (
                    <span
                      key={j}
                      style={{ ...styles.calDot, background: x.color }}
                    />
                  ))}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {(assignments.some((a) => a.planDate && !a.done) ||
        (dailyTasks?.tasks.length ?? 0) > 0) && (
        <div style={styles.calLegend}>
          <span style={styles.calLegendItem}>
            <span style={{ ...styles.calDot, background: "#2f6f4f" }} /> due
          </span>
          <span style={styles.calLegendItem}>
            <span style={{ ...styles.calDot, background: "#d98a2b" }} /> work on
          </span>
          {(dailyTasks?.tasks.length ?? 0) > 0 && (
            <span style={styles.calLegendItem}>
              <span style={{ ...styles.calDot, background: "#6b5bd6" }} /> tasks
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function CalendarPanel({
  events,
  assignments = [],
  dailyTasks = null,
  profile,
  career,
  onAdd,
  onRemove,
  onBreakDown,
  onToggleTask,
  breakingEventId,
}: {
  events: StudyEvent[];
  assignments?: Assignment[];
  dailyTasks?: DailyTasksState | null;
  profile?: LearnerProfile | null;
  career?: string;
  onAdd: (e: StudyEvent) => void;
  onRemove: (id: string) => void;
  onBreakDown: (e: StudyEvent) => void;
  onToggleTask: (eventId: string, index: number) => void;
  breakingEventId: string | null;
}) {
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [kind, setKind] = useState<EventKind>("exam");

  const sorted = [...events].sort((a, b) => a.date.localeCompare(b.date));

  // Build a day-by-day SCHEDULE for the next 2 weeks: planned work sessions
  // (assignment planDates) + events, grouped by date, with per-day time totals.
  const todayISO = new Date().toISOString().slice(0, 10);
  const horizonISO = new Date(Date.now() + 14 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const schedule: Record<
    string,
    { work: Assignment[]; events: StudyEvent[]; tasks: DailyTask[]; min: number }
  > = {};
  const bucket = (iso: string) =>
    (schedule[iso] ||= { work: [], events: [], tasks: [], min: 0 });
  for (const a of assignments)
    if (!a.done && a.planDate && a.planDate >= todayISO && a.planDate <= horizonISO) {
      const b = bucket(a.planDate);
      b.work.push(a);
      b.min += a.estMin ?? 0;
    }
  for (const e of events)
    if (e.date >= todayISO && e.date <= horizonISO) bucket(e.date).events.push(e);
  // Today's to-do list lands on its own day too, so the schedule shows the day's
  // tasks alongside deadlines and planned work — not just as dots on the grid.
  if (
    dailyTasks?.date &&
    dailyTasks.date >= todayISO &&
    dailyTasks.date <= horizonISO
  )
    for (const t of dailyTasks.tasks) {
      const b = bucket(dailyTasks.date);
      b.tasks.push(t);
      b.min += t.estMin ?? 0;
    }
  const scheduleDays = Object.keys(schedule).sort();
  const weekday = (iso: string) =>
    new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", {
      weekday: "short",
    });
  const fmtMin = (m: number) =>
    m >= 60 ? `${Math.round((m / 60) * 10) / 10} hr` : `${m} min`;

  function submit() {
    if (!title.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    onAdd({ id: eventId(title, date), title: title.trim(), date, kind });
    setTitle("");
    setDate("");
    setKind("exam");
    setAdding(false);
  }

  return (
    <div style={styles.cal}>
      <div style={styles.planHead}>
        <span style={styles.planTitle}>📅 Calendar</span>
        <button style={styles.linkBtn} onClick={() => setAdding((a) => !a)}>
          {adding ? "Close" : "+ Add date"}
        </button>
      </div>

      {adding && (
        <div style={styles.calForm}>
          <input
            style={styles.calInput}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Biology final"
          />
          <div style={{ display: "flex", gap: 8 }}>
            <input
              style={{ ...styles.calInput, flex: 1 }}
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
            <select
              style={styles.calInput}
              value={kind}
              onChange={(e) => setKind(e.target.value as EventKind)}
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </div>
          <button
            onClick={submit}
            disabled={!title.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(date)}
            style={styles.calAddBtn}
          >
            Add
          </button>
        </div>
      )}

      <MonthGrid
        events={events}
        assignments={assignments}
        dailyTasks={dailyTasks}
        onPickDate={(iso) => {
          setDate(iso);
          setAdding(true);
        }}
      />

      {scheduleDays.length > 0 && (
        <div style={styles.schedBox}>
          <div style={styles.schedTitle}>🗓️ Your schedule (next 2 weeks)</div>
          {scheduleDays.map((iso) => {
            const day = schedule[iso];
            return (
              <div key={iso} style={styles.schedDay}>
                <div style={styles.schedDayHead}>
                  <span style={styles.schedDate}>
                    {weekday(iso)} · {formatDate(iso)}
                    {iso === todayISO ? " · Today" : ""}
                  </span>
                  {day.min > 0 && (
                    <span style={styles.schedTotal}>~{fmtMin(day.min)}</span>
                  )}
                </div>
                {day.events.map((e) => (
                  <div key={e.id} style={styles.schedItem}>
                    <span
                      style={{
                        ...styles.schedTick,
                        background: KIND_COLOR[e.kind ?? "other"],
                      }}
                    />
                    <span>
                      <b>{e.kind ?? "event"}:</b> {e.title}
                    </span>
                  </div>
                ))}
                {day.work.map((a) => (
                  <div key={a.id} style={styles.schedItem}>
                    <span
                      style={{ ...styles.schedTick, background: "#d98a2b" }}
                    />
                    <span>
                      ⏳ {a.title}
                      {a.estMin ? ` · ${fmtMin(a.estMin)}` : ""}
                      {a.due ? ` (due ${formatDate(a.due)})` : ""}
                    </span>
                  </div>
                ))}
                {day.tasks.map((t, i) => (
                  <div key={`task-${i}`} style={styles.schedItem}>
                    <span
                      style={{ ...styles.schedTick, background: "#6b5bd6" }}
                    />
                    <span
                      style={{
                        textDecoration: t.done ? "line-through" : "none",
                        color: t.done ? "var(--muted)" : undefined,
                      }}
                    >
                      📝 {t.title}
                      {t.estMin ? ` · ${fmtMin(t.estMin)}` : ""}
                      {t.done ? " ✓" : ""}
                    </span>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}

      {sorted.length === 0 ? (
        <p style={styles.calEmpty}>
          No dates yet. Tap a day above, add an exam or final, or just tell
          Eliora.
        </p>
      ) : (
        <div style={styles.planList}>
          {sorted.map((e) => (
            <div key={e.id}>
              <div style={styles.calRow}>
                <span
                  style={{
                    ...styles.calChip,
                    background: KIND_COLOR[e.kind ?? "other"],
                  }}
                >
                  {e.kind ?? "event"}
                </span>
                <span style={styles.calDate}>{formatDate(e.date)}</span>
                <span style={styles.calTitle}>{e.title}</span>
                <span style={styles.calCountdown}>{countdown(e.date)}</span>
                <button
                  style={styles.calRemove}
                  onClick={() => onRemove(e.id)}
                  aria-label={`Remove ${e.title}`}
                >
                  ×
                </button>
              </div>
              {e.tasks && e.tasks.length > 0 && (
                <div style={styles.goalTasks}>
                  <div style={styles.goalTasksHead}>
                    Prep steps · {e.tasks.filter((t) => t.done).length}/
                    {e.tasks.length}
                  </div>
                  {e.tasks.map((t, i) => (
                    <div key={i} style={styles.goalTaskRow}>
                      <button
                        style={{ ...styles.goalTaskToggle, flex: 1 }}
                        onClick={() => onToggleTask(e.id, i)}
                      >
                        <span
                          style={{
                            ...styles.checkbox,
                            borderColor: "var(--accent)",
                            background: t.done ? "var(--accent)" : "transparent",
                            color: t.done ? "#fff" : "transparent",
                          }}
                        >
                          ✓
                        </span>
                        <span
                          style={{
                            textDecoration: t.done ? "line-through" : "none",
                            color: t.done
                              ? "var(--muted)"
                              : "var(--assistant-text)",
                          }}
                        >
                          {t.title}
                        </span>
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <button
                style={styles.calStepBtn}
                onClick={() => onBreakDown(e)}
                disabled={breakingEventId === e.id}
                title="Break this into prep steps working back from the date"
              >
                {breakingEventId === e.id
                  ? "Breaking into steps…"
                  : e.tasks && e.tasks.length
                    ? "↻ Redo steps"
                    : "🪜 Break into steps"}
              </button>
            </div>
          ))}
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        <Suggestions
          kind="dates"
          label="💡 Suggest dates to add"
          body={{
            career,
            profile: profile ?? undefined,
            existing: events.map((e) => e.title),
          }}
          renderItem={(s, i, drop) => (
            <div key={i} style={styles.sugItem}>
              <div style={{ flex: 1 }}>
                <div style={styles.sugText}>{s.title}</div>
                <div style={styles.sugMeta}>
                  {s.kind ?? "event"}
                  {s.date ? ` · ${formatDate(s.date)}` : ""}
                  {s.why ? ` · ${s.why}` : ""}
                </div>
              </div>
              <button
                style={styles.fypAddPlan}
                onClick={() => {
                  if (s.title && s.date) {
                    onAdd({
                      id: eventId(s.title, s.date),
                      title: s.title,
                      date: s.date,
                      kind: (KINDS.includes(s.kind as EventKind)
                        ? s.kind
                        : "other") as EventKind,
                    });
                    drop();
                  }
                }}
              >
                ＋ Add
              </button>
            </div>
          )}
        />
      </div>
    </div>
  );
}

// True when the whole string is just a YouTube link (no surrounding prose) — so
// a link pasted into the text box can be summarized as a video, not as "notes".
function isBareYouTubeUrl(s: string): boolean {
  const t = s.trim();
  if (!t || /\s/.test(t)) return false;
  return /^(https?:\/\/)?(www\.|m\.)?(youtube\.com\/(watch\?|shorts\/|embed\/|live\/)|youtu\.be\/)\S+/i.test(
    t,
  );
}

// Upload a rubric + a project; Eliora grades the project against the rubric and
// returns a score + strengths + gaps per criterion, an overall grade, and next
// steps. Files (pdf/image/text) are read to base64 and posted to the API.
type GradeDoc = { name: string; base64: string; mediaType: string };
type CriterionScore = {
  criterion: string;
  evidence?: string;
  estimatedScore: string;
  strengths: string;
  gaps: string;
};
type ProjectFeedbackResult = {
  overallGrade: string;
  summary: string;
  criteria: CriterionScore[];
  topNextSteps: string[];
};

function ProjectGrader({ profile }: { profile: LearnerProfile }) {
  const [rubricDocs, setRubricDocs] = useState<GradeDoc[]>([]);
  const [projectDocs, setProjectDocs] = useState<GradeDoc[]>([]);
  const [rubricText, setRubricText] = useState("");
  const [projectText, setProjectText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<ProjectFeedbackResult | null>(null);

  const readFiles = (files: FileList) =>
    Promise.all(
      Array.from(files)
        .slice(0, 4)
        .map(
          (file) =>
            new Promise<GradeDoc>((resolve, reject) => {
              const r = new FileReader();
              r.onload = () => {
                const s = String(r.result);
                resolve({
                  name: file.name,
                  base64: s.slice(s.indexOf(",") + 1),
                  mediaType: file.type || "text/plain",
                });
              };
              r.onerror = reject;
              r.readAsDataURL(file);
            }),
        ),
    );

  async function onPick(which: "rubric" | "project", files: FileList | null) {
    if (!files?.length) return;
    const docs = await readFiles(files);
    if (which === "rubric") setRubricDocs(docs);
    else setProjectDocs(docs);
  }

  const hasRubric = rubricDocs.length > 0 || rubricText.trim().length > 0;
  const hasProject = projectDocs.length > 0 || projectText.trim().length > 0;
  const canRun = hasRubric && hasProject && !busy;

  async function run() {
    if (!canRun) return;
    setBusy(true);
    setError(null);
    setFeedback(null);
    try {
      const res = await fetch("/api/project-feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rubricDocs,
          rubricText: rubricText.trim() || undefined,
          projectDocs,
          projectText: projectText.trim() || undefined,
          profile,
        }),
      });
      const data = (await res.json()) as {
        feedback?: ProjectFeedbackResult;
        error?: string;
      };
      if (data.feedback?.criteria?.length) setFeedback(data.feedback);
      else
        setError(
          data.error === "missing_input"
            ? "Add both a rubric and your project first."
            : "Couldn't grade that — try clearer files or paste the text.",
        );
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={styles.tabPanel}>
      <div style={styles.modalHead}>
        <h2 style={styles.modalTitle}>Grade a project</h2>
      </div>
      <p style={styles.calEmpty}>
        Upload the rubric and your project — I&apos;ll grade it against the
        rubric and show you what to improve. (PDF, image, or text; you can paste
        instead.)
      </p>

      <div style={styles.outputLabel}>1. Rubric</div>
      <input
        type="file"
        multiple
        accept=".txt,.md,.pdf,image/*"
        onChange={(e) => onPick("rubric", e.target.files)}
      />
      {rubricDocs.length > 0 && (
        <p style={styles.calEmpty}>
          Selected: {rubricDocs.map((d) => d.name).join(", ")}
        </p>
      )}
      <textarea
        style={styles.modalTextarea}
        value={rubricText}
        onChange={(e) => setRubricText(e.target.value)}
        placeholder="…or paste the rubric here"
        rows={3}
      />

      <div style={styles.outputLabel}>2. Your project</div>
      <input
        type="file"
        multiple
        accept=".txt,.md,.pdf,image/*"
        onChange={(e) => onPick("project", e.target.files)}
      />
      {projectDocs.length > 0 && (
        <p style={styles.calEmpty}>
          Selected: {projectDocs.map((d) => d.name).join(", ")}
        </p>
      )}
      <textarea
        style={styles.modalTextarea}
        value={projectText}
        onChange={(e) => setProjectText(e.target.value)}
        placeholder="…or paste your project here"
        rows={4}
      />

      <button onClick={run} disabled={!canRun} style={styles.primaryBtn}>
        {busy ? "Grading…" : "Grade my project"}
      </button>

      {error && <p style={styles.resultText}>{error}</p>}

      {feedback && (
        <div style={styles.result}>
          <div style={styles.qaHead}>Estimated grade: {feedback.overallGrade}</div>
          {feedback.summary && (
            <div style={styles.resultMd}>{feedback.summary}</div>
          )}
          {feedback.criteria.map((c, i) => (
            <div key={i} style={styles.qaBox}>
              <div style={styles.qaHead}>
                {c.criterion} — {c.estimatedScore}
              </div>
              {c.evidence && (
                <div style={styles.resultText}>
                  <strong>Evidence:</strong> {c.evidence}
                </div>
              )}
              <div style={styles.resultText}>
                <strong>Strengths:</strong> {c.strengths}
              </div>
              <div style={styles.resultText}>
                <strong>To improve:</strong> {c.gaps}
              </div>
            </div>
          ))}
          {feedback.topNextSteps.length > 0 && (
            <div style={styles.qaBox}>
              <div style={styles.qaHead}>Next steps</div>
              <ul>
                {feedback.topNextSteps.map((s, i) => (
                  <li key={i} style={styles.resultText}>
                    {s}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p style={styles.calEmpty}>
            This is an estimate to help you improve — your teacher&apos;s grade
            may differ.
          </p>
        </div>
      )}
    </div>
  );
}

// A self-contained presentation-rehearsal recorder. Uses getUserMedia +
// MediaRecorder to capture the learner on camera+mic (or audio-only), keeps a
// list of takes they can replay/download, and shows an optional teleprompter
// script + practice tips. Nothing leaves the browser — takes live as object
// URLs in memory and are revoked on unmount.
type PracticeTake = {
  id: string;
  url: string;
  durationSec: number;
  createdAt: number;
  audioOnly: boolean;
};

const PRACTICE_TIPS = [
  "Open with a one-sentence hook so they know why to listen.",
  "Look at the camera lens, not your own face — that's eye contact.",
  "Pause instead of saying “um”; silence sounds confident.",
  "Slow down — you're almost always faster than it feels.",
  "End by restating your main point in one clear line.",
];

function fmtClock(totalSec: number) {
  const m = Math.floor(totalSec / 60);
  const s = Math.floor(totalSec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function PresentationPractice() {
  const liveVideoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef<number>(0);
  const takeAudioOnlyRef = useRef<boolean>(false);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [ready, setReady] = useState(false);
  const [starting, setStarting] = useState(false);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [audioOnly, setAudioOnly] = useState(false);
  const [takes, setTakes] = useState<PracticeTake[]>([]);
  const [activeTakeId, setActiveTakeId] = useState<string | null>(null);
  const [script, setScript] = useState("");
  const [showScript, setShowScript] = useState(false);

  // Mirror `takes` into a ref so the unmount cleanup (which runs with an empty
  // dep list) can revoke the latest object URLs, not just the initial empties.
  const takesRef = useRef<PracticeTake[]>([]);
  takesRef.current = takes;

  const supported =
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof window !== "undefined" &&
    typeof window.MediaRecorder !== "undefined";

  // Stop the camera/mic and clear the live preview.
  function stopStream() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (liveVideoRef.current) liveVideoRef.current.srcObject = null;
  }

  // Turn the camera + mic on and show the live preview (no recording yet).
  async function enableCamera() {
    if (starting) return;
    setError(null);
    setStarting(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: audioOnly ? false : { facingMode: "user" },
        audio: true,
      });
      streamRef.current = stream;
      if (liveVideoRef.current && !audioOnly) {
        liveVideoRef.current.srcObject = stream;
        liveVideoRef.current.muted = true;
        await liveVideoRef.current.play().catch(() => {});
      }
      setReady(true);
    } catch {
      setError(
        "I couldn't reach your camera or microphone. Allow access in your browser (the 🔒 icon in the address bar) and try again.",
      );
    } finally {
      setStarting(false);
    }
  }

  function startRecording() {
    const stream = streamRef.current;
    if (!stream) return;
    setError(null);
    chunksRef.current = [];
    takeAudioOnlyRef.current = audioOnly;
    // Pick a container the browser actually supports.
    const wanted = audioOnly
      ? ["audio/webm", "audio/mp4"]
      : ["video/webm;codecs=vp9,opus", "video/webm", "video/mp4"];
    const mimeType = wanted.find((t) => MediaRecorder.isTypeSupported(t));
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    } catch {
      setError("Your browser couldn't start recording. Try Chrome or Safari.");
      return;
    }
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    rec.onstop = () => {
      const type = rec.mimeType || (audioOnly ? "audio/webm" : "video/webm");
      const blob = new Blob(chunksRef.current, { type });
      const url = URL.createObjectURL(blob);
      const durationSec = Math.max(1, Math.round((Date.now() - startedAtRef.current) / 1000));
      const take: PracticeTake = {
        id: `take-${Date.now().toString(36)}`,
        url,
        durationSec,
        createdAt: Date.now(),
        audioOnly: takeAudioOnlyRef.current,
      };
      setTakes((prev) => [take, ...prev]);
      setActiveTakeId(take.id);
    };
    recorderRef.current = rec;
    startedAtRef.current = Date.now();
    setElapsed(0);
    rec.start();
    setRecording(true);
    tickRef.current = setInterval(() => {
      setElapsed(Math.round((Date.now() - startedAtRef.current) / 1000));
    }, 250);
  }

  function stopRecording() {
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
    recorderRef.current?.stop();
    recorderRef.current = null;
    setRecording(false);
  }

  function deleteTake(id: string) {
    setTakes((prev) => {
      const gone = prev.find((t) => t.id === id);
      if (gone) URL.revokeObjectURL(gone.url);
      return prev.filter((t) => t.id !== id);
    });
    setActiveTakeId((cur) => (cur === id ? null : cur));
  }

  // Re-init the live preview when toggling audio-only while the camera is on.
  useEffect(() => {
    if (!ready || recording) return;
    stopStream();
    setReady(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioOnly]);

  // Tear everything down on unmount so the camera light goes off and object
  // URLs don't leak.
  useEffect(() => {
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
      recorderRef.current?.stop();
      stopStream();
      takesRef.current.forEach((t) => URL.revokeObjectURL(t.url));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeTake = takes.find((t) => t.id === activeTakeId) ?? null;

  if (!supported) {
    return (
      <div style={styles.tabPanel}>
        <div style={styles.modalHead}>
          <h2 style={styles.modalTitle}>Practice a presentation</h2>
        </div>
        <p style={styles.calEmpty}>
          Recording isn&apos;t supported in this browser. Try the latest Chrome,
          Edge, or Safari on a device with a camera or microphone.
        </p>
      </div>
    );
  }

  return (
    <div style={styles.tabPanel}>
      <div style={styles.modalHead}>
        <h2 style={styles.modalTitle}>Practice a presentation</h2>
      </div>
      <p style={styles.calEmpty}>
        Record yourself rehearsing, then watch it back to see how you come
        across. Everything stays on your device — nothing is uploaded.
      </p>

      <div style={styles.practiceStage}>
        {audioOnly ? (
          <div style={styles.practiceAudioBox}>
            <div style={styles.practiceAudioIcon}>{recording ? "🎙️" : "🎧"}</div>
            <div style={styles.calEmpty}>
              {recording
                ? "Recording audio…"
                : ready
                  ? "Mic ready — press Record when you are."
                  : "Audio-only mode."}
            </div>
          </div>
        ) : (
          <video
            ref={liveVideoRef}
            style={styles.practiceVideo}
            playsInline
            muted
          />
        )}
        {recording && (
          <div style={styles.practiceRecDot}>
            <span style={styles.practiceRecPulse} /> REC {fmtClock(elapsed)}
          </div>
        )}
        {showScript && script.trim() && (
          <div style={styles.practiceTeleprompter}>{script}</div>
        )}
      </div>

      <label style={styles.practiceToggle}>
        <input
          type="checkbox"
          checked={audioOnly}
          disabled={recording}
          onChange={(e) => setAudioOnly(e.target.checked)}
        />
        Audio only (no camera)
      </label>

      <div style={styles.practiceControls}>
        {!ready && (
          <button
            onClick={enableCamera}
            disabled={starting}
            style={styles.primaryBtn}
          >
            {starting
              ? "Starting…"
              : audioOnly
                ? "Turn on mic"
                : "Turn on camera"}
          </button>
        )}
        {ready && !recording && (
          <button onClick={startRecording} style={styles.primaryBtn}>
            ⏺ Record
          </button>
        )}
        {recording && (
          <button onClick={stopRecording} style={styles.practiceStopBtn}>
            ⏹ Stop ({fmtClock(elapsed)})
          </button>
        )}
        {ready && !recording && (
          <button
            onClick={() => {
              stopStream();
              setReady(false);
            }}
            style={styles.secondaryBtn}
          >
            Turn off
          </button>
        )}
      </div>

      {error && <p style={styles.resultText}>{error}</p>}

      <div style={styles.outputLabel}>Notes / script (optional)</div>
      <textarea
        style={styles.modalTextarea}
        value={script}
        onChange={(e) => setScript(e.target.value)}
        placeholder="Paste or jot your talking points — turn on the teleprompter to see them over the video while you record."
        rows={3}
      />
      {script.trim() && (
        <label style={styles.practiceToggle}>
          <input
            type="checkbox"
            checked={showScript}
            onChange={(e) => setShowScript(e.target.checked)}
          />
          Show notes as a teleprompter over the video
        </label>
      )}

      {activeTake && (
        <div style={styles.result}>
          <div style={styles.qaHead}>
            Your take · {fmtClock(activeTake.durationSec)}
          </div>
          {activeTake.audioOnly ? (
            <audio src={activeTake.url} controls style={{ width: "100%" }} />
          ) : (
            <video
              src={activeTake.url}
              controls
              playsInline
              style={styles.practiceVideo}
            />
          )}
          <div style={styles.practiceControls}>
            <a
              href={activeTake.url}
              download={`practice-${activeTake.id}.webm`}
              style={{ ...styles.secondaryBtn, textDecoration: "none" }}
            >
              ⬇ Download
            </a>
            <button
              onClick={() => deleteTake(activeTake.id)}
              style={styles.secondaryBtn}
            >
              Delete take
            </button>
          </div>
        </div>
      )}

      {takes.length > 1 && (
        <>
          <div style={styles.outputLabel}>Your takes</div>
          <div style={styles.practiceTakeRow}>
            {takes.map((t, i) => (
              <button
                key={t.id}
                onClick={() => setActiveTakeId(t.id)}
                style={{
                  ...styles.practiceTakeChip,
                  ...(t.id === activeTakeId
                    ? styles.practiceTakeChipActive
                    : {}),
                }}
              >
                {t.audioOnly ? "🎧" : "🎬"} Take {takes.length - i} ·{" "}
                {fmtClock(t.durationSec)}
              </button>
            ))}
          </div>
        </>
      )}

      <div style={styles.result}>
        <div style={styles.qaHead}>Delivery tips</div>
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {PRACTICE_TIPS.map((tip, i) => (
            <li key={i} style={styles.resultText}>
              {tip}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// The shape the /api/school-import route returns (mirrors SchoolImport in
// @eliora/shared; page.tsx keeps its own client-side copies of these types).
type SchoolImportItem = {
  type: "assignment" | "event";
  title: string;
  date?: string;
  subject?: string;
  kind?: "exam" | "final" | "quiz" | "assignment" | "other";
};
type SchoolCourseGrade = { course: string; grade: string };
type SchoolImportResult = {
  items: SchoolImportItem[];
  classes: string[];
  grades: SchoolCourseGrade[];
};

// "Connect your school" — pull assignments, due dates, classes, and grades in
// from ANY school app (Google Classroom, Canvas, Schoology, PowerSchool…)
// WITHOUT accounts or OAuth. Two paths, both reviewed before anything is added:
//   • a calendar feed — paste an .ics link or drop the .ics file
//   • paste — copy the portal / a CSV / a grade report; the AI route pulls it apart
// Everything imported lands in the app's existing assignments / calendar /
// subjects stores (all still client-side). Grades have no store of their own, so
// they're handed to Eliora in chat instead.
function SchoolConnect({
  profile,
  onAddAssignment,
  onAddEvent,
  onAddSubject,
  onShareGrades,
}: {
  profile: LearnerProfile | null;
  onAddAssignment: (a: { title: string; subject?: string; due?: string }) => void;
  onAddEvent: (e: StudyEvent) => void;
  onAddSubject: (name: string) => void;
  onShareGrades: (grades: SchoolCourseGrade[]) => void;
}) {
  const [mode, setMode] = useState<"link" | "paste">("link");
  const [icsUrl, setIcsUrl] = useState("");
  const [paste, setPaste] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [result, setResult] = useState<SchoolImportResult | null>(null);
  const [pickedItems, setPickedItems] = useState<Set<number>>(new Set());
  const [pickedClasses, setPickedClasses] = useState<Set<string>>(new Set());
  const [imported, setImported] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  function receive(data: {
    import?: SchoolImportResult;
    error?: string;
    note?: string;
  }) {
    if (data.error) {
      setError(data.error);
      setResult(null);
      return;
    }
    const r = data.import ?? { items: [], classes: [], grades: [] };
    setResult(r);
    setNote(data.note ?? null);
    // Everything is pre-selected — the learner unchecks what they don't want.
    setPickedItems(new Set(r.items.map((_, i) => i)));
    setPickedClasses(new Set(r.classes));
    setImported(null);
  }

  async function run(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    setNote(null);
    setImported(null);
    try {
      const res = await fetch("/api/school-import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, profile: profile ?? undefined }),
      });
      receive(await res.json());
    } catch {
      setError("Something went wrong — try again.");
    } finally {
      setBusy(false);
    }
  }

  function importLink() {
    if (!icsUrl.trim() || busy) return;
    run({ mode: "ics", icsUrl: icsUrl.trim() });
  }
  function importPaste() {
    if (paste.trim().length < 4 || busy) return;
    run({ mode: "paste", text: paste.trim() });
  }
  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => run({ mode: "ics", icsText: String(reader.result ?? "") });
    reader.readAsText(f);
    if (fileRef.current) fileRef.current.value = "";
  }

  function toggleItem(i: number) {
    setPickedItems((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }
  function toggleClass(name: string) {
    setPickedClasses((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function doImport() {
    if (!result) return;
    let added = 0;
    result.classes.forEach((c) => {
      if (pickedClasses.has(c)) {
        onAddSubject(c);
        added++;
      }
    });
    result.items.forEach((it, i) => {
      if (!pickedItems.has(i)) return;
      if (it.type === "assignment") {
        onAddAssignment({ title: it.title, subject: it.subject, due: it.date });
      } else {
        onAddEvent({
          id: `ev${Date.now().toString(36)}${i}`,
          title: it.title,
          date: it.date ?? "",
          kind: (it.kind as StudyEvent["kind"]) ?? "other",
        });
      }
      added++;
    });
    setImported(
      added > 0
        ? `Added ${added} item${added === 1 ? "" : "s"} to your planner ✓`
        : "Nothing selected.",
    );
  }

  const kindEmoji: Record<string, string> = {
    exam: "📝",
    final: "🎓",
    quiz: "❓",
    assignment: "📌",
    project: "📊",
    other: "📅",
  };
  const dateLabel = (d?: string) => {
    if (!d) return "no date";
    const [y, m, day] = d.split("-");
    return `${m}/${day}/${y.slice(2)}`;
  };

  const box: React.CSSProperties = {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 16,
    padding: 18,
    marginBottom: 16,
  };
  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "11px 13px",
    borderRadius: 10,
    border: "1px solid var(--border)",
    background: "var(--bg)",
    color: "var(--text)",
    fontSize: 15,
  };

  const assignments = (result?.items ?? []).filter((i) => i.type === "assignment");
  const events = (result?.items ?? []).filter((i) => i.type === "event");
  const hasResult =
    result &&
    (result.items.length > 0 ||
      result.classes.length > 0 ||
      result.grades.length > 0);

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: "8px 4px 40px" }}>
      <h2 style={{ fontSize: 24, fontWeight: 800, margin: "4px 0 6px" }}>
        🏫 Connect your school
      </h2>
      <p style={{ color: "var(--muted)", margin: "0 0 18px", lineHeight: 1.5 }}>
        Bring your assignments, due dates, classes, and grades in from Google
        Classroom, Canvas, Schoology, PowerSchool, or any school app — no login
        needed. Import your class calendar, or just paste from your portal.
      </p>

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        {(
          [
            ["link", "🔗 Calendar link / file"],
            ["paste", "📋 Paste from portal"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setMode(key)}
            style={{
              padding: "9px 14px",
              borderRadius: 999,
              border: "1px solid var(--border)",
              background: mode === key ? "var(--accent)" : "transparent",
              color: mode === key ? "#fff" : "var(--text)",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {mode === "link" && (
        <div style={box}>
          <label
            style={{ display: "block", fontWeight: 600, marginBottom: 8 }}
          >
            Paste your class calendar link
          </label>
          <input
            style={inputStyle}
            placeholder="webcal://…  or  https://…/calendar.ics"
            value={icsUrl}
            onChange={(e) => setIcsUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && importLink()}
          />
          <div
            style={{
              display: "flex",
              gap: 10,
              marginTop: 12,
              flexWrap: "wrap",
            }}
          >
            <button
              onClick={importLink}
              disabled={busy || !icsUrl.trim()}
              style={{
                padding: "10px 18px",
                borderRadius: 10,
                border: "none",
                background: "var(--accent)",
                color: "#fff",
                fontWeight: 700,
                cursor: busy ? "default" : "pointer",
                opacity: busy || !icsUrl.trim() ? 0.6 : 1,
              }}
            >
              {busy ? "Reading…" : "Import calendar"}
            </button>
            <button
              onClick={() => fileRef.current?.click()}
              disabled={busy}
              style={{
                padding: "10px 18px",
                borderRadius: 10,
                border: "1px solid var(--border)",
                background: "transparent",
                color: "var(--text)",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              …or upload an .ics file
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".ics,text/calendar"
              onChange={onFile}
              style={{ display: "none" }}
            />
          </div>
          <details style={{ marginTop: 14, color: "var(--muted)", fontSize: 14 }}>
            <summary style={{ cursor: "pointer" }}>
              Where do I find my calendar link?
            </summary>
            <ul style={{ margin: "8px 0 0", paddingLeft: 18, lineHeight: 1.6 }}>
              <li>
                <b>Google Classroom:</b> open Classroom → Calendar → in Google
                Calendar, Settings → your class calendar → “Secret address in
                iCal format”.
              </li>
              <li>
                <b>Canvas:</b> Calendar → “Calendar Feed” (bottom-right) → copy
                the webcal link.
              </li>
              <li>
                <b>Schoology:</b> Calendar → gear/settings → “iCal Feed”.
              </li>
              <li>
                <b>PowerSchool:</b> Grades / Class Registration → look for a
                calendar / iCal export, or just paste from the portal instead.
              </li>
            </ul>
          </details>
        </div>
      )}

      {mode === "paste" && (
        <div style={box}>
          <label
            style={{ display: "block", fontWeight: 600, marginBottom: 8 }}
          >
            Paste anything from your school portal
          </label>
          <textarea
            style={{ ...inputStyle, minHeight: 150, resize: "vertical" }}
            placeholder={
              "Copy your assignment list, class schedule, or grade report and paste it here.\n\ne.g.\nAP Biology — Lab report due Sep 18\nAlgebra II quiz Friday\nEnglish: A-, Chemistry: 88%"
            }
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
          />
          <button
            onClick={importPaste}
            disabled={busy || paste.trim().length < 4}
            style={{
              marginTop: 12,
              padding: "10px 18px",
              borderRadius: 10,
              border: "none",
              background: "var(--accent)",
              color: "#fff",
              fontWeight: 700,
              cursor: busy ? "default" : "pointer",
              opacity: busy || paste.trim().length < 4 ? 0.6 : 1,
            }}
          >
            {busy ? "Reading…" : "Find my school stuff"}
          </button>
        </div>
      )}

      {error && (
        <div
          style={{
            ...box,
            borderColor: "var(--accent)",
            color: "var(--text)",
          }}
        >
          {error}
        </div>
      )}

      {hasResult && (
        <div style={box}>
          {note && (
            <p style={{ color: "var(--muted)", marginTop: 0 }}>{note}</p>
          )}

          {result!.classes.length > 0 && (
            <div style={{ marginBottom: 18 }}>
              <div style={{ fontWeight: 700, marginBottom: 8 }}>
                Classes ({result!.classes.length})
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {result!.classes.map((c) => {
                  const on = pickedClasses.has(c);
                  return (
                    <button
                      key={c}
                      onClick={() => toggleClass(c)}
                      style={{
                        padding: "6px 12px",
                        borderRadius: 999,
                        border: "1px solid var(--border)",
                        background: on ? "var(--accent)" : "transparent",
                        color: on ? "#fff" : "var(--text)",
                        cursor: "pointer",
                        fontSize: 14,
                      }}
                    >
                      {on ? "✓ " : ""}
                      {c}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {[
            ["📌 Assignments", assignments],
            ["📅 Calendar events", events],
          ].map(([heading, list]) => {
            const items = list as SchoolImportItem[];
            if (!items.length) return null;
            return (
              <div key={heading as string} style={{ marginBottom: 18 }}>
                <div style={{ fontWeight: 700, marginBottom: 8 }}>
                  {heading as string} ({items.length})
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {items.map((it) => {
                    const idx = result!.items.indexOf(it);
                    const on = pickedItems.has(idx);
                    return (
                      <label
                        key={idx}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                          padding: "8px 10px",
                          borderRadius: 10,
                          border: "1px solid var(--border)",
                          background: on ? "var(--bg)" : "transparent",
                          opacity: on ? 1 : 0.55,
                          cursor: "pointer",
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => toggleItem(idx)}
                        />
                        <span style={{ fontSize: 16 }}>
                          {kindEmoji[it.kind ?? "other"] ?? "📌"}
                        </span>
                        <span style={{ flex: 1 }}>{it.title}</span>
                        {it.subject && (
                          <span
                            style={{
                              fontSize: 12,
                              color: "var(--muted)",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {it.subject}
                          </span>
                        )}
                        <span
                          style={{
                            fontSize: 13,
                            color: "var(--muted)",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {dateLabel(it.date)}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            );
          })}

          <button
            onClick={doImport}
            style={{
              padding: "11px 20px",
              borderRadius: 10,
              border: "none",
              background: "var(--accent)",
              color: "#fff",
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            ＋ Add selected to my planner
          </button>
          {imported && (
            <span style={{ marginLeft: 12, color: "var(--accent)", fontWeight: 600 }}>
              {imported}
            </span>
          )}

          {result!.grades.length > 0 && (
            <div style={{ marginTop: 20, paddingTop: 16, borderTop: "1px solid var(--border)" }}>
              <div style={{ fontWeight: 700, marginBottom: 8 }}>
                Grades ({result!.grades.length})
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
                {result!.grades.map((g, i) => (
                  <span
                    key={i}
                    style={{
                      padding: "5px 11px",
                      borderRadius: 999,
                      background: "var(--bg)",
                      border: "1px solid var(--border)",
                      fontSize: 14,
                    }}
                  >
                    {g.course}: <b>{g.grade}</b>
                  </span>
                ))}
              </div>
              <button
                onClick={() => onShareGrades(result!.grades)}
                style={{
                  padding: "9px 16px",
                  borderRadius: 10,
                  border: "1px solid var(--border)",
                  background: "transparent",
                  color: "var(--text)",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                💬 Share these grades with Eliora
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// A persistent focus-music mini-player. Lives at the app shell so it keeps
// playing while the learner moves between tabs. They paste a Spotify / Apple
// Music / YouTube Music playlist link (auto-detected) and it plays inline via
// that service's official embed — no accounts, no API keys, never leaving the
// app. Saved playlists persist in localStorage (namespaced by learner).
function FocusMusicPlayer({ storageKey }: { storageKey: string }) {
  const [sources, setSources] = useState<MusicSource[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [open, setOpen] = useState(false); // player panel expanded?
  const [dismissed, setDismissed] = useState(false); // hidden to just the FAB?
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  // Load saved playlists once.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const saved = JSON.parse(raw) as {
          sources?: MusicSource[];
          activeId?: string | null;
        };
        if (Array.isArray(saved.sources)) {
          setSources(saved.sources);
          setActiveId(saved.activeId ?? saved.sources[0]?.id ?? null);
        }
      }
    } catch {
      /* ignore */
    }
    setLoaded(true);
  }, [storageKey]);

  // Persist on change.
  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify({ sources, activeId }));
    } catch {
      /* ignore */
    }
  }, [sources, activeId, loaded, storageKey]);

  const active = sources.find((s) => s.id === activeId) ?? null;

  function addSource() {
    const parsed = parseMusicUrl(input);
    if (!parsed) {
      setError(
        "That link didn't look like a Spotify, Apple Music, or YouTube Music playlist. Copy the playlist's share link and paste it here.",
      );
      return;
    }
    // Skip exact duplicates (same embed) — just make it the active one.
    const dup = sources.find((s) => s.embedUrl === parsed.embedUrl);
    if (dup) {
      setActiveId(dup.id);
      setInput("");
      setError(null);
      setOpen(true);
      return;
    }
    const src: MusicSource = {
      ...parsed,
      id: `m${Date.now().toString(36)}`,
    };
    setSources((prev) => [src, ...prev]);
    setActiveId(src.id);
    setInput("");
    setError(null);
    setOpen(true);
  }

  function removeSource(id: string) {
    setSources((prev) => {
      const next = prev.filter((s) => s.id !== id);
      if (id === activeId) setActiveId(next[0]?.id ?? null);
      return next;
    });
  }

  // Collapsed to a floating button once dismissed (or before first use, if the
  // learner closes it) — one tap brings the player back.
  if (dismissed) {
    return (
      <button
        style={styles.musicFab}
        onClick={() => setDismissed(false)}
        aria-label="Open focus music"
        title="Focus music"
      >
        🎧
      </button>
    );
  }

  const meta = active ? MUSIC_PROVIDERS[active.provider] : null;

  return (
    <div style={styles.musicPlayer} className="fade-in">
      <div style={styles.musicHeader}>
        <button
          style={styles.musicTitleBtn}
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          title={open ? "Collapse" : "Expand"}
        >
          <span style={{ fontSize: 16 }}>🎧</span>
          <span style={styles.musicTitleText}>
            {active
              ? `${meta?.icon} ${active.title || active.kind}`
              : "Focus music"}
          </span>
          <span style={{ color: "var(--muted)" }}>{open ? "▾" : "▸"}</span>
        </button>
        <button
          style={styles.musicClose}
          onClick={() => setDismissed(true)}
          aria-label="Hide focus music"
          title="Hide"
        >
          ×
        </button>
      </div>

      {open && (
        <div style={styles.musicBody}>
          {/* Connect a playlist */}
          <div style={styles.musicConnectRow}>
            <input
              style={styles.musicInput}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                if (error) setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") addSource();
              }}
              placeholder="Paste a playlist link…"
              aria-label="Paste a Spotify, Apple Music, or YouTube Music playlist link"
            />
            <button style={styles.musicAddBtn} onClick={addSource}>
              Connect
            </button>
          </div>
          <div style={styles.musicHint}>
            {(Object.keys(MUSIC_PROVIDERS) as MusicProvider[]).map((p) => (
              <span key={p} style={styles.musicHintChip}>
                {MUSIC_PROVIDERS[p].icon} {MUSIC_PROVIDERS[p].label}
              </span>
            ))}
          </div>
          {error && <div style={styles.musicError}>{error}</div>}

          {/* Saved playlists to switch between */}
          {sources.length > 0 && (
            <div style={styles.musicTabs}>
              {sources.map((s) => {
                const m = MUSIC_PROVIDERS[s.provider];
                const on = s.id === activeId;
                return (
                  <span key={s.id} style={styles.musicTabWrap}>
                    <button
                      style={{
                        ...styles.musicTab,
                        ...(on ? styles.musicTabActive : {}),
                      }}
                      onClick={() => setActiveId(s.id)}
                      title={s.url}
                    >
                      <span>{m.icon}</span>
                      <span style={styles.musicTabLabel}>
                        {s.title || s.kind}
                      </span>
                    </button>
                    <button
                      style={styles.musicTabDel}
                      onClick={() => removeSource(s.id)}
                      aria-label={`Remove ${s.title || s.kind}`}
                      title="Remove"
                    >
                      ×
                    </button>
                  </span>
                );
              })}
            </div>
          )}

          {/* The inline player */}
          {active ? (
            <div style={styles.musicEmbedWrap}>
              <iframe
                key={active.id}
                title={`${meta?.label} player`}
                src={active.embedUrl}
                height={musicEmbedHeight(active.provider, active.kind)}
                style={styles.musicEmbed}
                frameBorder={0}
                allow="autoplay; encrypted-media; fullscreen; clipboard-write; picture-in-picture"
                allowFullScreen
                loading="lazy"
              />
              <a
                href={active.url}
                target="_blank"
                rel="noopener noreferrer"
                style={styles.musicOpenLink}
              >
                Open in {meta?.label} ↗
              </a>
            </div>
          ) : (
            <p style={styles.musicEmpty}>
              🎵 Paste a link to your favorite study playlist above — it plays
              right here while you work.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Summarizer({
  profile,
  onClose,
  onAddToChat,
  onStudyGuide,
}: {
  profile: LearnerProfile;
  onClose?: () => void;
  onAddToChat: (msg: {
    content: string;
    flashcards?: Flashcard[];
    quiz?: QuizQuestion[];
  }) => void;
  onStudyGuide?: (detail: string) => void;
}) {
  const [tab, setTab] = useState<"text" | "video" | "doc">("text");
  const [output, setOutput] = useState<
    "summary" | "studyguide" | "flashcards" | "quiz"
  >("summary");
  // Which flashcard format to generate (only used when output = "flashcards").
  const [flashStyle, setFlashStyle] = useState<FlashcardStyle>("basic");
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<{
    name: string;
    base64?: string;
    mediaType?: string;
    text?: string;
  } | null>(null);
  const [result, setResult] = useState("");
  const [cards, setCards] = useState<Flashcard[] | null>(null);
  const [quiz, setQuiz] = useState<QuizQuestion[] | null>(null);
  const [busy, setBusy] = useState(false);
  // Follow-up Q&A about the generated notes (summary / study guide only).
  const [qa, setQa] = useState<{ role: "user" | "assistant"; content: string }[]>(
    [],
  );
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  // Practice questions generated from the notes Eliora just wrote (as opposed to
  // the "Quiz" output, which is built from the raw source material).
  const [noteQuiz, setNoteQuiz] = useState<QuizQuestion[] | null>(null);
  const [makingQuiz, setMakingQuiz] = useState(false);

  function onPickFile(f: File) {
    const isText =
      f.type.startsWith("text/") || /\.(txt|md|markdown)$/i.test(f.name);
    const reader = new FileReader();
    if (isText) {
      reader.onload = () =>
        setFile({ name: f.name, text: String(reader.result ?? "") });
      reader.readAsText(f);
    } else {
      reader.onload = () => {
        const dataUrl = String(reader.result ?? "");
        const base64 = dataUrl.split(",")[1] ?? "";
        setFile({ name: f.name, base64, mediaType: f.type });
      };
      reader.readAsDataURL(f);
    }
  }

  const canRun =
    (tab === "text" && text.trim().length >= 20) ||
    (tab === "video" && url.trim().length > 0) ||
    (tab === "doc" && !!file);

  async function run() {
    if (!canRun || busy) return;
    setBusy(true);
    setResult("");
    setCards(null);
    setQuiz(null);
    setQa([]);
    setQuestion("");
    setNoteQuiz(null);
    // If someone pastes a bare YouTube link into the text box, treat it as a
    // video instead of trying to "summarize" the URL text (which can't work).
    const looksLikeBareYouTube =
      tab === "text" && isBareYouTubeUrl(text.trim());
    const src =
      tab === "video" || looksLikeBareYouTube
        ? { source: "video", url: tab === "video" ? url : text.trim() }
        : tab === "text"
          ? { source: "text", text }
          : {
              source: "doc",
              fileBase64: file?.base64,
              fileMediaType: file?.mediaType,
              fileName: file?.name,
              text: file?.text,
            };
    try {
      const res = await fetch("/api/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...src,
          output,
          profile,
          ...(output === "flashcards" ? { flashcardStyle: flashStyle } : {}),
        }),
      });
      if (output === "flashcards" || output === "quiz") {
        const data = await res.json();
        if (data.error) setResult(data.error);
        else if (output === "flashcards") setCards(data.flashcards ?? []);
        else setQuiz(data.quiz ?? []);
      } else {
        if (!res.body) throw new Error("no stream");
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let acc = "";
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          acc += decoder.decode(value, { stream: true });
          setResult(acc);
        }
      }
    } catch {
      setResult("Sorry, something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function ask() {
    const q = question.trim();
    if (!q || asking || !result) return;
    setAsking(true);
    setQuestion("");
    // Show the question immediately, plus a placeholder that streams in.
    const history = qa;
    setQa([...history, { role: "user", content: q }, { role: "assistant", content: "" }]);
    try {
      const res = await fetch("/api/notes-qa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes: result, question: q, history, profile }),
      });
      if (!res.body) throw new Error("no stream");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let acc = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        acc += decoder.decode(value, { stream: true });
        setQa([
          ...history,
          { role: "user", content: q },
          { role: "assistant", content: acc },
        ]);
      }
    } catch {
      setQa([
        ...history,
        { role: "user", content: q },
        { role: "assistant", content: "Sorry, I couldn't answer that. Please try again." },
      ]);
    } finally {
      setAsking(false);
    }
  }

  // Turn the notes Eliora just wrote into a practice quiz. Reuses the summarize
  // endpoint's quiz path, feeding the generated notes back in as the material.
  async function makeQuestions() {
    if (!result || makingQuiz) return;
    setMakingQuiz(true);
    setNoteQuiz(null);
    try {
      const res = await fetch("/api/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "text",
          text: result,
          output: "quiz",
          profile,
        }),
      });
      const data = await res.json();
      setNoteQuiz(data.quiz ?? []);
    } catch {
      setNoteQuiz([]);
    } finally {
      setMakingQuiz(false);
    }
  }

  return (
    <div style={styles.tabPanel}>
        {onClose && (
          <div style={styles.modalHead}>
            <h2 style={styles.modalTitle}>Summarize notes</h2>
            <button style={styles.linkBtn} onClick={onClose}>
              Close
            </button>
          </div>
        )}

        <div style={styles.tabs}>
          {(["text", "video", "doc"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                ...styles.tab,
                ...(tab === t ? styles.tabActive : {}),
              }}
            >
              {t === "text" ? "Notes / text" : t === "video" ? "Video" : "Doc"}
            </button>
          ))}
        </div>

        {tab === "text" && (
          <textarea
            style={styles.modalTextarea}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Paste your notes or any text here…"
            rows={6}
          />
        )}
        {tab === "video" && (
          <div>
            <input
              style={styles.formInput}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="Paste a YouTube link…"
            />
            <p style={styles.calEmpty}>
              I'll try to fetch the captions. YouTube often blocks this — if it
              fails, open the video's transcript (“…more” → “Show transcript”),
              copy it, and paste it into the “Notes / text” tab.
            </p>
          </div>
        )}
        {tab === "doc" && (
          <div>
            <input
              type="file"
              accept=".txt,.md,.pdf,image/*"
              onChange={(e) => e.target.files?.[0] && onPickFile(e.target.files[0])}
            />
            {file && <p style={styles.calEmpty}>Selected: {file.name}</p>}
            <p style={styles.calEmpty}>PDF, image, or text file.</p>
          </div>
        )}

        <div style={styles.outputLabel}>Make from this material:</div>
        <div style={styles.outputRow}>
          {(
            [
              ["summary", "📝 Summary"],
              ["studyguide", "📚 Study guide"],
              ["flashcards", "🃏 Flashcards"],
              ["quiz", "📋 Quiz"],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setOutput(k)}
              style={{ ...styles.outChip, ...(output === k ? styles.outChipActive : {}) }}
            >
              {label}
            </button>
          ))}
        </div>

        {output === "flashcards" && (
          <>
            <div style={styles.outputLabel}>Flashcard style:</div>
            <div style={styles.outputRow}>
              {FLASHCARD_STYLES.map((s) => (
                <button
                  key={s.key}
                  onClick={() => setFlashStyle(s.key)}
                  title={`${s.front} → ${s.back}`}
                  style={{
                    ...styles.outChip,
                    ...(flashStyle === s.key ? styles.outChipActive : {}),
                  }}
                >
                  {s.emoji} {s.label}
                </button>
              ))}
            </div>
          </>
        )}

        <button onClick={run} disabled={!canRun || busy} style={styles.primaryBtn}>
          {busy
            ? "Working…"
            : output === "summary"
              ? "Summarize"
              : output === "studyguide"
                ? "Make study guide"
                : output === "flashcards"
                  ? "Make flashcards"
                  : "Make quiz"}
        </button>

        {(result || cards || quiz) && (
          <div style={styles.result}>
            {cards ? (
              cards.length ? (
                <FlashcardDeck cards={cards} onMissed={() => {}} />
              ) : (
                <div style={styles.resultText}>No flashcards — try more material.</div>
              )
            ) : quiz ? (
              quiz.length ? (
                <QuizView quiz={quiz} onMissed={() => {}} onStudyGuide={onStudyGuide} />
              ) : (
                <div style={styles.resultText}>No quiz — try more material.</div>
              )
            ) : (
              <div style={styles.resultMd}>
                {renderMarkdown(result, "var(--accent)")}
              </div>
            )}
            <div style={styles.formActions}>
              {!cards && !quiz && (
                <button
                  style={styles.secondaryBtn}
                  onClick={() => navigator.clipboard?.writeText(result)}
                >
                  Copy
                </button>
              )}
              {!cards && !quiz && result && (
                <ShareButton
                  payload={{
                    v: 1,
                    kind: "note",
                    title: noteTitle(result),
                    text: result,
                  }}
                  label="Share with a friend"
                />
              )}
              {!cards && !quiz && result && !busy && (
                <button
                  style={styles.secondaryBtn}
                  onClick={makeQuestions}
                  disabled={makingQuiz}
                >
                  {makingQuiz ? "Writing questions…" : "📋 Make questions"}
                </button>
              )}
              <button
                style={styles.primaryBtn}
                onClick={() => {
                  if (cards?.length)
                    onAddToChat({
                      content: "Here are flashcards from your material:",
                      flashcards: cards,
                    });
                  else if (quiz?.length)
                    onAddToChat({
                      content: "Here's a quiz from your material:",
                      quiz,
                    });
                  else onAddToChat({ content: result });
                  onClose?.();
                }}
              >
                Add to chat
              </button>
            </div>

            {/* Practice questions written from the notes above. */}
            {!cards && !quiz && noteQuiz && (
              <div style={styles.qaBox}>
                <div style={styles.qaHead}>📋 Questions from these notes</div>
                {noteQuiz.length ? (
                  <QuizView
                    quiz={noteQuiz}
                    onMissed={() => {}}
                    onStudyGuide={onStudyGuide}
                  />
                ) : (
                  <div style={styles.resultText}>
                    I couldn&apos;t write questions from these notes — try a longer
                    summary or study guide.
                  </div>
                )}
              </div>
            )}

            {/* Follow-up Q&A grounded in the generated notes. */}
            {!cards && !quiz && result && !busy && (
              <div style={styles.qaBox}>
                <div style={styles.qaHead}>💬 Ask about these notes</div>
                {qa.map((m, i) => (
                  <div
                    key={i}
                    style={m.role === "user" ? styles.qaUser : styles.qaBot}
                  >
                    {m.role === "user" ? (
                      m.content
                    ) : m.content ? (
                      <div style={styles.resultMd}>
                        {renderMarkdown(m.content, "var(--accent)")}
                      </div>
                    ) : (
                      "Thinking…"
                    )}
                  </div>
                ))}
                <div style={styles.qaInputRow}>
                  <input
                    style={styles.formInput}
                    value={question}
                    onChange={(e) => setQuestion(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") ask();
                    }}
                    placeholder="e.g. Can you explain the second point more simply?"
                  />
                  <button
                    style={styles.primaryBtn}
                    onClick={ask}
                    disabled={asking || !question.trim()}
                  >
                    {asking ? "…" : "Ask"}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
    </div>
  );
}

// A small "Share" button that hands a deck/note to the native share sheet (or
// copies a link) so it can be sent to a friend. Shows brief confirmation text.
function ShareButton({
  payload,
  label = "Share",
  style,
}: {
  payload: SharePayload;
  label?: string;
  style?: React.CSSProperties;
}) {
  const [status, setStatus] = useState<"idle" | "shared" | "copied" | "error">(
    "idle",
  );
  return (
    <button
      style={{ ...styles.secondaryBtn, ...style }}
      title="Share with a friend"
      onClick={async () => {
        const r = await shareContent(payload);
        setStatus(r);
        window.setTimeout(() => setStatus("idle"), 2000);
      }}
    >
      {status === "copied"
        ? "Link copied ✓"
        : status === "shared"
          ? "Shared ✓"
          : status === "error"
            ? "Couldn’t share"
            : `🔗 ${label}`}
    </button>
  );
}

function FlashcardDeck({
  cards,
  onMissed,
  onMistake,
  title,
}: {
  cards: Flashcard[];
  onMissed: (topic: string) => void;
  onMistake?: (card: Flashcard) => void;
  title?: string;
}) {
  const [i, setI] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const card = cards[i];
  if (!card) return null;
  const meta = flashcardStyleMeta(card.style);

  function go(delta: number) {
    setFlipped(false);
    setI((n) => Math.max(0, Math.min(cards.length - 1, n + delta)));
  }

  return (
    <div style={styles.toolBox}>
      <div style={styles.toolHead}>
        <span style={styles.toolTitle}>🃏 Flashcards</span>
        <span style={styles.planCount}>
          {i + 1}/{cards.length}
        </span>
      </div>
      <button
        style={styles.flashcard}
        onClick={() => setFlipped((f) => !f)}
        aria-label="Flip card"
      >
        <span style={styles.flashcardLabel}>
          {flipped ? meta.back : meta.front}
        </span>
        <span style={styles.flashcardText}>{flipped ? card.back : card.front}</span>
        <span style={styles.flashcardHint}>
          {meta.emoji} {meta.label} · tap to flip
        </span>
      </button>
      <div style={styles.flashNav}>
        <button style={styles.secondaryBtn} disabled={i === 0} onClick={() => go(-1)}>
          ← Prev
        </button>
        <button
          style={styles.linkBtn}
          onClick={() => {
            onMissed(card.front);
            onMistake?.(card);
          }}
          title="Mark for revision"
        >
          Still learning
        </button>
        <button
          style={styles.secondaryBtn}
          disabled={i === cards.length - 1}
          onClick={() => go(1)}
        >
          Next →
        </button>
      </div>
      <div style={styles.flashShareRow}>
        <ShareButton
          payload={{ v: 1, kind: "flashcards", title, cards }}
          label="Share deck with a friend"
        />
      </div>
    </div>
  );
}

function QuizView({
  quiz,
  onMissed,
  onMistake,
  onStudyGuide,
}: {
  quiz: QuizQuestion[];
  onMissed: (topic: string) => void;
  onMistake?: (m: { concept: string; why?: string; fix?: string }) => void;
  onStudyGuide?: (detail: string) => void;
}) {
  const [answers, setAnswers] = useState<(number | null)[]>(
    () => quiz.map(() => null),
  );
  const [checked, setChecked] = useState(false);

  const allAnswered = answers.every((a) => a !== null);
  const score = quiz.reduce(
    (n, q, i) => n + (answers[i] === q.answerIndex ? 1 : 0),
    0,
  );
  const wrong = checked
    ? quiz.filter((q, i) => answers[i] !== q.answerIndex)
    : [];

  function check() {
    setChecked(true);
    quiz.forEach((q, i) => {
      if (answers[i] !== q.answerIndex) {
        onMissed(q.topic || q.question);
        const picked = answers[i];
        onMistake?.({
          concept: q.topic || q.question,
          why:
            picked != null && q.options[picked]
              ? `picked "${q.options[picked]}"`
              : undefined,
          fix: `Correct answer: "${q.options[q.answerIndex]}"${
            q.explanation ? ` — ${q.explanation}` : ""
          }`,
        });
      }
    });
  }

  function studyGuide() {
    // Pass BOTH what the learner picked and the correct answer so the study
    // guide can walk through WHY their choice was wrong, not just state the fix.
    const detail = quiz
      .map((q, i) => {
        const picked = answers[i];
        if (picked === q.answerIndex) return null;
        const mine = picked != null ? `"${q.options[picked]}"` : "left it blank";
        return (
          `- Question: ${q.question}\n` +
          `  I answered ${mine}, but the correct answer is ` +
          `"${q.options[q.answerIndex]}"` +
          (q.explanation ? ` — ${q.explanation}` : "")
        );
      })
      .filter(Boolean)
      .join("\n");
    onStudyGuide?.(detail);
  }

  return (
    <div style={styles.toolBox}>
      <div style={styles.toolHead}>
        <span style={styles.toolTitle}>📝 Quiz</span>
        {checked && (
          <span style={styles.planCount}>
            {score}/{quiz.length}
          </span>
        )}
      </div>
      {quiz.map((q, qi) => (
        <div key={qi} style={{ marginBottom: 12 }}>
          <div style={styles.quizQ}>
            {qi + 1}. {q.question}
          </div>
          {q.options.map((opt, oi) => {
            const picked = answers[qi] === oi;
            const correct = oi === q.answerIndex;
            let bg = "var(--surface)";
            if (checked && correct) bg = "#d8efe0";
            else if (checked && picked && !correct) bg = "#f6dcdc";
            else if (picked) bg = "var(--assistant-bubble)";
            return (
              <button
                key={oi}
                disabled={checked}
                onClick={() =>
                  setAnswers((a) => a.map((v, k) => (k === qi ? oi : v)))
                }
                style={{ ...styles.quizOpt, background: bg }}
              >
                {opt}
                {checked && correct ? "  ✓" : ""}
              </button>
            );
          })}
          {checked && q.explanation && (
            <div style={styles.quizExplain}>{q.explanation}</div>
          )}
        </div>
      ))}
      {!checked && (
        <button
          style={styles.primaryBtn}
          disabled={!allAnswered}
          onClick={check}
        >
          Check answers
        </button>
      )}
      {checked && (
        <div style={styles.quizDone}>
          {score === quiz.length
            ? "🎉 Perfect! You've got this."
            : "Nice work — I'll help you revise the ones you missed."}
        </div>
      )}
      {checked && wrong.length > 0 && onStudyGuide && (
        <button style={{ ...styles.primaryBtn, marginTop: 8 }} onClick={studyGuide}>
          📚 Study guide on what I missed
        </button>
      )}
    </div>
  );
}

// Dedicated "test yourself" flow: the learner names a topic (or taps a subject
// / weak area), picks how hard and how many questions, and Eliora generates a
// fresh multiple-choice quiz on demand — grounded in the topic, not in pasted
// material. Wrong answers still feed the mistake tracker and can spin up a
// targeted study guide, exactly like a quiz built from notes.
type QuizDifficulty =
  | "kindergarten"
  | "elementary"
  | "middle"
  | "high"
  | "college";

const QUIZ_DIFFICULTIES: { key: QuizDifficulty; label: string }[] = [
  { key: "kindergarten", label: "Kindergarten" },
  { key: "elementary", label: "Elementary" },
  { key: "middle", label: "Middle school" },
  { key: "high", label: "High school" },
  { key: "college", label: "College" },
];

function PracticeQuiz({
  profile,
  subjects,
  missed,
  onMissed,
  onMistake,
  onStudyGuide,
}: {
  profile: LearnerProfile | null;
  subjects: string[];
  missed: string[];
  onMissed: (topic: string) => void;
  onMistake: (m: {
    concept: string;
    why?: string;
    fix?: string;
  }) => void;
  onStudyGuide: (detail: string) => void;
}) {
  const [topic, setTopic] = useState("");
  const [difficulty, setDifficulty] = useState<QuizDifficulty>("high");
  const [count, setCount] = useState(5);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quiz, setQuiz] = useState<QuizQuestion[] | null>(null);
  const [quizTopic, setQuizTopic] = useState("");

  // One-tap starting points: the classes they're studying, then anything
  // they've been getting wrong (deduped, weak areas first).
  const suggestions = Array.from(
    new Set([...subjects, ...missed].map((s) => s.trim()).filter(Boolean)),
  ).slice(0, 8);

  async function generate(t: string) {
    const clean = t.trim();
    if (!clean || busy) return;
    setBusy(true);
    setError(null);
    setQuiz(null);
    try {
      const res = await fetch("/api/practice-quiz", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic: clean,
          count,
          difficulty,
          // Aim the quiz at weak areas that relate to this topic when we can,
          // otherwise pass them all so the model can weight toward them.
          focus: missed.slice(0, 8),
          profile: profile ?? undefined,
        }),
      });
      const data = await res.json();
      if (data.error || !Array.isArray(data.quiz) || !data.quiz.length) {
        setError(data.error || "I couldn't build a quiz on that. Try another topic.");
      } else {
        setQuiz(data.quiz);
        setQuizTopic(clean);
      }
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setQuiz(null);
    setError(null);
  }

  return (
    <div style={styles.studyScroll}>
      <div style={styles.card}>
        <div style={styles.cardHead}>
          <span style={styles.cardClass}>🧠 Practice quiz</span>
        </div>
        <p style={styles.assignEmpty}>
          Pick something to be quizzed on — a class, a topic, or something you&apos;ve
          been getting wrong. Eliora writes a fresh multiple-choice quiz just for
          you.
        </p>

        {!quiz && (
          <>
            <div style={styles.assignAddRow}>
              <input
                style={styles.assignInput}
                value={topic}
                placeholder="Quiz me on… (e.g. photosynthesis, WWII causes)"
                onChange={(e) => setTopic(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") generate(topic);
                }}
                disabled={busy}
              />
              <button
                style={styles.assignAddBtn}
                onClick={() => generate(topic)}
                disabled={busy || !topic.trim()}
              >
                {busy ? "Writing…" : "Start"}
              </button>
            </div>

            {suggestions.length > 0 && (
              <div style={{ ...styles.folderRow, marginTop: 6 }}>
                {suggestions.map((s) => (
                  <button
                    key={s}
                    style={styles.folder}
                    onClick={() => {
                      setTopic(s);
                      generate(s);
                    }}
                    disabled={busy}
                  >
                    {missed.includes(s) ? "🎯 " : "📁 "}
                    {s}
                  </button>
                ))}
              </div>
            )}

            <div style={{ marginTop: 14 }}>
              <div style={styles.quizQ}>How hard?</div>
              <div style={{ ...styles.folderRow, marginTop: 4 }}>
                {QUIZ_DIFFICULTIES.map((d) => (
                  <button
                    key={d.key}
                    onClick={() => setDifficulty(d.key)}
                    disabled={busy}
                    style={{
                      ...styles.folder,
                      ...(difficulty === d.key
                        ? {
                            background: "var(--assistant-bubble)",
                            fontWeight: 700,
                          }
                        : {}),
                    }}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ marginTop: 14 }}>
              <div style={styles.quizQ}>How many questions?</div>
              <div style={{ ...styles.folderRow, marginTop: 4 }}>
                {[3, 5, 7, 10].map((n) => (
                  <button
                    key={n}
                    onClick={() => setCount(n)}
                    disabled={busy}
                    style={{
                      ...styles.folder,
                      ...(count === n
                        ? {
                            background: "var(--assistant-bubble)",
                            fontWeight: 700,
                          }
                        : {}),
                    }}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>

            {error && (
              <div style={{ ...styles.assignEmpty, color: "#b3453b" }}>{error}</div>
            )}
          </>
        )}
      </div>

      {busy && !quiz && (
        <div style={styles.card}>
          <p style={styles.assignEmpty}>Writing your quiz… ✍️</p>
        </div>
      )}

      {quiz && (
        <>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              margin: "2px 2px 8px",
            }}
          >
            <span style={styles.cardClass}>📝 {quizTopic}</span>
            <button style={styles.assignAddBtn} onClick={reset}>
              ← New quiz
            </button>
          </div>
          <QuizView
            quiz={quiz}
            onMissed={onMissed}
            onMistake={onMistake}
            onStudyGuide={onStudyGuide}
          />
        </>
      )}
    </div>
  );
}

// Folders Eliora creates for each subject the student needs help with.
function SubjectsPanel({
  subjects,
  onAdd,
  onRemove,
}: {
  subjects: string[];
  onAdd: (s: string) => void;
  onRemove: (s: string) => void;
}) {
  const [name, setName] = useState("");
  function add() {
    if (!name.trim()) return;
    onAdd(name);
    setName("");
  }
  return (
    <div style={styles.card}>
      <div style={styles.cardHead}>
        <span style={styles.cardClass}>📁 Subjects</span>
        {subjects.length > 0 && (
          <span style={styles.planCount}>{subjects.length}</span>
        )}
      </div>
      <div style={styles.assignAddRow}>
        <input
          style={styles.assignInput}
          value={name}
          placeholder="Add a subject (e.g. Algebra 1)…"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
        />
        <button style={styles.assignAddBtn} onClick={add}>
          Add
        </button>
      </div>
      {subjects.length > 0 ? (
        <div style={styles.folderRow}>
          {subjects.map((s) => (
            <span key={s} style={styles.folder}>
              📁 {s}
              <button
                style={styles.folderRemove}
                onClick={() => onRemove(s)}
                aria-label={`Remove ${s} folder`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : (
        <p style={styles.assignEmpty}>
          No subjects yet. Add the classes you want help with — Eliora keeps each
          one's materials together.
        </p>
      )}
    </div>
  );
}

// Paste or upload an assignment and get warm, quality-based feedback:
// strengths, what to improve (with how), a rough score/grade, and a next step.
type FeedbackIssue = { type: string; text?: string; suggestion: string };
type Feedback = {
  overall: string;
  strengths: string[];
  improve: { point: string; how?: string }[];
  issues?: FeedbackIssue[];
  rationale?: string;
  score?: number;
  grade?: string;
  nextStep?: string;
};

// Approximate syllable count for a word (vowel groups, minus silent -e).
function countSyllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 0;
  const groups = w.match(/[aeiouy]+/g);
  let n = groups ? groups.length : 1;
  if (w.endsWith("e")) n = Math.max(1, n - 1);
  return Math.max(1, n);
}
// PaperRater-style writing statistics computed locally from pasted text.
function writingStats(text: string) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length < 5) return null;
  const sentences = Math.max(
    1,
    (text.match(/[.!?]+(\s|$)/g) || []).length,
  );
  const syllables = words.reduce((n, w) => n + countSyllables(w), 0);
  const unique = new Set(
    words.map((w) => w.toLowerCase().replace(/[^a-z]/g, "")).filter(Boolean),
  ).size;
  const wps = words.length / sentences;
  // Flesch–Kincaid grade level.
  const grade = 0.39 * wps + 11.8 * (syllables / words.length) - 15.59;
  return {
    words: words.length,
    sentences,
    avgSentence: Math.round(wps * 10) / 10,
    vocab: Math.round((unique / words.length) * 100),
    gradeLevel: Math.max(1, Math.round(grade)),
  };
}
function AssignmentFeedback({
  subjects,
  profile,
  initialPrompt,
  onTrack,
}: {
  subjects: string[];
  profile: LearnerProfile | null;
  initialPrompt?: string;
  onTrack?: (m: { concept: string; fix?: string; subject?: string }) => void;
}) {
  const [work, setWork] = useState("");
  const [prompt, setPrompt] = useState("");
  // Seed the "what was the assignment?" field when opened from a review prompt.
  useEffect(() => {
    if (initialPrompt) setPrompt(initialPrompt);
  }, [initialPrompt]);
  const [subject, setSubject] = useState("");
  const [doc, setDoc] = useState<{
    base64: string;
    mediaType: string;
    name: string;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [fb, setFb] = useState<Feedback | null>(null);
  const [err, setErr] = useState("");
  const canSubmit = (work.trim().length >= 20 || !!doc) && !loading;

  function onFile(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result);
      setDoc({
        base64: s.slice(s.indexOf(",") + 1),
        mediaType: file.type || "text/plain",
        name: file.name,
      });
    };
    r.readAsDataURL(file);
  }

  async function getFeedback() {
    if (!canSubmit) return;
    setLoading(true);
    setErr("");
    setFb(null);
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: work.trim() || undefined,
          prompt: prompt.trim() || undefined,
          subject: subject.trim() || undefined,
          doc: doc ?? undefined,
          profile: profile ?? undefined,
        }),
      });
      const data = (await res.json()) as { feedback?: Feedback; error?: string };
      if (data.feedback) setFb(data.feedback);
      else setErr(data.error || "Couldn't get feedback — try again.");
    } catch {
      setErr("Couldn't reach the server. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={styles.card}>
      <div style={styles.cardHead}>
        <span style={styles.cardClass}>✍️ Assignment feedback</span>
      </div>
      <p style={{ color: "var(--muted)", margin: "4px 0 10px", fontSize: 13.5 }}>
        Paste or upload your assignment and get feedback on its quality —
        strengths, what to improve, and a score.
      </p>
      <textarea
        style={styles.fypTextarea}
        value={work}
        placeholder="Paste your essay, answers, or writing here…"
        onChange={(e) => setWork(e.target.value)}
      />
      <input
        style={{ ...styles.assignInput, marginTop: 8 }}
        value={prompt}
        placeholder="What was the assignment? (optional — the prompt or rubric)"
        onChange={(e) => setPrompt(e.target.value)}
      />
      <div style={styles.assignMetaRow}>
        <input
          style={styles.assignSelect}
          list="afb-subjects"
          value={subject}
          placeholder="Subject (optional)"
          onChange={(e) => setSubject(e.target.value)}
        />
        <datalist id="afb-subjects">
          {subjects.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      </div>
      <label style={styles.classSurveyLabel}>
        Or upload the file{" "}
        <span style={{ color: "var(--muted)", fontWeight: 400 }}>
          (PDF, image, or text)
        </span>
        <input
          type="file"
          accept=".pdf,.txt,.md,image/*,application/pdf"
          style={styles.fypFileInput}
          onChange={(e) => onFile(e.target.files)}
        />
      </label>
      {doc && (
        <div style={styles.fypDocList}>
          <span style={styles.fypDocChip}>
            📄 {doc.name}
            <button
              style={styles.fypDocRemove}
              onClick={() => setDoc(null)}
              aria-label="Remove file"
            >
              ×
            </button>
          </span>
        </div>
      )}
      <button
        style={{
          ...styles.studyToolBtn,
          width: "100%",
          marginTop: 12,
          ...(canSubmit ? {} : { opacity: 0.5, cursor: "default" }),
        }}
        disabled={!canSubmit}
        onClick={getFeedback}
      >
        {loading ? "Reviewing your work…" : "✍️ Get feedback"}
      </button>
      {err && (
        <p style={{ color: "#c0392b", fontSize: 13, marginTop: 8 }}>{err}</p>
      )}
      {fb && (
        <div style={styles.afbResult}>
          {typeof fb.score === "number" && (
            <span style={styles.afbScore}>
              {fb.score}/100{fb.grade ? ` · ${fb.grade}` : ""}
            </span>
          )}
          <p style={styles.afbOverall}>{fb.overall}</p>
          {fb.rationale && (
            <p style={{ ...styles.afbOverall, color: "var(--muted)", fontSize: 13 }}>
              <b>Why this grade:</b> {fb.rationale}
            </p>
          )}
          {(() => {
            const st = writingStats(work);
            return st ? (
              <div style={styles.afbStats}>
                {(
                  [
                    ["Words", st.words],
                    ["Sentences", st.sentences],
                    ["Avg sentence", `${st.avgSentence} words`],
                    ["Vocabulary", `${st.vocab}% unique`],
                    ["Reading level", `Grade ${st.gradeLevel}`],
                  ] as const
                ).map(([k, v]) => (
                  <span key={k} style={styles.afbStat}>
                    <b>{v}</b> {k}
                  </span>
                ))}
              </div>
            ) : null;
          })()}
          {fb.strengths.length > 0 && (
            <>
              <div style={styles.afbSecHead}>✅ Strengths</div>
              {fb.strengths.map((s, i) => (
                <div key={i} style={styles.afbLi}>
                  • {s}
                </div>
              ))}
            </>
          )}
          {fb.improve.length > 0 && (
            <>
              <div style={styles.afbSecHead}>🔧 To improve</div>
              {fb.improve.map((it, i) => (
                <div key={i} style={styles.afbImproveRow}>
                  <div style={styles.afbLi}>
                    • <b>{it.point}</b>
                    {it.how ? ` — ${it.how}` : ""}
                  </div>
                  {onTrack && (
                    <button
                      style={styles.afbTrackBtn}
                      title="Add to your mistake tracker"
                      onClick={() =>
                        onTrack({
                          concept: it.point,
                          fix: it.how,
                          subject: subject.trim() || undefined,
                        })
                      }
                    >
                      ＋ Track
                    </button>
                  )}
                </div>
              ))}
            </>
          )}
          {fb.issues && fb.issues.length > 0 && (
            <>
              <div style={styles.afbSecHead}>📝 Grammar &amp; style</div>
              {fb.issues.map((it, i) => (
                <div key={i} style={styles.afbIssue}>
                  <span style={styles.afbIssueTag}>{it.type}</span>
                  <span>
                    {it.text ? (
                      <>
                        <span style={styles.afbIssueText}>“{it.text}”</span> →{" "}
                      </>
                    ) : null}
                    {it.suggestion}
                  </span>
                </div>
              ))}
            </>
          )}
          {fb.nextStep && (
            <div style={styles.afbNext}>🎯 Next step: {fb.nextStep}</div>
          )}
        </div>
      )}
    </div>
  );
}

type NotesMode = "clean" | "handwriting" | "highlight";
type NotesFormat = "outline" | "cornell" | "paragraph" | "qa";
type PolishedNotes = {
  cleaned: string;
  keyIdeas: string[];
  keyTerms: { term: string; definition: string }[];
  note?: string;
};

// Smart-notes study tool: paste messy notes (or upload a photo of handwriting)
// and get them back cleaned up, transcribed, and with the key ideas highlighted.
// Three modes map to the three AI note features; all hit /api/notes-polish.
function SmartNotes({ profile }: { profile: LearnerProfile | null }) {
  const [mode, setMode] = useState<NotesMode>("clean");
  const [format, setFormat] = useState<NotesFormat>("outline");
  const [text, setText] = useState("");
  const [file, setFile] = useState<{
    base64: string;
    mediaType: string;
    name: string;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [out, setOut] = useState<PolishedNotes | null>(null);
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(false);
  // Follow-up chat about the notes we just cleaned up.
  const [qa, setQa] = useState<
    { role: "user" | "assistant"; content: string }[]
  >([]);
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const canSubmit = (text.trim().length >= 10 || !!file) && !loading;

  function onFile(files: FileList | null) {
    const f = files?.[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result);
      setFile({
        base64: s.slice(s.indexOf(",") + 1),
        mediaType: f.type || "text/plain",
        name: f.name,
      });
      // A photo almost always means handwriting → switch to that mode for them.
      if ((f.type || "").startsWith("image/")) setMode("handwriting");
    };
    r.readAsDataURL(f);
  }

  async function polish() {
    if (!canSubmit) return;
    setLoading(true);
    setErr("");
    setOut(null);
    setCopied(false);
    // A fresh set of notes means a fresh conversation about them.
    setQa([]);
    setQuestion("");
    try {
      const res = await fetch("/api/notes-polish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          format,
          text: text.trim() || undefined,
          fileBase64: file?.base64,
          fileMediaType: file?.mediaType,
          fileName: file?.name,
          profile: profile ?? undefined,
        }),
      });
      const data = (await res.json()) as {
        result?: PolishedNotes;
        error?: string;
      };
      if (data.result) setOut(data.result);
      else setErr(data.error || "Couldn't tidy those notes — try again.");
    } catch {
      setErr("Couldn't reach the server. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function copyCleaned() {
    if (!out?.cleaned) return;
    // Strip the ==highlight== markers so the copied text is plain and clean.
    const plain = out.cleaned.replace(/==([^=]+)==/g, "$1");
    try {
      await navigator.clipboard.writeText(plain);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — no-op */
    }
  }

  // Everything the AI produced, flattened into one block of text — this is the
  // source of truth the chatbot is allowed to answer from.
  function notesContext(o: PolishedNotes) {
    const parts = [o.cleaned.replace(/==([^=]+)==/g, "$1")];
    if (o.keyIdeas.length)
      parts.push(`Key ideas:\n${o.keyIdeas.map((i) => `- ${i}`).join("\n")}`);
    if (o.keyTerms.length)
      parts.push(
        `Key terms:\n${o.keyTerms
          .map((t) => `- ${t.term}: ${t.definition}`)
          .join("\n")}`,
      );
    return parts.filter(Boolean).join("\n\n");
  }

  // Ask a follow-up about the cleaned notes. Streams the answer back token by
  // token, same as the Summarize tool's Q&A.
  async function ask(preset?: string) {
    const q = (preset ?? question).trim();
    if (!q || asking || !out) return;
    setAsking(true);
    setQuestion("");
    // Show the question right away, plus a placeholder that fills in.
    const history = qa;
    setQa([
      ...history,
      { role: "user", content: q },
      { role: "assistant", content: "" },
    ]);
    try {
      const res = await fetch("/api/notes-qa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          notes: notesContext(out),
          question: q,
          history,
          profile: profile ?? undefined,
        }),
      });
      if (!res.body) throw new Error("no stream");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let acc = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        acc += decoder.decode(value, { stream: true });
        setQa([
          ...history,
          { role: "user", content: q },
          { role: "assistant", content: acc },
        ]);
      }
    } catch {
      setQa([
        ...history,
        { role: "user", content: q },
        {
          role: "assistant",
          content: "Sorry, I couldn't answer that. Please try again.",
        },
      ]);
    } finally {
      setAsking(false);
    }
  }

  const modes = [
    ["clean", "🧹 Clean up"],
    ["handwriting", "✍️ Handwriting"],
    ["highlight", "🖍️ Highlight"],
  ] as const;
  const formats = [
    ["outline", "🗂️ Outline"],
    ["cornell", "📔 Cornell"],
    ["paragraph", "📄 Paragraphs"],
    ["qa", "❓ Q&A"],
  ] as const;
  const starters = [
    "Explain this more simply",
    "Quiz me on these notes",
    "What's most important here?",
    "Give me an example",
  ];

  return (
    <div style={styles.card}>
      <div style={styles.cardHead}>
        <span style={styles.cardClass}>📝 Summarize</span>
      </div>
      <p style={{ color: "var(--muted)", margin: "4px 0 10px", fontSize: 13.5 }}>
        Paste messy notes or upload a photo of your handwriting. I'll clean them
        up, turn handwriting into text, and highlight the key ideas.
      </p>
      <div style={styles.outputRow}>
        {modes.map(([k, label]) => (
          <button
            key={k}
            onClick={() => setMode(k)}
            style={{ ...styles.outChip, ...(mode === k ? styles.outChipActive : {}) }}
          >
            {label}
          </button>
        ))}
      </div>
      <div style={{ ...styles.outputRow, marginTop: 6, alignItems: "center" }}>
        <span style={{ color: "var(--muted)", fontSize: 12.5 }}>Format:</span>
        {formats.map(([k, label]) => (
          <button
            key={k}
            onClick={() => setFormat(k)}
            style={{ ...styles.outChip, ...(format === k ? styles.outChipActive : {}) }}
          >
            {label}
          </button>
        ))}
      </div>
      <textarea
        style={{ ...styles.fypTextarea, marginTop: 10 }}
        value={text}
        placeholder={
          mode === "handwriting"
            ? "Upload a photo below — or type/paste any notes to tidy up…"
            : "Paste your messy notes here…"
        }
        onChange={(e) => setText(e.target.value)}
      />
      <div style={styles.fypUploadRow}>
        <label style={styles.fypUploadBtn}>
          📎 {mode === "handwriting" ? "Upload a photo of your notes" : "Upload a file"}
          <input
            type="file"
            accept=".pdf,.txt,.md,image/*,application/pdf"
            style={styles.fypFileInputHidden}
            onChange={(e) => onFile(e.target.files)}
          />
        </label>
        <span style={{ color: "var(--muted)", fontSize: 12.5 }}>
          photo, PDF, or text
        </span>
      </div>
      {file && (
        <div style={styles.fypDocList}>
          <span style={styles.fypDocChip}>
            {file.mediaType.startsWith("image/") ? "🖼️" : "📄"} {file.name}
            <button
              style={styles.fypDocRemove}
              onClick={() => setFile(null)}
              aria-label="Remove file"
            >
              ×
            </button>
          </span>
        </div>
      )}
      <button
        style={{
          ...styles.studyToolBtn,
          width: "100%",
          marginTop: 12,
          ...(canSubmit ? {} : { opacity: 0.5, cursor: "default" }),
        }}
        disabled={!canSubmit}
        onClick={polish}
      >
        {loading
          ? "Tidying your notes…"
          : mode === "handwriting"
            ? "✍️ Convert to text"
            : mode === "highlight"
              ? "🖍️ Highlight key ideas"
              : "🧹 Clean up notes"}
      </button>
      {err && (
        <p style={{ color: "#c0392b", fontSize: 13, marginTop: 8 }}>{err}</p>
      )}
      {out && (
        <div style={styles.afbResult}>
          {out.note && <p style={styles.afbOverall}>{out.note}</p>}
          {out.cleaned && (
            <>
              <div style={styles.afbSecHead}>
                📝 Clean notes
                <button style={styles.notesCopyBtn} onClick={copyCleaned}>
                  {copied ? "✓ Copied" : "⧉ Copy"}
                </button>
              </div>
              <div style={styles.resultMd}>
                {renderMarkdown(out.cleaned, "var(--accent)")}
              </div>
            </>
          )}
          {out.keyIdeas.length > 0 && (
            <>
              <div style={styles.afbSecHead}>💡 Key ideas</div>
              {out.keyIdeas.map((idea, i) => (
                <div key={i} style={styles.afbLi}>
                  • {idea}
                </div>
              ))}
            </>
          )}
          {out.keyTerms.length > 0 && (
            <>
              <div style={styles.afbSecHead}>📚 Key terms</div>
              {out.keyTerms.map((t, i) => (
                <div key={i} style={styles.afbLi}>
                  • <b>{t.term}</b> — {t.definition}
                </div>
              ))}
            </>
          )}
          {/* Chat about the notes — grounded in the cleaned result above. */}
          <div style={{ ...styles.qaBox, marginTop: 16 }}>
            <div style={styles.qaHead}>💬 Chat about these notes</div>
            {qa.length === 0 && (
              <>
                <p style={{ color: "var(--muted)", fontSize: 12.5, margin: 0 }}>
                  Ask me anything about what&apos;s above — I&apos;ll answer from
                  your notes.
                </p>
                <div style={styles.outputRow}>
                  {starters.map((s) => (
                    <button
                      key={s}
                      style={{
                        ...styles.outChip,
                        ...(asking ? { opacity: 0.5, cursor: "default" } : {}),
                      }}
                      disabled={asking}
                      onClick={() => ask(s)}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </>
            )}
            {qa.map((m, i) => (
              <div
                key={i}
                style={m.role === "user" ? styles.qaUser : styles.qaBot}
              >
                {m.role === "user" ? (
                  m.content
                ) : m.content ? (
                  <div style={styles.resultMd}>
                    {renderMarkdown(m.content, "var(--accent)")}
                  </div>
                ) : (
                  "Thinking…"
                )}
              </div>
            ))}
            <div style={styles.qaInputRow}>
              <input
                style={styles.formInput}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") ask();
                }}
                placeholder="e.g. Can you explain the second point more simply?"
              />
              <button
                style={{
                  ...styles.primaryBtn,
                  ...(asking || !question.trim()
                    ? { opacity: 0.5, cursor: "default" }
                    : {}),
                }}
                onClick={() => ask()}
                disabled={asking || !question.trim()}
              >
                {asking ? "…" : "Ask"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Notes workspace — a persistent notebook that lives alongside chat. Free-form
// or Cornell-template notes, color-coded concept highlights, wiki-style [[links]]
// between notes, draggable sticky notes, and (wired below) voice capture.
// Everything is local-first: saved to localStorage, namespaced per learner.
// ---------------------------------------------------------------------------

type StickyNote = {
  id: string;
  text: string;
  color: NoteColor;
  x: number;
  y: number;
};
type CanvasNode = { id: string; text: string; x: number; y: number; color: NoteColor };
type CanvasEdge = { id: string; from: string; to: string };
type NoteDoc = {
  id: string;
  title: string;
  template: "free" | "cornell" | "canvas";
  body: string; // free notes, or the Cornell "notes" column
  cue: string; // Cornell cue/questions column
  summary: string; // Cornell summary row
  stickies: StickyNote[];
  nodes: CanvasNode[]; // infinite-canvas / mind-map nodes
  edges: CanvasEdge[]; // connections between nodes
  updatedAt: number;
};
type NoteColor = "yellow" | "green" | "blue" | "pink" | "orange";

const NOTE_HIGHLIGHTS: Record<NoteColor, string> = {
  yellow: "#fdf0a6",
  green: "#c3e8cb",
  blue: "#c2dcf7",
  pink: "#f8c9dd",
  orange: "#ffd9ac",
};
const NOTE_STICKIES: Record<NoteColor, string> = {
  yellow: "#fef3b0",
  green: "#cdeed4",
  blue: "#cfe4fb",
  pink: "#fbd3e4",
  orange: "#ffe2c2",
};
const NOTE_COLOR_ORDER: NoteColor[] = [
  "yellow",
  "green",
  "blue",
  "pink",
  "orange",
];

function newId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// Inline renderer for a note preview: **bold**, ==highlight== (optionally
// ==color:text== for color-coded concepts), and [[wiki links]] to other notes.
function renderNoteInline(
  text: string,
  onLink: (title: string) => void,
): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  text
    .split(/(\*\*[^*]+\*\*|==[^=]+==|\[\[[^\]]+\]\])/g)
    .forEach((part, i) => {
      if (!part) return;
      let m: RegExpMatchArray | null;
      if ((m = part.match(/^\*\*([^*]+)\*\*$/))) {
        out.push(<strong key={i}>{m[1]}</strong>);
      } else if ((m = part.match(/^==([^=]+)==$/))) {
        const inner = m[1];
        const cm = inner.match(/^(yellow|green|blue|pink|orange):([\s\S]+)$/);
        const color = (cm ? cm[1] : "yellow") as NoteColor;
        const label = cm ? cm[2] : inner;
        out.push(
          <mark
            key={i}
            style={{
              background: NOTE_HIGHLIGHTS[color],
              color: "#1f2a24",
              padding: "0 3px",
              borderRadius: 4,
            }}
          >
            {label}
          </mark>,
        );
      } else if ((m = part.match(/^\[\[([^\]]+)\]\]$/))) {
        const title = m[1].trim();
        out.push(
          <button
            key={i}
            onClick={() => onLink(title)}
            style={{
              background: "none",
              border: "none",
              padding: 0,
              cursor: "pointer",
              color: "var(--accent)",
              fontWeight: 600,
              textDecoration: "underline",
            }}
          >
            {title}
          </button>,
        );
      } else {
        out.push(<span key={i}>{part}</span>);
      }
    });
  return out;
}

// Block renderer for a note preview: #/##/### headings, - bullets, 1. lists.
function renderNoteMarkdown(
  text: string,
  onLink: (title: string) => void,
): React.ReactNode {
  const blocks: React.ReactNode[] = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) {
      blocks.push(<div key={i} style={{ height: 8 }} />);
      return;
    }
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^(#{1,3})\s+(.*)$/))) {
      const lvl = m[1].length;
      blocks.push(
        <div
          key={i}
          style={{
            fontWeight: 800,
            fontSize: lvl === 1 ? 19 : lvl === 2 ? 16.5 : 15,
            color: "var(--accent)",
            margin: "10px 0 4px",
          }}
        >
          {renderNoteInline(m[2], onLink)}
        </div>,
      );
    } else if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
      blocks.push(
        <div key={i} style={{ display: "flex", gap: 8, margin: "2px 0" }}>
          <span style={{ color: "var(--accent)" }}>•</span>
          <span>{renderNoteInline(m[1], onLink)}</span>
        </div>,
      );
    } else if ((m = line.match(/^\s*(\d+)\.\s+(.*)$/))) {
      blocks.push(
        <div key={i} style={{ display: "flex", gap: 8, margin: "2px 0" }}>
          <span style={{ color: "var(--accent)", fontWeight: 700 }}>{m[1]}.</span>
          <span>{renderNoteInline(m[2], onLink)}</span>
        </div>,
      );
    } else {
      blocks.push(
        <div key={i} style={{ margin: "2px 0", lineHeight: 1.55 }}>
          {renderNoteInline(line, onLink)}
        </div>,
      );
    }
  });
  return blocks;
}

function StickyBoard({
  stickies,
  onChange,
}: {
  stickies: StickyNote[];
  onChange: (next: StickyNote[]) => void;
}) {
  const boardRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null);

  function onPointerDown(e: React.PointerEvent, s: StickyNote) {
    const board = boardRef.current?.getBoundingClientRect();
    if (!board) return;
    drag.current = {
      id: s.id,
      dx: e.clientX - board.left - s.x,
      dy: e.clientY - board.top - s.y,
    };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!drag.current) return;
    const board = boardRef.current?.getBoundingClientRect();
    if (!board) return;
    const x = Math.max(0, Math.min(board.width - 150, e.clientX - board.left - drag.current.dx));
    const y = Math.max(0, Math.min(board.height - 60, e.clientY - board.top - drag.current.dy));
    onChange(stickies.map((s) => (s.id === drag.current!.id ? { ...s, x, y } : s)));
  }
  function onPointerUp() {
    drag.current = null;
  }

  function addSticky() {
    const color = NOTE_COLOR_ORDER[stickies.length % NOTE_COLOR_ORDER.length];
    onChange([
      ...stickies,
      { id: newId(), text: "", color, x: 12 + (stickies.length % 4) * 24, y: 12 + (stickies.length % 4) * 20 },
    ]);
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
        <span style={{ fontWeight: 700, fontSize: 14, color: "var(--assistant-text)" }}>
          🗒️ Sticky notes
        </span>
        <button
          onClick={addSticky}
          style={{
            padding: "5px 12px",
            borderRadius: 999,
            border: "1px solid var(--accent)",
            background: "transparent",
            color: "var(--accent)",
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          ＋ Add sticky
        </button>
      </div>
      <div
        ref={boardRef}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        style={{
          position: "relative",
          minHeight: 220,
          borderRadius: 12,
          border: "1px dashed var(--border)",
          background: "var(--assistant-bubble)",
          overflow: "hidden",
        }}
      >
        {stickies.length === 0 && (
          <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "var(--muted)", fontSize: 13.5 }}>
            Add sticky notes and drag them around.
          </div>
        )}
        {stickies.map((s) => (
          <div
            key={s.id}
            style={{
              position: "absolute",
              left: s.x,
              top: s.y,
              width: 150,
              minHeight: 90,
              background: NOTE_STICKIES[s.color],
              borderRadius: 8,
              boxShadow: "0 2px 8px rgba(0,0,0,0.12)",
              padding: 8,
              display: "flex",
              flexDirection: "column",
              gap: 4,
            }}
          >
            <div
              onPointerDown={(e) => onPointerDown(e, s)}
              style={{ cursor: "grab", display: "flex", justifyContent: "space-between", touchAction: "none" }}
            >
              <span style={{ fontSize: 12 }}>⠿</span>
              <span style={{ display: "flex", gap: 3 }}>
                {NOTE_COLOR_ORDER.map((c) => (
                  <button
                    key={c}
                    onClick={() => onChange(stickies.map((x) => (x.id === s.id ? { ...x, color: c } : x)))}
                    aria-label={`Color ${c}`}
                    style={{
                      width: 11,
                      height: 11,
                      borderRadius: "50%",
                      border: s.color === c ? "1.5px solid #333" : "1px solid rgba(0,0,0,0.2)",
                      background: NOTE_STICKIES[c],
                      cursor: "pointer",
                      padding: 0,
                    }}
                  />
                ))}
                <button
                  onClick={() => onChange(stickies.filter((x) => x.id !== s.id))}
                  aria-label="Delete sticky"
                  style={{ background: "none", border: "none", cursor: "pointer", fontSize: 13, lineHeight: 1, padding: 0 }}
                >
                  ×
                </button>
              </span>
            </div>
            <textarea
              value={s.text}
              onChange={(e) => onChange(stickies.map((x) => (x.id === s.id ? { ...x, text: e.target.value } : x)))}
              placeholder="Note…"
              style={{
                flex: 1,
                border: "none",
                background: "transparent",
                resize: "none",
                outline: "none",
                fontSize: 13,
                color: "#1f2a24",
                fontFamily: "inherit",
                minHeight: 56,
              }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

// Voice notes: dictate straight into a note using the browser's speech
// recognition (same API the teach-back recorder uses). Final phrases are
// appended live; nothing is uploaded. Renders nothing where unsupported.
function VoiceCapture({ onAppend }: { onAppend: (text: string) => void }) {
  const [recording, setRecording] = useState(false);
  const [interim, setInterim] = useState("");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recRef = useRef<any>(null);
  const supported =
    typeof window !== "undefined" &&
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ("SpeechRecognition" in window || "webkitSpeechRecognition" in (window as any));

  useEffect(
    () => () => {
      try {
        recRef.current?.stop();
      } catch {
        /* ignore */
      }
      recRef.current = null;
    },
    [],
  );

  function start() {
    if (!supported) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    const SR = w.SpeechRecognition || w.webkitSpeechRecognition;
    const rec = new SR();
    rec.lang = "en-US";
    rec.interimResults = true;
    rec.continuous = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rec.onresult = (e: any) => {
      let intr = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) onAppend(r[0].transcript.trim());
        else intr += r[0].transcript;
      }
      setInterim(intr);
    };
    // The API stops itself after a silence; restart while we're still recording.
    rec.onend = () => {
      if (recRef.current) {
        try {
          rec.start();
        } catch {
          /* already restarting */
        }
      }
    };
    rec.onerror = () => {};
    recRef.current = rec;
    try {
      rec.start();
      setRecording(true);
    } catch {
      /* ignore */
    }
  }

  function stop() {
    const rec = recRef.current;
    recRef.current = null;
    try {
      rec?.stop();
    } catch {
      /* ignore */
    }
    setRecording(false);
    setInterim("");
  }

  if (!supported) return null;

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <button
        onClick={recording ? stop : start}
        title={recording ? "Stop dictation" : "Dictate a voice note"}
        style={{
          padding: "3px 10px",
          borderRadius: 8,
          border: recording ? "1px solid #c0392b" : "1px solid var(--border)",
          background: recording ? "#c0392b" : "transparent",
          color: recording ? "#fff" : "var(--assistant-text)",
          fontWeight: 600,
          fontSize: 13,
          cursor: "pointer",
        }}
      >
        {recording ? "⏹ Stop" : "🎤 Voice"}
      </button>
      {recording && (
        <span style={{ fontSize: 12, color: "var(--muted)", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {interim ? `“${interim}”` : "Listening…"}
        </span>
      )}
    </span>
  );
}

// Infinite canvas / mind map: pan (drag the background), zoom (scroll wheel),
// draggable nodes, and click-to-connect edges rendered as SVG lines. Used when a
// note's template is "canvas". All state lives on the NoteDoc so it persists.
function CanvasBoard({
  nodes,
  edges,
  onNodes,
  onEdges,
}: {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  onNodes: (next: CanvasNode[]) => void;
  onEdges: (next: CanvasEdge[]) => void;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState({ x: 0, y: 0, z: 1 });
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const drag = useRef<
    | { kind: "pan"; sx: number; sy: number; ox: number; oy: number }
    | { kind: "node"; id: string; sx: number; sy: number; nx: number; ny: number }
    | null
  >(null);

  function addNode() {
    const wrap = wrapRef.current?.getBoundingClientRect();
    const cx = wrap ? (wrap.width / 2 - view.x) / view.z : 200;
    const cy = wrap ? (wrap.height / 2 - view.y) / view.z : 150;
    const color = NOTE_COLOR_ORDER[nodes.length % NOTE_COLOR_ORDER.length];
    // Fan new nodes out around the center so they don't stack on each other.
    const angle = nodes.length * 0.9;
    const radius = nodes.length === 0 ? 0 : 90 + nodes.length * 10;
    onNodes([
      ...nodes,
      {
        id: newId(),
        text: nodes.length === 0 ? "Central idea" : "Idea",
        x: cx - 60 + Math.cos(angle) * radius,
        y: cy - 20 + Math.sin(angle) * radius,
        color,
      },
    ]);
  }

  function onBgPointerDown(e: React.PointerEvent) {
    if (e.target !== e.currentTarget) return; // only when hitting the background
    drag.current = { kind: "pan", sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setConnectFrom(null);
  }
  function onNodePointerDown(e: React.PointerEvent, n: CanvasNode) {
    e.stopPropagation();
    drag.current = { kind: "node", id: n.id, sx: e.clientX, sy: e.clientY, nx: n.x, ny: n.y };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: React.PointerEvent) {
    const d = drag.current;
    if (!d) return;
    if (d.kind === "pan") {
      setView((v) => ({ ...v, x: d.ox + (e.clientX - d.sx), y: d.oy + (e.clientY - d.sy) }));
    } else {
      const dx = (e.clientX - d.sx) / view.z;
      const dy = (e.clientY - d.sy) / view.z;
      onNodes(nodes.map((n) => (n.id === d.id ? { ...n, x: d.nx + dx, y: d.ny + dy } : n)));
    }
  }
  function onPointerUp() {
    drag.current = null;
  }
  function onWheel(e: React.WheelEvent) {
    const wrap = wrapRef.current?.getBoundingClientRect();
    if (!wrap) return;
    const px = e.clientX - wrap.left;
    const py = e.clientY - wrap.top;
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    setView((v) => {
      const z = Math.max(0.3, Math.min(2.5, v.z * factor));
      // Keep the point under the cursor fixed while zooming.
      const k = z / v.z;
      return { z, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
    });
  }

  function nodeClick(n: CanvasNode) {
    if (connectFrom && connectFrom !== n.id) {
      const exists = edges.some(
        (ed) =>
          (ed.from === connectFrom && ed.to === n.id) ||
          (ed.from === n.id && ed.to === connectFrom),
      );
      if (!exists) onEdges([...edges, { id: newId(), from: connectFrom, to: n.id }]);
      setConnectFrom(null);
    }
  }

  function removeNode(id: string) {
    onNodes(nodes.filter((n) => n.id !== id));
    onEdges(edges.filter((ed) => ed.from !== id && ed.to !== id));
    if (connectFrom === id) setConnectFrom(null);
  }

  const byId = (id: string) => nodes.find((n) => n.id === id);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
        <button
          onClick={addNode}
          style={{ padding: "5px 12px", borderRadius: 999, border: "none", background: "var(--accent)", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer" }}
        >
          ＋ Add node
        </button>
        <button
          onClick={() => setView({ x: 0, y: 0, z: 1 })}
          style={{ padding: "5px 12px", borderRadius: 999, border: "1px solid var(--border)", background: "transparent", color: "var(--assistant-text)", fontSize: 13, cursor: "pointer" }}
        >
          ⟲ Reset view
        </button>
        <span style={{ fontSize: 12, color: "var(--muted)" }}>
          {connectFrom ? "Click another node to connect →" : "Drag background to pan · scroll to zoom · ⛓ then a node to link"}
        </span>
      </div>
      <div
        ref={wrapRef}
        onPointerDown={onBgPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onWheel={onWheel}
        style={{
          position: "relative",
          height: 440,
          borderRadius: 12,
          border: "1px solid var(--border)",
          background:
            "var(--assistant-bubble) radial-gradient(circle, rgba(0,0,0,0.06) 1px, transparent 1px)",
          backgroundSize: `${24 * view.z}px ${24 * view.z}px`,
          backgroundPosition: `${view.x}px ${view.y}px`,
          overflow: "hidden",
          touchAction: "none",
          cursor: drag.current?.kind === "pan" ? "grabbing" : "default",
        }}
      >
        {nodes.length === 0 && (
          <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "var(--muted)", fontSize: 13.5, pointerEvents: "none" }}>
            Add a node to start your mind map.
          </div>
        )}
        {/* Edges */}
        <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", overflow: "visible" }}>
          <g transform={`translate(${view.x},${view.y}) scale(${view.z})`}>
            {edges.map((ed) => {
              const a = byId(ed.from);
              const b = byId(ed.to);
              if (!a || !b) return null;
              return (
                <line
                  key={ed.id}
                  x1={a.x + 60}
                  y1={a.y + 20}
                  x2={b.x + 60}
                  y2={b.y + 20}
                  stroke="var(--accent)"
                  strokeWidth={2}
                  strokeOpacity={0.55}
                />
              );
            })}
          </g>
        </svg>
        {/* Nodes */}
        <div style={{ position: "absolute", inset: 0, transform: `translate(${view.x}px,${view.y}px) scale(${view.z})`, transformOrigin: "0 0" }}>
          {nodes.map((n) => (
            <div
              key={n.id}
              onPointerDown={(e) => onNodePointerDown(e, n)}
              onClick={() => nodeClick(n)}
              style={{
                position: "absolute",
                left: n.x,
                top: n.y,
                width: 120,
                minHeight: 40,
                background: NOTE_STICKIES[n.color],
                border: connectFrom === n.id ? "2px solid var(--accent)" : "1px solid rgba(0,0,0,0.15)",
                borderRadius: 10,
                boxShadow: "0 2px 6px rgba(0,0,0,0.12)",
                padding: 6,
                cursor: "grab",
                touchAction: "none",
              }}
            >
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 4, marginBottom: 2 }}>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setConnectFrom(connectFrom === n.id ? null : n.id);
                  }}
                  title="Link to another node"
                  style={{ background: "none", border: "none", cursor: "pointer", fontSize: 12, padding: 0, lineHeight: 1 }}
                >
                  ⛓
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    removeNode(n.id);
                  }}
                  title="Delete node"
                  style={{ background: "none", border: "none", cursor: "pointer", fontSize: 13, padding: 0, lineHeight: 1 }}
                >
                  ×
                </button>
              </div>
              <textarea
                value={n.text}
                onPointerDown={(e) => e.stopPropagation()}
                onChange={(e) => onNodes(nodes.map((x) => (x.id === n.id ? { ...x, text: e.target.value } : x)))}
                style={{
                  width: "100%",
                  border: "none",
                  background: "transparent",
                  resize: "none",
                  outline: "none",
                  fontSize: 13,
                  fontWeight: 600,
                  color: "#1f2a24",
                  fontFamily: "inherit",
                  textAlign: "center",
                  minHeight: 20,
                }}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// "Sync to Google Docs" for a single note. Rides the existing Google login and
// posts the note to /api/notes/export-doc, which creates a formatted doc and
// returns its link. Falls back to a Google-sign-in nudge if the account isn't
// Google (the Docs scope only comes with a Google login).
function GoogleDocsSync({ note }: { note: NoteDoc }) {
  const { data: session } = useSession();
  const isGoogle =
    (session as { authProvider?: string } | null)?.authProvider === "google";
  const [state, setState] = useState<"idle" | "saving" | "done" | "error">(
    "idle",
  );
  const [msg, setMsg] = useState("");
  const [url, setUrl] = useState("");

  async function sync() {
    setState("saving");
    setMsg("");
    setUrl("");
    try {
      const res = await fetch("/api/notes/export-doc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: note.title,
          template: note.template,
          body: note.body,
          cue: note.cue,
          summary: note.summary,
        }),
      });
      const data = (await res.json()) as {
        url?: string;
        error?: string;
        needsGoogle?: boolean;
      };
      if (data.url) {
        setUrl(data.url);
        setState("done");
        window.open(data.url, "_blank", "noopener,noreferrer");
      } else if (data.needsGoogle) {
        setState("error");
        setMsg(data.error || "Sign in with Google to save to Docs.");
      } else {
        setState("error");
        setMsg(data.error || "Couldn't save to Google Docs — try again.");
      }
    } catch {
      setState("error");
      setMsg("Couldn't reach the server. Please try again.");
    }
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      {isGoogle ? (
        <button
          onClick={sync}
          disabled={state === "saving"}
          style={{
            padding: "6px 14px",
            borderRadius: 999,
            border: "1px solid var(--border)",
            background: "var(--bg)",
            color: "var(--assistant-text)",
            fontSize: 13,
            fontWeight: 700,
            cursor: state === "saving" ? "default" : "pointer",
            opacity: state === "saving" ? 0.6 : 1,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          📄 {state === "saving" ? "Saving to Google Docs…" : "Sync to Google Docs"}
        </button>
      ) : (
        <button
          onClick={() => signIn("google", { callbackUrl: "/" })}
          style={{
            padding: "6px 14px",
            borderRadius: 999,
            border: "1px solid var(--border)",
            background: "var(--bg)",
            color: "var(--assistant-text)",
            fontSize: 13,
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          📄 Sign in with Google to save to Docs
        </button>
      )}
      {state === "done" && url && (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          style={{ fontSize: 12.5, color: "var(--accent)", fontWeight: 700 }}
        >
          ✓ Opened in Google Docs
        </a>
      )}
      {state === "error" && msg && (
        <span style={{ fontSize: 12.5, color: "#c0392b" }}>{msg}</span>
      )}
    </div>
  );
}

function NotesWorkspace({ ns }: { ns: string }) {
  const STORE_KEY = `eliora-notebook::${ns}`;
  const [docs, setDocs] = useState<NoteDoc[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);

  // Load once per learner.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      const saved = raw ? (JSON.parse(raw) as NoteDoc[]) : null;
      if (Array.isArray(saved) && saved.length) {
        // Backfill fields added in later versions so older saves keep working.
        const norm = saved.map((d) => ({
          ...d,
          stickies: d.stickies ?? [],
          nodes: d.nodes ?? [],
          edges: d.edges ?? [],
        }));
        setDocs(norm);
        setActiveId(norm[0].id);
      }
    } catch {
      /* ignore */
    }
    setLoaded(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [STORE_KEY]);

  // Persist on change.
  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(docs));
    } catch {
      /* ignore */
    }
  }, [docs, loaded, STORE_KEY]);

  const active = docs.find((d) => d.id === activeId) ?? null;

  function createDoc(template: "free" | "cornell" | "canvas") {
    const doc: NoteDoc = {
      id: newId(),
      title:
        template === "cornell"
          ? "Cornell notes"
          : template === "canvas"
            ? "Mind map"
            : "Untitled note",
      template,
      body: "",
      cue: "",
      summary: "",
      stickies: [],
      nodes:
        template === "canvas"
          ? [{ id: newId(), text: "Central idea", x: 180, y: 180, color: "yellow" }]
          : [],
      edges: [],
      updatedAt: Date.now(),
    };
    setDocs((prev) => [doc, ...prev]);
    setActiveId(doc.id);
  }

  function patch(id: string, p: Partial<NoteDoc>) {
    setDocs((prev) =>
      prev.map((d) => (d.id === id ? { ...d, ...p, updatedAt: Date.now() } : d)),
    );
  }

  function removeDoc(id: string) {
    setDocs((prev) => {
      const next = prev.filter((d) => d.id !== id);
      if (id === activeId) setActiveId(next[0]?.id ?? null);
      return next;
    });
  }

  // Open a [[linked]] note by title — jump to it, or create it if missing.
  function openByTitle(title: string) {
    const found = docs.find(
      (d) => d.title.trim().toLowerCase() === title.trim().toLowerCase(),
    );
    if (found) {
      setActiveId(found.id);
    } else {
      const doc: NoteDoc = {
        id: newId(),
        title,
        template: "free",
        body: "",
        cue: "",
        summary: "",
        stickies: [],
        nodes: [],
        edges: [],
        updatedAt: Date.now(),
      };
      setDocs((prev) => [doc, ...prev]);
      setActiveId(doc.id);
    }
  }

  // Append dictated speech to the active note's body. Uses a functional update
  // so streamed final phrases each read the latest body (no stale closure).
  function appendToActiveBody(text: string) {
    if (!text.trim()) return;
    setDocs((prev) =>
      prev.map((d) => {
        if (d.id !== activeId) return d;
        const sep = !d.body || /\s$/.test(d.body) ? "" : " ";
        return { ...d, body: d.body + sep + text, updatedAt: Date.now() };
      }),
    );
  }

  // Wrap the current selection in the body textarea with a marker (color/bold).
  function wrapSelection(before: string, after: string) {
    const ta = bodyRef.current;
    if (!ta || !active) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const val = ta.value;
    const sel = val.slice(start, end) || "concept";
    const next = val.slice(0, start) + before + sel + after + val.slice(end);
    patch(active.id, { body: next });
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(start + before.length, start + before.length + sel.length);
    });
  }

  const colorBtn = (c: NoteColor) => (
    <button
      key={c}
      onClick={() => wrapSelection(`==${c}:`, "==")}
      title={`Highlight ${c}`}
      style={{
        width: 22,
        height: 22,
        borderRadius: "50%",
        border: "1px solid rgba(0,0,0,0.15)",
        background: NOTE_HIGHLIGHTS[c],
        cursor: "pointer",
        padding: 0,
      }}
    />
  );

  const taStyle: React.CSSProperties = {
    width: "100%",
    border: "1px solid var(--border)",
    borderRadius: 10,
    padding: 10,
    fontSize: 14.5,
    fontFamily: "inherit",
    lineHeight: 1.55,
    color: "var(--assistant-text)",
    background: "var(--bg)",
    resize: "vertical",
    outline: "none",
  };

  return (
    <div style={{ display: "flex", gap: 14, alignItems: "flex-start", flexWrap: "wrap" }}>
      {/* Note list */}
      <div style={{ flex: "1 1 200px", minWidth: 190, maxWidth: 260 }}>
        <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
          <button
            onClick={() => createDoc("free")}
            style={{
              flex: 1,
              padding: "8px 10px",
              borderRadius: 10,
              border: "none",
              background: "var(--accent)",
              color: "#fff",
              fontWeight: 700,
              fontSize: 13.5,
              cursor: "pointer",
            }}
          >
            ＋ New note
          </button>
          <button
            onClick={() => createDoc("cornell")}
            style={{
              flex: 1,
              padding: "8px 10px",
              borderRadius: 10,
              border: "1px solid var(--accent)",
              background: "transparent",
              color: "var(--accent)",
              fontWeight: 700,
              fontSize: 13.5,
              cursor: "pointer",
            }}
          >
            📐 Cornell
          </button>
          <button
            onClick={() => createDoc("canvas")}
            style={{
              flex: 1,
              padding: "8px 10px",
              borderRadius: 10,
              border: "1px solid var(--accent)",
              background: "transparent",
              color: "var(--accent)",
              fontWeight: 700,
              fontSize: 13.5,
              cursor: "pointer",
            }}
          >
            🕸️ Mind map
          </button>
        </div>
        {docs.length === 0 && (
          <p style={{ color: "var(--muted)", fontSize: 13.5 }}>
            No notes yet. Start a free note or a Cornell template.
          </p>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {docs.map((d) => (
            <div
              key={d.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                padding: "8px 10px",
                borderRadius: 10,
                cursor: "pointer",
                background: d.id === activeId ? "var(--assistant-bubble)" : "transparent",
                fontWeight: d.id === activeId ? 700 : 500,
              }}
              onClick={() => setActiveId(d.id)}
            >
              <span style={{ flex: 1, fontSize: 14, color: "var(--assistant-text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {d.template === "cornell" ? "📐 " : d.template === "canvas" ? "🕸️ " : "📝 "}
                {d.title || "Untitled"}
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  removeDoc(d.id);
                }}
                aria-label="Delete note"
                style={{ background: "none", border: "none", cursor: "pointer", color: "var(--muted)", fontSize: 16, padding: 0 }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Editor */}
      <div style={{ flex: "4 1 560px", minWidth: 340 }}>
        {!active ? (
          <div style={{ color: "var(--muted)", fontSize: 14, padding: "30px 0" }}>
            Select or create a note to start writing.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <input
              value={active.title}
              onChange={(e) => patch(active.id, { title: e.target.value })}
              placeholder="Note title"
              style={{
                width: "100%",
                border: "none",
                borderBottom: "1px solid var(--border)",
                padding: "6px 2px",
                fontSize: 20,
                fontWeight: 800,
                color: "var(--accent)",
                background: "transparent",
                outline: "none",
              }}
            />

            {active.template === "canvas" ? (
              <CanvasBoard
                nodes={active.nodes}
                edges={active.edges}
                onNodes={(next) => patch(active.id, { nodes: next })}
                onEdges={(next) => patch(active.id, { edges: next })}
              />
            ) : (
              <>
            <GoogleDocsSync note={active} />
            {/* Concept color toolbar */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 12.5, color: "var(--muted)", fontWeight: 600 }}>
                Color-code:
              </span>
              {NOTE_COLOR_ORDER.map(colorBtn)}
              <button
                onClick={() => wrapSelection("**", "**")}
                title="Bold"
                style={{ padding: "3px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "transparent", fontWeight: 800, cursor: "pointer", color: "var(--assistant-text)" }}
              >
                B
              </button>
              <VoiceCapture onAppend={appendToActiveBody} />
              <span style={{ fontSize: 12, color: "var(--muted)" }}>
                Tip: link notes with [[Note title]]
              </span>
            </div>

            {active.template === "cornell" ? (
              <div>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <div style={{ flex: "1 1 140px", minWidth: 130 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 800, color: "var(--accent)", textTransform: "uppercase", marginBottom: 4 }}>
                      Cues / questions
                    </div>
                    <textarea
                      value={active.cue}
                      onChange={(e) => patch(active.id, { cue: e.target.value })}
                      placeholder="Key questions, cues, keywords…"
                      style={{ ...taStyle, minHeight: 440 }}
                    />
                  </div>
                  <div style={{ flex: "2 1 260px", minWidth: 220 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 800, color: "var(--accent)", textTransform: "uppercase", marginBottom: 4 }}>
                      Notes
                    </div>
                    <textarea
                      ref={bodyRef}
                      value={active.body}
                      onChange={(e) => patch(active.id, { body: e.target.value })}
                      placeholder="Main notes from class or reading…"
                      style={{ ...taStyle, minHeight: 440 }}
                    />
                  </div>
                </div>
                <div style={{ marginTop: 10 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 800, color: "var(--accent)", textTransform: "uppercase", marginBottom: 4 }}>
                    Summary
                  </div>
                  <textarea
                    value={active.summary}
                    onChange={(e) => patch(active.id, { summary: e.target.value })}
                    placeholder="Sum it up in a sentence or two…"
                    style={{ ...taStyle, minHeight: 110 }}
                  />
                </div>
              </div>
            ) : (
              <textarea
                ref={bodyRef}
                value={active.body}
                onChange={(e) => patch(active.id, { body: e.target.value })}
                placeholder="Write your notes… use ## headings, - bullets, and [[links]] to other notes."
                style={{ ...taStyle, minHeight: 460 }}
              />
            )}

            {/* Live preview */}
            {(active.body.trim() || active.cue.trim() || active.summary.trim()) && (
              <div style={{ border: "1px solid var(--border)", borderRadius: 12, padding: 14, background: "var(--assistant-bubble)" }}>
                <div style={{ fontSize: 12, fontWeight: 800, color: "var(--muted)", textTransform: "uppercase", marginBottom: 8 }}>
                  Preview
                </div>
                {active.template === "cornell" && active.cue.trim() && (
                  <div style={{ marginBottom: 8 }}>
                    <div style={{ fontWeight: 800, color: "var(--accent)", fontSize: 13 }}>Cues</div>
                    {renderNoteMarkdown(active.cue, openByTitle)}
                  </div>
                )}
                {renderNoteMarkdown(active.body, openByTitle)}
                {active.template === "cornell" && active.summary.trim() && (
                  <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--border)" }}>
                    <div style={{ fontWeight: 800, color: "var(--accent)", fontSize: 13 }}>Summary</div>
                    {renderNoteMarkdown(active.summary, openByTitle)}
                  </div>
                )}
              </div>
            )}

            <StickyBoard
              stickies={active.stickies}
              onChange={(next) => patch(active.id, { stickies: next })}
            />
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function greetingFor(p: LearnerProfile): Message {
  const name = p.name?.trim() ? `, ${p.name.trim()}` : "";
  return {
    role: "assistant",
    content:
      `Hi${name} 🌱 Thanks for sharing all that — I've got your info for ` +
      `${p.klass.trim()}. Want me to build your learning plan and find a few ` +
      `study videos to get started?`,
  };
}

// Apply an incoming plan from Eliora, preserving done states by title.
// Additive merge for the study-plan survey / one-tap subject build: KEEP every
// existing milestone and append only the new titles, so building a plan for one
// subject never wipes another subject's steps.
function appendPlan(prev: Milestone[], incoming: IncomingMilestone[]): Milestone[] {
  const have = new Set(prev.map((p) => p.title));
  const fresh = incoming
    .filter((m) => !have.has(m.title))
    .map((m) => ({
      title: m.title,
      detail: m.detail,
      checkpoint: m.checkpoint,
      done: false,
    }));
  return [...prev, ...fresh];
}

function mergePlan(prev: Milestone[], incoming: IncomingMilestone[]): Milestone[] {
  const merged: Milestone[] = incoming.map((m) => ({
    title: m.title,
    detail: m.detail,
    checkpoint: m.checkpoint,
    done: prev.find((p) => p.title === m.title)?.done ?? false,
  }));
  // Keep the learner's own steps — Eliora's re-save would otherwise drop them.
  const kept = prev.filter(
    (p) => p.added && !incoming.some((m) => m.title === p.title),
  );
  return [...merged, ...kept];
}

function SignUp({
  initial,
  onComplete,
  onCancel,
}: {
  initial?: LearnerProfile | null;
  onComplete: (p: LearnerProfile) => void;
  onCancel?: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [klass, setKlass] = useState(initial?.klass ?? "");
  const [struggles, setStruggles] = useState(initial?.struggles ?? "");
  const [learningStyle, setLearningStyle] = useState(initial?.learningStyle ?? "");
  const [interests, setInterests] = useState(initial?.interests ?? "");
  const [pastSuccess, setPastSuccess] = useState(initial?.pastSuccess ?? "");
  const [studyHabits, setStudyHabits] = useState(initial?.studyHabits ?? "");
  const [biggestChallenge, setBiggestChallenge] = useState(
    initial?.biggestChallenge ?? "",
  );
  const [gradeYear, setGradeYear] = useState(initial?.gradeYear ?? "");
  const [subjectsStudying, setSubjectsStudying] = useState(
    initial?.subjectsStudying ?? "",
  );
  const [planningStyle, setPlanningStyle] = useState(
    initial?.planningStyle ?? "",
  );
  const [sessionLength, setSessionLength] = useState(
    initial?.sessionLength ?? "",
  );
  const [focusHelp, setFocusHelp] = useState(initial?.focusHelp ?? "");
  const [usedStudyApp, setUsedStudyApp] = useState(initial?.usedStudyApp ?? "");
  const [wantedFeature, setWantedFeature] = useState(
    initial?.wantedFeature ?? "",
  );
  const [planBlocker, setPlanBlocker] = useState(initial?.planBlocker ?? "");
  const [mainGoal, setMainGoal] = useState(initial?.mainGoal ?? "");
  const [hobbies, setHobbies] = useState(initial?.hobbies ?? "");
  const [focusTime, setFocusTime] = useState(initial?.focusTime ?? "");
  const [needHelpMost, setNeedHelpMost] = useState(initial?.needHelpMost ?? "");

  const canSubmit = klass.trim().length > 0;

  function submit() {
    if (!canSubmit) return;
    onComplete({
      name,
      klass,
      struggles,
      learningStyle,
      interests,
      pastSuccess,
      studyHabits: studyHabits || undefined,
      biggestChallenge: biggestChallenge || undefined,
      gradeYear: gradeYear.trim() || undefined,
      subjectsStudying: subjectsStudying.trim() || undefined,
      planningStyle: planningStyle || undefined,
      sessionLength: sessionLength || undefined,
      focusHelp: focusHelp || undefined,
      usedStudyApp: usedStudyApp || undefined,
      wantedFeature: wantedFeature || undefined,
      planBlocker: planBlocker || undefined,
      mainGoal: mainGoal || undefined,
      hobbies: hobbies || undefined,
      focusTime: focusTime || undefined,
      needHelpMost: needHelpMost.trim() || undefined,
    });
  }

  // Reusable multiple-choice question (single select; tap again to clear).
  const choiceGroup = (
    question: string,
    options: string[],
    value: string,
    setValue: (s: string) => void,
  ) => (
    <div style={styles.label}>
      {question}
      <div style={styles.choiceList}>
        {options.map((opt) => {
          const selected = value === opt;
          return (
            <button
              key={opt}
              type="button"
              onClick={() => setValue(selected ? "" : opt)}
              style={{
                ...styles.choiceBtn,
                ...(selected ? styles.choiceBtnSelected : {}),
              }}
            >
              <span style={styles.choiceRadio}>{selected ? "●" : ""}</span>
              {opt}
            </button>
          );
        })}
      </div>
    </div>
  );

  // Like choiceGroup but multi-select — value is a comma-joined list.
  const multiChoiceGroup = (
    question: string,
    options: string[],
    value: string,
    setValue: (s: string) => void,
  ) => {
    const chosen = new Set(
      value
        ? value.split(",").map((s) => s.trim()).filter(Boolean)
        : [],
    );
    const toggle = (opt: string) => {
      const next = new Set(chosen);
      if (next.has(opt)) next.delete(opt);
      else next.add(opt);
      setValue([...next].join(", "));
    };
    return (
      <div style={styles.label}>
        {question}{" "}
        <span style={styles.choiceHint}>(select all that apply)</span>
        <div style={styles.choiceList}>
          {options.map((opt) => {
            const isSel = chosen.has(opt);
            return (
              <button
                key={opt}
                type="button"
                onClick={() => toggle(opt)}
                style={{
                  ...styles.choiceBtn,
                  ...(isSel ? styles.choiceBtnSelected : {}),
                }}
              >
                <span
                  style={{
                    ...styles.choiceCheckbox,
                    ...(isSel ? styles.choiceCheckboxSelected : {}),
                  }}
                >
                  {isSel ? "✓" : ""}
                </span>
                {opt}
              </button>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <main style={styles.formPage}>
      <h1 style={styles.title}>Welcome to Eliora 🌱</h1>
      <p style={styles.formIntro}>
        A few quick questions so I can build a learning plan that fits you. Only
        the class is required — share what you like.
      </p>

      <label style={styles.label}>
        Your name (optional)
        <input
          style={styles.formInput}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="What should I call you?"
        />
      </label>

      <label style={styles.label}>
        What class are you taking? *
        <input
          style={styles.formInput}
          value={klass}
          onChange={(e) => setKlass(e.target.value)}
          placeholder="e.g. Algebra 1, AP Biology, Intro Spanish"
          spellCheck
          autoCapitalize="words"
        />
      </label>

      <label style={styles.label}>
        What do you struggle with while learning?
        <textarea
          spellCheck
          style={styles.formTextarea}
          value={struggles}
          onChange={(e) => setStruggles(e.target.value)}
          placeholder="e.g. staying focused, reading, remembering, test anxiety"
          rows={2}
        />
      </label>

      <label style={styles.label}>
        How do you like to learn?
        <textarea
          spellCheck
          style={styles.formTextarea}
          value={learningStyle}
          onChange={(e) => setLearningStyle(e.target.value)}
          placeholder="e.g. videos, examples, hands-on, talking it through, visuals"
          rows={2}
        />
      </label>

      <label style={styles.label}>
        What do you like to do? (hobbies / interests)
        <textarea
          spellCheck
          style={styles.formTextarea}
          value={interests}
          onChange={(e) => setInterests(e.target.value)}
          placeholder="e.g. soccer, drawing, video games, music"
          rows={2}
        />
      </label>

      <label style={styles.label}>
        What has worked for you in the past? (optional)
        <textarea
          spellCheck
          style={styles.formTextarea}
          value={pastSuccess}
          onChange={(e) => setPastSuccess(e.target.value)}
          placeholder="e.g. flashcards, studying with a friend, short sessions"
          rows={2}
        />
      </label>

      {multiChoiceGroup(
        "How would you describe your current study habits?",
        STUDY_HABIT_OPTIONS,
        studyHabits,
        setStudyHabits,
      )}

      {multiChoiceGroup(
        "What are your biggest challenges when studying?",
        CHALLENGE_OPTIONS,
        biggestChallenge,
        setBiggestChallenge,
      )}

      <label style={styles.label}>
        What grade or year are you currently in?
        <input
          style={styles.formInput}
          value={gradeYear}
          onChange={(e) => setGradeYear(e.target.value)}
          placeholder="e.g. 10th grade, sophomore, Year 11"
        />
      </label>

      <label style={styles.label}>
        What subjects are you currently studying?
        <input
          style={styles.formInput}
          value={subjectsStudying}
          onChange={(e) => setSubjectsStudying(e.target.value)}
          placeholder="e.g. World History, Algebra 2, Chemistry, Spanish"
          spellCheck
        />
      </label>

      {multiChoiceGroup(
        "How do you usually plan your study sessions?",
        PLANNING_OPTIONS,
        planningStyle,
        setPlanningStyle,
      )}

      {choiceGroup(
        "How long is a typical study session for you?",
        SESSION_LENGTH_OPTIONS,
        sessionLength,
        setSessionLength,
      )}

      {multiChoiceGroup(
        "What helps you focus the most while studying?",
        FOCUS_HELP_OPTIONS,
        focusHelp,
        setFocusHelp,
      )}

      {choiceGroup(
        "Have you used a study or productivity app before?",
        USED_APP_OPTIONS,
        usedStudyApp,
        setUsedStudyApp,
      )}

      {multiChoiceGroup(
        "What features would help you the most in a study app?",
        WANTED_FEATURE_OPTIONS,
        wantedFeature,
        setWantedFeature,
      )}

      {multiChoiceGroup(
        "What usually stops you from sticking to a study plan?",
        PLAN_BLOCKER_OPTIONS,
        planBlocker,
        setPlanBlocker,
      )}

      {multiChoiceGroup(
        "What are your main goals when using a study planning app?",
        MAIN_GOAL_OPTIONS,
        mainGoal,
        setMainGoal,
      )}

      {multiChoiceGroup(
        "What are your hobbies or interests?",
        HOBBY_OPTIONS,
        hobbies,
        setHobbies,
      )}

      {choiceGroup(
        "What time of day do you focus best?",
        FOCUS_TIME_OPTIONS,
        focusTime,
        setFocusTime,
      )}

      <label style={styles.label}>
        How do you struggle or need help in your studies the most? (optional)
        <textarea
          spellCheck
          style={styles.formTextarea}
          value={needHelpMost}
          onChange={(e) => setNeedHelpMost(e.target.value)}
          placeholder="In your own words — anything you want me to know"
          rows={2}
        />
      </label>

      <div style={styles.formActions}>
        {onCancel && (
          <button onClick={onCancel} style={styles.secondaryBtn}>
            Cancel
          </button>
        )}
        <button onClick={submit} disabled={!canSubmit} style={styles.primaryBtn}>
          {initial ? "Save" : "Start learning"}
        </button>
      </div>
    </main>
  );
}

// Login gate: show the Google sign-in screen until the user is authenticated.
export default function Home() {
  const { status } = useSession();
  if (status === "loading") {
    return (
      <main style={styles.loginPage}>
        <p style={{ color: "var(--muted)" }}>Loading…</p>
      </main>
    );
  }
  if (status === "unauthenticated") return <Login />;
  return <ElioraApp />;
}

// ---- Landing-page feature demos (shown to signed-out visitors) ----
// Small self-contained mock previews of each feature so new users can see
// what Eliora does before creating an account. No real data or API calls.

const demoStyles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 48,
    padding: "48px 24px 72px",
  },
  hero: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "center",
    gap: 40,
    maxWidth: 960,
    width: "100%",
  },
  heroCopy: {
    flex: "1 1 340px",
    minWidth: 300,
    maxWidth: 480,
    display: "flex",
    flexDirection: "column",
    gap: 14,
  },
  heroTitle: { margin: 0, fontSize: 40, lineHeight: 1.1 },
  heroTagline: {
    margin: 0,
    fontSize: 17,
    lineHeight: 1.55,
    color: "var(--muted)",
  },
  heroChips: { display: "flex", flexWrap: "wrap", gap: 8, marginTop: 4 },
  heroChip: {
    fontSize: 13,
    fontWeight: 600,
    padding: "6px 12px",
    borderRadius: 999,
    background: "var(--accent-soft)",
    color: "var(--accent)",
  },
  heroScrollHint: {
    marginTop: 6,
    fontSize: 14,
    fontWeight: 600,
    color: "var(--accent)",
    textDecoration: "none",
  },
  demosSection: {
    width: "100%",
    maxWidth: 1100,
    display: "flex",
    flexDirection: "column",
    gap: 20,
  },
  demosHeading: { margin: 0, fontSize: 26, textAlign: "center" },
  demosSub: {
    margin: 0,
    textAlign: "center",
    color: "var(--muted)",
    fontSize: 15,
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
    gap: 18,
    marginTop: 8,
  },
  card: {
    display: "flex",
    flexDirection: "column",
    gap: 12,
    padding: 18,
    borderRadius: 16,
    border: "1px solid var(--border)",
    background: "var(--surface)",
  },
  cardHead: { display: "flex", alignItems: "flex-start", gap: 10 },
  cardEmoji: { fontSize: 22, lineHeight: 1.2 },
  cardTitle: { margin: 0, fontSize: 16, fontWeight: 700 },
  cardCaption: {
    margin: "2px 0 0",
    fontSize: 13,
    lineHeight: 1.45,
    color: "var(--muted)",
  },
  cardBody: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    padding: 12,
    borderRadius: 12,
    border: "1px solid var(--border)",
    background: "var(--bg)",
    fontSize: 13.5,
  },
  bubbleUser: {
    alignSelf: "flex-end",
    maxWidth: "85%",
    padding: "8px 12px",
    borderRadius: "14px 14px 4px 14px",
    background: "var(--accent)",
    color: "#fff",
    lineHeight: 1.45,
  },
  bubbleBot: {
    alignSelf: "flex-start",
    maxWidth: "90%",
    padding: "8px 12px",
    borderRadius: "14px 14px 14px 4px",
    background: "var(--accent-soft)",
    color: "var(--text)",
    lineHeight: 1.45,
  },
  taskRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    cursor: "pointer",
    userSelect: "none",
  },
  barTrack: {
    height: 8,
    borderRadius: 999,
    background: "var(--accent-soft)",
    overflow: "hidden",
  },
  barFill: {
    height: "100%",
    borderRadius: 999,
    background: "var(--accent)",
  },
  chipRow: { display: "flex", flexWrap: "wrap", gap: 6 },
  miniChip: {
    fontSize: 12,
    fontWeight: 600,
    padding: "4px 10px",
    borderRadius: 999,
    border: "1px solid var(--border)",
    background: "var(--surface)",
  },
  tryHint: {
    fontSize: 11.5,
    color: "var(--muted)",
    fontStyle: "italic",
  },
};

function DemoCard({
  emoji,
  title,
  caption,
  children,
}: {
  emoji: string;
  title: string;
  caption: string;
  children: React.ReactNode;
}) {
  return (
    <div style={demoStyles.card}>
      <div style={demoStyles.cardHead}>
        <span style={demoStyles.cardEmoji} aria-hidden>
          {emoji}
        </span>
        <div>
          <h3 style={demoStyles.cardTitle}>{title}</h3>
          <p style={demoStyles.cardCaption}>{caption}</p>
        </div>
      </div>
      <div style={demoStyles.cardBody}>{children}</div>
    </div>
  );
}

function DemoChat() {
  return (
    <>
      <span style={demoStyles.bubbleUser}>
        I have a bio test Friday and I haven&apos;t started 😬
      </span>
      <span style={demoStyles.bubbleBot}>
        No panic — that&apos;s 3 days. Let&apos;s do three 25-minute sessions:
        cells today, genetics tomorrow, practice quiz Thursday. Want me to add
        them to your plan?
      </span>
      <span style={demoStyles.bubbleUser}>Yes please!</span>
    </>
  );
}

function DemoDailyTasks() {
  const [done, setDone] = useState([true, false, false]);
  const tasks = [
    "Review algebra notes (15 min)",
    "Quiz yourself: cell organelles",
    "Plan tomorrow in 2 minutes",
  ];
  const count = done.filter(Boolean).length;
  return (
    <>
      {tasks.map((t, i) => (
        <span
          key={t}
          style={demoStyles.taskRow}
          onClick={() =>
            setDone((d) => d.map((v, j) => (j === i ? !v : v)))
          }
        >
          <span aria-hidden>{done[i] ? "✅" : "⬜"}</span>
          <span
            style={{
              textDecoration: done[i] ? "line-through" : "none",
              color: done[i] ? "var(--muted)" : "var(--text)",
            }}
          >
            {t}
          </span>
        </span>
      ))}
      <div style={demoStyles.barTrack}>
        <div
          style={{ ...demoStyles.barFill, width: `${(count / 3) * 100}%` }}
        />
      </div>
      <span style={demoStyles.tryHint}>Try it — tap a task to check it off</span>
    </>
  );
}

function DemoRewards() {
  return (
    <>
      <span style={{ fontSize: 15, fontWeight: 700 }}>🔥 5-day streak</span>
      <div style={demoStyles.chipRow}>
        <span style={demoStyles.miniChip}>🥇 First Plan</span>
        <span style={demoStyles.miniChip}>📚 Bookworm</span>
        <span style={demoStyles.miniChip}>🌟 Week Streak</span>
      </div>
      <div style={demoStyles.barTrack}>
        <div style={{ ...demoStyles.barFill, width: "70%" }} />
      </div>
      <span style={{ color: "var(--muted)", fontSize: 12.5 }}>
        140 / 200 points to your next reward
      </span>
    </>
  );
}

function DemoSchedule() {
  const blocks: { time: string; label: string; bg: string }[] = [
    { time: "4:00", label: "📖 Study — Bio ch. 4", bg: "var(--accent-soft)" },
    { time: "4:30", label: "☕ Break", bg: "var(--bg)" },
    { time: "5:00", label: "✍️ Essay outline", bg: "var(--accent-soft)" },
  ];
  return (
    <>
      {blocks.map((b) => (
        <div
          key={b.time}
          style={{
            display: "flex",
            gap: 10,
            alignItems: "center",
            padding: "6px 10px",
            borderRadius: 8,
            border: "1px solid var(--border)",
            background: b.bg,
          }}
        >
          <span style={{ fontWeight: 700, fontSize: 12, minWidth: 34 }}>
            {b.time}
          </span>
          <span>{b.label}</span>
        </div>
      ))}
    </>
  );
}

function DemoGoals() {
  return (
    <>
      <span style={{ fontWeight: 700 }}>🎯 Raise chem grade to an A−</span>
      <span style={{ color: "var(--muted)", fontSize: 12.5 }}>
        Short-term · 2 of 4 steps done
      </span>
      <div style={demoStyles.barTrack}>
        <div style={{ ...demoStyles.barFill, width: "50%" }} />
      </div>
      <div style={demoStyles.chipRow}>
        <span style={demoStyles.miniChip}>✅ Redo missed problems</span>
        <span style={demoStyles.miniChip}>⬜ Office hours Tues</span>
      </div>
    </>
  );
}

function DemoCalendar() {
  const events = [
    { label: "🧪 Bio quiz", when: "in 2 days" },
    { label: "📄 Essay draft", when: "in 5 days" },
    { label: "📅 Math final", when: "in 3 weeks" },
  ];
  return (
    <>
      {events.map((e) => (
        <div
          key={e.label}
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "6px 10px",
            borderRadius: 8,
            border: "1px solid var(--border)",
            background: "var(--surface)",
          }}
        >
          <span>{e.label}</span>
          <span style={{ color: "var(--accent)", fontWeight: 700, fontSize: 12 }}>
            {e.when}
          </span>
        </div>
      ))}
    </>
  );
}

function DemoFlashcards() {
  const [flipped, setFlipped] = useState(false);
  return (
    <>
      <div
        onClick={() => setFlipped((f) => !f)}
        style={{
          cursor: "pointer",
          userSelect: "none",
          padding: "18px 14px",
          borderRadius: 10,
          border: "1px solid var(--border)",
          background: flipped ? "var(--accent-soft)" : "var(--surface)",
          textAlign: "center",
          fontWeight: 600,
          minHeight: 44,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {flipped
          ? "The mitochondria — it converts glucose into ATP."
          : "What is the powerhouse of the cell?"}
      </div>
      <div style={demoStyles.chipRow}>
        <span style={demoStyles.miniChip}>📇 12 flashcards</span>
        <span style={demoStyles.miniChip}>❓ 5-question quiz</span>
      </div>
      <span style={demoStyles.tryHint}>Try it — tap the card to flip</span>
    </>
  );
}

function DemoFourYear() {
  return (
    <>
      <div style={demoStyles.chipRow}>
        {["Gr 9", "Gr 10", "Gr 11", "Gr 12"].map((g, i) => (
          <span
            key={g}
            style={{
              ...demoStyles.miniChip,
              background: i < 2 ? "var(--accent-soft)" : "var(--surface)",
            }}
          >
            {g}
          </span>
        ))}
      </div>
      <span>🎓 Destination: UC Berkeley — Biology</span>
      <span style={{ color: "var(--muted)", fontSize: 12.5 }}>
        Projected GPA <b style={{ color: "var(--accent)" }}>3.8</b> · 18 / 24
        credits planned
      </span>
    </>
  );
}

function DemoVideos() {
  return (
    <>
      <div
        style={{
          display: "flex",
          gap: 10,
          alignItems: "center",
          padding: 8,
          borderRadius: 10,
          border: "1px solid var(--border)",
          background: "var(--surface)",
        }}
      >
        <span
          aria-hidden
          style={{
            width: 64,
            height: 40,
            borderRadius: 6,
            background: "var(--accent-soft)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 18,
          }}
        >
          ▶️
        </span>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <span style={{ fontWeight: 600 }}>Photosynthesis in 8 minutes</span>
          <span style={{ color: "var(--muted)", fontSize: 12 }}>
            Picked for your biology plan
          </span>
        </div>
      </div>
      <span style={{ color: "var(--muted)", fontSize: 12.5 }}>
        A study-feed of videos matched to what you&apos;re learning this week.
      </span>
    </>
  );
}

function LandingDemos() {
  return (
    <section id="demos" style={demoStyles.demosSection}>
      <h2 style={demoStyles.demosHeading}>See what Eliora can do</h2>
      <p style={demoStyles.demosSub}>
        A quick peek at each feature — everything below is a live little demo.
      </p>
      <div style={demoStyles.grid}>
        <DemoCard
          emoji="💬"
          title="AI study coach"
          caption="Chat through what's stressing you and get a concrete plan back."
        >
          <DemoChat />
        </DemoCard>
        <DemoCard
          emoji="✅"
          title="Daily tasks"
          caption="Three small wins a day, tuned to your plan and energy."
        >
          <DemoDailyTasks />
        </DemoCard>
        <DemoCard
          emoji="🏆"
          title="Rewards, badges & streaks"
          caption="Points for showing up — spend them, earn badges, keep the flame."
        >
          <DemoRewards />
        </DemoCard>
        <DemoCard
          emoji="🗓️"
          title="Weekly schedule"
          caption="Study blocks, breaks, and classes laid out hour by hour."
        >
          <DemoSchedule />
        </DemoCard>
        <DemoCard
          emoji="🎯"
          title="SMART goals"
          caption="Big goals broken into steps you can actually check off."
        >
          <DemoGoals />
        </DemoCard>
        <DemoCard
          emoji="⏳"
          title="Exam countdowns"
          caption="A calendar that keeps deadlines visible before they sneak up."
        >
          <DemoCalendar />
        </DemoCard>
        <DemoCard
          emoji="📇"
          title="Summaries, flashcards & quizzes"
          caption="Paste notes or a YouTube link — get a summary you can study from."
        >
          <DemoFlashcards />
        </DemoCard>
        <DemoCard
          emoji="🎓"
          title="Four-year plan"
          caption="Map courses to your dream school with a live GPA projection."
        >
          <DemoFourYear />
        </DemoCard>
        <DemoCard
          emoji="📺"
          title="Video study feed"
          caption="Curated videos matched to the topics in your plan."
        >
          <DemoVideos />
        </DemoCard>
      </div>
    </section>
  );
}

function Login() {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError("");
    if (!email.trim() || !password) {
      setError("Enter your email and password.");
      return;
    }
    if (mode === "signup" && password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }
    if (mode === "signup" && password !== confirm) {
      setError("Passwords don't match — please retype them.");
      return;
    }
    setBusy(true);
    try {
      if (mode === "signup") {
        const res = await fetch("/api/signup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, email, password }),
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          setError(d.error || "Could not create your account.");
          setBusy(false);
          return;
        }
      }
      const result = await signIn("credentials", {
        email,
        password,
        redirect: false,
      });
      if (result?.error) {
        setError(
          mode === "login"
            ? "Wrong email or password."
            : "Account created, but sign-in failed — try logging in.",
        );
        setBusy(false);
        return;
      }
      window.location.href = "/"; // signed in → load the app
    } catch {
      setError("Something went wrong. Please try again.");
      setBusy(false);
    }
  }

  return (
    <main style={demoStyles.page}>
      <section style={demoStyles.hero}>
        <div style={demoStyles.heroCopy}>
          <h1 style={demoStyles.heroTitle}>Eliora 🌱</h1>
          <p style={demoStyles.heroTagline}>
            Your focus &amp; study coach. Chat with an AI coach, build a plan
            that fits your life, and turn big goals into small daily wins —
            with streaks, badges, and rewards to keep you going.
          </p>
          <div style={demoStyles.heroChips}>
            <span style={demoStyles.heroChip}>💬 AI coach</span>
            <span style={demoStyles.heroChip}>✅ Daily tasks</span>
            <span style={demoStyles.heroChip}>🔥 Streaks</span>
            <span style={demoStyles.heroChip}>📇 Flashcards</span>
            <span style={demoStyles.heroChip}>🎓 4-year plan</span>
          </div>
          <a href="#demos" style={demoStyles.heroScrollHint}>
            See every feature in action ↓
          </a>
        </div>
        <div style={styles.loginCard}>
          <h2 style={{ margin: 0, fontSize: 22 }}>
            {mode === "login" ? "Welcome back" : "Get started"}
          </h2>
          <p style={styles.loginIntro}>
            {mode === "login"
              ? "Log in to pick up where you left off."
              : "Create an account to save your plan, chats, and progress."}
          </p>

        {mode === "signup" && (
          <input
            style={styles.loginInput}
            placeholder="Your name (optional)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        )}
        <input
          style={styles.loginInput}
          type="email"
          placeholder="Email"
          value={email}
          autoComplete="email"
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
        <input
          style={styles.loginInput}
          type="password"
          placeholder={mode === "signup" ? "Password (6+ characters)" : "Password"}
          value={password}
          autoComplete={mode === "login" ? "current-password" : "new-password"}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
        {mode === "signup" && (
          <input
            style={styles.loginInput}
            type="password"
            placeholder="Confirm password"
            value={confirm}
            autoComplete="new-password"
            onChange={(e) => setConfirm(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
          />
        )}

        {error && <p style={styles.loginError}>{error}</p>}

        <button style={styles.loginSubmit} disabled={busy} onClick={submit}>
          {busy ? "…" : mode === "login" ? "Log in" : "Create account"}
        </button>

        <p style={styles.loginToggle}>
          {mode === "login" ? "New here? " : "Already have an account? "}
          <span
            style={styles.loginToggleLink}
            onClick={() => {
              setMode(mode === "login" ? "signup" : "login");
              setConfirm("");
              setError("");
            }}
          >
            {mode === "login" ? "Create an account" : "Log in"}
          </span>
        </p>

        <div style={styles.loginDivider}>
          <span style={styles.loginDividerText}>or</span>
        </div>

        <button
          style={styles.googleBtn}
          onClick={() => signIn("google", { callbackUrl: "/" })}
        >
          <span style={styles.googleG} aria-hidden>
            G
          </span>
          Continue with Google
        </button>
        </div>
      </section>

      <LandingDemos />
    </main>
  );
}

// --- Study Together ----------------------------------------------------------
// Shared study rooms: focus alongside other learners with a synced pomodoro,
// live presence, and a lightweight room chat. Eliora has no realtime backend,
// so the client polls /api/rooms/[code] a few times a second and derives the
// countdown locally from the server clock (mirrors @eliora/shared TogetherRoom).
type TogetherTimerMode = "focus" | "break" | "idle";
type TogetherTimer = {
  mode: TogetherTimerMode;
  running: boolean;
  startedAt?: number;
  durationSec: number;
  remainingSec?: number;
  updatedBy?: string;
};
type TogetherMember = { id: string; name: string; lastSeen: number };
type TogetherMessage = {
  id: string;
  memberId: string;
  name: string;
  text: string;
  at: number;
};
type TogetherRoom = {
  code: string;
  name: string;
  topic?: string;
  createdAt: number;
  timer: TogetherTimer;
  members: TogetherMember[];
  messages: TogetherMessage[];
};

const TOGETHER_FOCUS_SEC = 25 * 60;
const TOGETHER_BREAK_SEC = 5 * 60;
const TOGETHER_PRESENCE_MS = 20_000;
const TOGETHER_ID_KEY = "eliora-together-id";
const TOGETHER_LAST_KEY = "eliora-together-last";

function togetherRemaining(timer: TogetherTimer, now: number): number {
  if (timer.mode === "idle") return 0;
  if (!timer.running) return timer.remainingSec ?? timer.durationSec;
  if (!timer.startedAt) return timer.durationSec;
  return Math.max(0, timer.durationSec - Math.floor((now - timer.startedAt) / 1000));
}
function togetherClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
}

function StudyTogether({ name }: { name: string }) {
  // Two halves: live rooms (focus alongside someone right now) and the doubts
  // board (ask a question, get answered later). Rooms keep polling in the
  // background while you're reading doubts, so switching tabs doesn't drop you
  // out of a session.
  const [view, setView] = useState<"rooms" | "doubts">("rooms");
  const [room, setRoom] = useState<TogetherRoom | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [createTopic, setCreateTopic] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [draft, setDraft] = useState("");
  const [copied, setCopied] = useState(false);
  const memberIdRef = useRef<string>("");
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  // Stable per-device member id + auto-rejoin the last room.
  useEffect(() => {
    let id = localStorage.getItem(TOGETHER_ID_KEY);
    if (!id) {
      id =
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `m-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
      localStorage.setItem(TOGETHER_ID_KEY, id);
    }
    memberIdRef.current = id;
    const last = localStorage.getItem(TOGETHER_LAST_KEY);
    if (last) void enter("join", { code: last }, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Local 1s tick so the countdown moves smoothly between polls.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Poll while in a room: refresh presence + pull the latest state.
  const code = room?.code;
  useEffect(() => {
    if (!code) return;
    let alive = true;
    async function poll() {
      try {
        const res = await fetch(
          `/api/rooms/${code}?memberId=${encodeURIComponent(
            memberIdRef.current,
          )}&name=${encodeURIComponent(name)}`,
          { cache: "no-store" },
        );
        if (!alive) return;
        if (res.status === 404) {
          localStorage.removeItem(TOGETHER_LAST_KEY);
          setRoom(null);
          setErr("That room has ended.");
          return;
        }
        const data = (await res.json()) as { room?: TogetherRoom };
        if (data.room) {
          setRoom(data.room);
          setNow(Date.now());
        }
      } catch {
        /* transient — next tick retries */
      }
    }
    void poll();
    const t = setInterval(poll, 2500);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [code, name]);

  // Keep the chat pinned to the newest message.
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ block: "end" });
  }, [room?.messages.length]);

  async function enter(
    action: "create" | "join",
    extra: { name?: string; topic?: string; code?: string },
    silent = false,
  ) {
    if (!silent) {
      setBusy(true);
      setErr("");
    }
    try {
      const res = await fetch("/api/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          memberId: memberIdRef.current,
          memberName: name,
          ...extra,
        }),
      });
      const data = (await res.json()) as { room?: TogetherRoom; error?: string };
      if (data.room) {
        setRoom(data.room);
        setNow(Date.now());
        localStorage.setItem(TOGETHER_LAST_KEY, data.room.code);
        setJoinCode("");
        setCreateTopic("");
      } else if (!silent) {
        setErr(data.error || "Couldn't reach that room — try again.");
      } else {
        // A silent auto-rejoin that failed just means the old room is gone.
        localStorage.removeItem(TOGETHER_LAST_KEY);
      }
    } catch {
      if (!silent) setErr("Couldn't reach the server. Please try again.");
    } finally {
      if (!silent) setBusy(false);
    }
  }

  // Fire a room action and adopt the returned state for a snappy response.
  async function act(body: Record<string, unknown>) {
    if (!room) return;
    try {
      const res = await fetch(`/api/rooms/${room.code}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          memberId: memberIdRef.current,
          name,
          ...body,
        }),
      });
      const data = (await res.json()) as { room?: TogetherRoom };
      if (data.room) {
        setRoom(data.room);
        setNow(Date.now());
      }
    } catch {
      /* the poll loop will reconcile */
    }
  }

  function sendChat() {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    void act({ action: "message", text });
  }

  async function leave() {
    const current = room;
    localStorage.removeItem(TOGETHER_LAST_KEY);
    setRoom(null);
    setDraft("");
    if (current) {
      try {
        await fetch(`/api/rooms/${current.code}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "leave", memberId: memberIdRef.current }),
        });
      } catch {
        /* presence timeout will drop us anyway */
      }
    }
  }

  const tabs = (
    <div style={styles.tabBar}>
      {(
        [
          ["rooms", "⏱️ Rooms"],
          ["doubts", "🙋 Doubts"],
        ] as const
      ).map(([key, label]) => (
        <button
          key={key}
          style={{
            ...styles.viewTab,
            ...(view === key ? styles.viewTabActive : {}),
          }}
          onClick={() => setView(key)}
        >
          {label}
        </button>
      ))}
    </div>
  );

  if (view === "doubts") {
    return (
      <div style={styles.studyScroll}>
        {tabs}
        <DoubtsBoard name={name} />
      </div>
    );
  }

  // ---- Landing: create or join --------------------------------------------
  if (!room) {
    return (
      <div style={styles.studyScroll}>
        {tabs}
        <div style={styles.card}>
          <div style={styles.cardHead}>
            <span style={styles.cardClass}>👥 Study Together</span>
          </div>
          <p style={{ color: "var(--muted)", fontSize: 14.5, margin: "0 0 14px" }}>
            Focus alongside other learners. Start a room and share the code, or
            join one — you&apos;ll share a pomodoro timer and a room chat.
          </p>
          {err && <div style={tstyles.err}>{err}</div>}
          <div style={tstyles.landingGrid}>
            <div style={tstyles.landingCol}>
              <div style={tstyles.colTitle}>Start a room</div>
              <input
                style={styles.input}
                placeholder="What are you working on? (optional)"
                value={createTopic}
                maxLength={120}
                onChange={(e) => setCreateTopic(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter")
                    void enter("create", {
                      name: `${name.split(" ")[0]}'s room`,
                      topic: createTopic.trim() || undefined,
                    });
                }}
              />
              <button
                style={styles.primaryBtn}
                disabled={busy}
                onClick={() =>
                  void enter("create", {
                    name: `${name.split(" ")[0]}'s room`,
                    topic: createTopic.trim() || undefined,
                  })
                }
              >
                {busy ? "Creating…" : "Create room"}
              </button>
            </div>
            <div style={tstyles.landingCol}>
              <div style={tstyles.colTitle}>Join a room</div>
              <input
                style={{
                  ...styles.input,
                  textTransform: "uppercase",
                  letterSpacing: 2,
                  fontWeight: 700,
                }}
                placeholder="Enter code"
                value={joinCode}
                maxLength={6}
                onChange={(e) =>
                  setJoinCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter" && joinCode.length === 6)
                    void enter("join", { code: joinCode });
                }}
              />
              <button
                style={styles.secondaryBtn}
                disabled={busy || joinCode.length !== 6}
                onClick={() => void enter("join", { code: joinCode })}
              >
                Join room
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ---- In a room -----------------------------------------------------------
  const present = room.members
    .filter((m) => now - m.lastSeen < TOGETHER_PRESENCE_MS)
    .sort((a, b) => b.lastSeen - a.lastSeen);
  const remaining = togetherRemaining(room.timer, now);
  const running = room.timer.running && room.timer.mode !== "idle";
  const paused = !room.timer.running && room.timer.mode !== "idle";
  const isFocus = room.timer.mode === "focus";
  const timeUp = running && remaining <= 0;

  return (
    <div style={styles.studyScroll}>
      {tabs}
      {/* Header */}
      <div style={styles.card}>
        <div style={{ ...styles.cardHead, marginBottom: 2 }}>
          <span style={styles.cardClass}>👥 {room.name}</span>
          <button style={styles.linkBtn} onClick={() => void leave()}>
            Leave
          </button>
        </div>
        {room.topic && (
          <div style={{ color: "var(--muted)", fontSize: 14, marginBottom: 8 }}>
            {room.topic}
          </div>
        )}
        <div style={tstyles.codeRow}>
          <span style={{ color: "var(--muted)", fontSize: 13 }}>Room code</span>
          <button
            style={tstyles.codeChip}
            title="Copy code"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(room.code);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              } catch {
                /* ignore */
              }
            }}
          >
            {room.code} {copied ? "✓" : "⧉"}
          </button>
        </div>
      </div>

      {/* Shared timer */}
      <div style={styles.card}>
        <div style={styles.cardHead}>
          <span style={styles.cardClass}>⏱️ Shared timer</span>
          {room.timer.mode !== "idle" && (
            <span style={tstyles.phasePill(isFocus)}>
              {isFocus ? "Focus" : "Break"}
            </span>
          )}
        </div>
        <div style={tstyles.clock(timeUp)}>
          {timeUp ? "Time's up!" : togetherClock(remaining)}
        </div>
        <div style={tstyles.timerBtns}>
          {room.timer.mode === "idle" || timeUp ? (
            <>
              <button
                style={styles.primaryBtn}
                onClick={() => void act({ action: "timer", timer: "focus" })}
              >
                Start focus · 25m
              </button>
              <button
                style={styles.secondaryBtn}
                onClick={() => void act({ action: "timer", timer: "break" })}
              >
                Break · 5m
              </button>
            </>
          ) : (
            <>
              {running ? (
                <button
                  style={styles.secondaryBtn}
                  onClick={() => void act({ action: "timer", timer: "pause" })}
                >
                  Pause
                </button>
              ) : (
                <button
                  style={styles.primaryBtn}
                  onClick={() => void act({ action: "timer", timer: "resume" })}
                >
                  Resume
                </button>
              )}
              <button
                style={styles.secondaryBtn}
                onClick={() => void act({ action: "timer", timer: "reset" })}
              >
                Reset
              </button>
            </>
          )}
        </div>
        {room.timer.updatedBy && (
          <div style={{ color: "var(--muted)", fontSize: 12, marginTop: 8 }}>
            {paused ? "Paused" : "Set"} by {room.timer.updatedBy}
          </div>
        )}
      </div>

      {/* Presence */}
      <div style={styles.card}>
        <div style={styles.cardHead}>
          <span style={styles.cardClass}>
            🟢 Studying now · {present.length}
          </span>
        </div>
        <div style={tstyles.avatars}>
          {present.map((m) => (
            <span key={m.id} style={tstyles.avatar} title={m.name}>
              <span style={tstyles.avatarDot} />
              {m.name}
            </span>
          ))}
        </div>
      </div>

      {/* Chat */}
      <div style={styles.card}>
        <div style={styles.cardHead}>
          <span style={styles.cardClass}>💬 Room chat</span>
        </div>
        <div style={tstyles.chatLog}>
          {room.messages.length === 0 ? (
            <div style={{ color: "var(--muted)", fontSize: 13.5, padding: "8px 2px" }}>
              Say hi 👋 — messages are visible to everyone in the room.
            </div>
          ) : (
            room.messages.map((m) => {
              const mine = m.memberId === memberIdRef.current;
              return (
                <div
                  key={m.id}
                  style={{ ...tstyles.msg, alignItems: mine ? "flex-end" : "flex-start" }}
                >
                  <div style={tstyles.msgMeta}>{mine ? "You" : m.name}</div>
                  <div style={tstyles.msgBubble(mine)}>{m.text}</div>
                </div>
              );
            })
          )}
          <div ref={chatEndRef} />
        </div>
        <div style={tstyles.chatRow}>
          <input
            style={styles.input}
            placeholder="Message the room…"
            value={draft}
            maxLength={500}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") sendChat();
            }}
          />
          <button
            style={styles.primaryBtn}
            disabled={!draft.trim()}
            onClick={sendChat}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

// Local styles for Study Together (kept next to the component; reuse the shared
// CSS variables so it themes with the rest of the app).
const tstyles = {
  err: {
    background: "var(--assistant-bubble)",
    color: "var(--accent)",
    borderRadius: 10,
    padding: "10px 12px",
    fontSize: 14,
    marginBottom: 12,
  } as React.CSSProperties,
  landingGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 14,
  } as React.CSSProperties,
  landingCol: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
    minWidth: 0,
  } as React.CSSProperties,
  colTitle: {
    fontSize: 13,
    fontWeight: 700,
    color: "var(--muted)",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  } as React.CSSProperties,
  codeRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    marginTop: 4,
  } as React.CSSProperties,
  codeChip: {
    fontFamily: "ui-monospace, Menlo, monospace",
    fontSize: 20,
    fontWeight: 800,
    letterSpacing: 3,
    color: "var(--accent)",
    background: "var(--assistant-bubble)",
    border: "1px solid var(--border)",
    borderRadius: 10,
    padding: "6px 14px",
    cursor: "pointer",
  } as React.CSSProperties,
  clock: (up: boolean): React.CSSProperties => ({
    fontSize: up ? 34 : 52,
    fontWeight: 800,
    textAlign: "center",
    fontVariantNumeric: "tabular-nums",
    color: up ? "var(--accent)" : "var(--assistant-text)",
    padding: "10px 0 14px",
    letterSpacing: 1,
  }),
  phasePill: (focus: boolean): React.CSSProperties => ({
    fontSize: 12,
    fontWeight: 700,
    padding: "3px 10px",
    borderRadius: 999,
    color: "#fff",
    background: focus ? "var(--accent)" : "#3b9e6f",
  }),
  timerBtns: {
    display: "flex",
    gap: 10,
    justifyContent: "center",
    flexWrap: "wrap",
  } as React.CSSProperties,
  avatars: { display: "flex", flexWrap: "wrap", gap: 8 } as React.CSSProperties,
  avatar: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    background: "var(--assistant-bubble)",
    border: "1px solid var(--border)",
    borderRadius: 999,
    padding: "5px 12px 5px 10px",
    fontSize: 13.5,
    fontWeight: 600,
    color: "var(--assistant-text)",
  } as React.CSSProperties,
  avatarDot: {
    width: 8,
    height: 8,
    borderRadius: 999,
    background: "#37b26b",
    display: "inline-block",
  } as React.CSSProperties,
  chatLog: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
    maxHeight: 300,
    overflowY: "auto",
    padding: "4px 2px 10px",
  } as React.CSSProperties,
  msg: { display: "flex", flexDirection: "column", gap: 2 } as React.CSSProperties,
  msgMeta: { fontSize: 11, color: "var(--muted)", padding: "0 6px" } as React.CSSProperties,
  msgBubble: (mine: boolean): React.CSSProperties => ({
    maxWidth: "80%",
    padding: "8px 12px",
    borderRadius: 14,
    fontSize: 14.5,
    lineHeight: 1.4,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    color: mine ? "#fff" : "var(--assistant-text)",
    background: mine ? "var(--accent)" : "var(--assistant-bubble)",
  }),
  chatRow: { display: "flex", gap: 8, marginTop: 10 } as React.CSSProperties,
};

// --- Doubts board -------------------------------------------------------------
// The asynchronous half of Study Together: post what you're stuck on with your
// working shown, and other learners answer in a Reddit-style thread — nested
// replies, up/down votes, and the asker marks the answer that unstuck them.
//
// Two scopes: the global feed (everyone on Eliora) or a private group you join
// with a code. Group codes live in localStorage, so "my groups" is per-device
// exactly like the room id — knowing the code is membership.
//
// Types and the pure ranking/threading helpers come from @eliora/shared; unlike
// StudyTogether above (which predates them) this imports them directly rather
// than keeping client-side copies.
type DoubtGroupRef = { code: string; name: string };

const DOUBT_GROUPS_KEY = "eliora-doubt-groups";
const DOUBT_SCOPE_KEY = "eliora-doubt-scope";

function DoubtsBoard({ name }: { name: string }) {
  // Per-device id, shared with Study Together so your posts and your room
  // presence are the same "you".
  const [memberId, setMemberId] = useState("");
  const [groups, setGroups] = useState<DoubtGroupRef[]>([]);
  const [scope, setScope] = useState<string>(DOUBT_GLOBAL_SCOPE);
  const [doubts, setDoubts] = useState<Doubt[]>([]);
  const [sort, setSort] = useState<DoubtSort>("top");
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState("");
  const [now, setNow] = useState(() => Date.now());

  // Which thread is expanded, and where a reply box is currently open.
  const [openId, setOpenId] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<{ doubtId: string; parentId?: string } | null>(
    null,
  );
  const [replyText, setReplyText] = useState("");
  const [replyWork, setReplyWork] = useState("");
  const [replyShowWork, setReplyShowWork] = useState(false);

  // The "ask a doubt" composer.
  const [asking, setAsking] = useState(false);
  const [title, setTitle] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [work, setWork] = useState("");
  const [busy, setBusy] = useState(false);

  // The group create/join panel.
  const [showGroups, setShowGroups] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [copied, setCopied] = useState(false);

  // Restore identity, saved groups, and the last scope viewed.
  useEffect(() => {
    let id = localStorage.getItem(TOGETHER_ID_KEY);
    if (!id) {
      id =
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `m-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
      localStorage.setItem(TOGETHER_ID_KEY, id);
    }
    setMemberId(id);
    try {
      const saved = JSON.parse(localStorage.getItem(DOUBT_GROUPS_KEY) ?? "[]");
      if (Array.isArray(saved)) setGroups(saved);
    } catch {
      /* corrupt entry — start with no groups */
    }
    const last = localStorage.getItem(DOUBT_SCOPE_KEY);
    if (last) setScope(last);
  }, []);

  // Relative bylines ("2h ago") only need a slow tick.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const saveGroups = useCallback((next: DoubtGroupRef[]) => {
    setGroups(next);
    localStorage.setItem(DOUBT_GROUPS_KEY, JSON.stringify(next));
  }, []);

  const pickScope = useCallback((next: string) => {
    setScope(next);
    setOpenId(null);
    setReplyTo(null);
    setLoaded(false);
    setErr("");
    localStorage.setItem(DOUBT_SCOPE_KEY, next);
  }, []);

  // Poll the feed. Slower than a study room (2.5s) — a doubts board is
  // asynchronous by nature, so every few seconds is plenty. Reading is
  // anonymous; memberId only decides which posts render as "You".
  useEffect(() => {
    let alive = true;
    async function poll() {
      try {
        const res = await fetch(
          `/api/doubts?scope=${encodeURIComponent(scope)}`,
          { cache: "no-store" },
        );
        if (!alive) return;
        if (res.status === 404) {
          // The saved group is gone — fall back to the global feed.
          setErr("That group no longer exists.");
          setLoaded(true);
          pickScope(DOUBT_GLOBAL_SCOPE);
          return;
        }
        const data = (await res.json()) as { feed?: { doubts: Doubt[] } };
        if (alive && data.feed) {
          setDoubts(data.feed.doubts);
          setLoaded(true);
        }
      } catch {
        /* transient — the next tick retries */
      }
    }
    void poll();
    const t = setInterval(poll, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [scope, pickScope]);

  // Fire an action and adopt the returned feed so the UI updates immediately
  // instead of waiting for the next poll.
  async function act(payload: Record<string, unknown>): Promise<boolean> {
    try {
      const res = await fetch("/api/doubts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope, memberId, memberName: name, ...payload }),
      });
      const data = (await res.json()) as {
        feed?: { doubts: Doubt[] };
        error?: string;
      };
      if (data.feed) {
        setDoubts(data.feed.doubts);
        return true;
      }
      setErr(data.error || "That didn't go through — try again.");
      return false;
    } catch {
      setErr("Couldn't reach the server. Please try again.");
      return false;
    }
  }

  async function submitAsk() {
    if (!title.trim() || busy) return;
    setBusy(true);
    setErr("");
    const ok = await act({
      action: "ask",
      title,
      subject: subject.trim() || undefined,
      text: body,
      work: work.trim() || undefined,
    });
    setBusy(false);
    if (ok) {
      setAsking(false);
      setTitle("");
      setSubject("");
      setBody("");
      setWork("");
      // A brand-new doubt has no votes, so it only shows up under "New".
      setSort("new");
    }
  }

  async function submitReply() {
    if (!replyTo || busy) return;
    if (!replyText.trim() && !replyWork.trim()) return;
    setBusy(true);
    setErr("");
    const ok = await act({
      action: "reply",
      doubtId: replyTo.doubtId,
      parentId: replyTo.parentId,
      text: replyText,
      work: replyWork.trim() || undefined,
    });
    setBusy(false);
    if (ok) {
      setReplyTo(null);
      setReplyText("");
      setReplyWork("");
      setReplyShowWork(false);
    }
  }

  async function makeGroup() {
    const wanted = groupName.trim();
    if (!wanted || busy) return;
    setBusy(true);
    setErr("");
    try {
      const res = await fetch("/api/doubts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create-group",
          name: wanted,
          memberId,
          memberName: name,
        }),
      });
      const data = (await res.json()) as { group?: DoubtGroup; error?: string };
      if (data.group) {
        saveGroups([
          ...groups.filter((g) => g.code !== data.group!.code),
          { code: data.group.code, name: data.group.name },
        ]);
        setGroupName("");
        setShowGroups(false);
        pickScope(data.group.code);
      } else {
        setErr(data.error || "Couldn't create that group.");
      }
    } catch {
      setErr("Couldn't reach the server. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function enterGroup() {
    const code = joinCode.trim().toUpperCase();
    if (code.length !== 6 || busy) return;
    setBusy(true);
    setErr("");
    try {
      const res = await fetch("/api/doubts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "join-group",
          code,
          memberId,
          memberName: name,
        }),
      });
      const data = (await res.json()) as { group?: DoubtGroup; error?: string };
      if (data.group) {
        saveGroups([
          ...groups.filter((g) => g.code !== data.group!.code),
          { code: data.group.code, name: data.group.name },
        ]);
        setJoinCode("");
        setShowGroups(false);
        pickScope(data.group.code);
      } else {
        setErr(data.error || "No group with that code.");
      }
    } catch {
      setErr("Couldn't reach the server. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  // Leaving a group is purely local — the code is the membership, so we just
  // forget it on this device.
  function forgetGroup(code: string) {
    saveGroups(groups.filter((g) => g.code !== code));
    if (scope === code) pickScope(DOUBT_GLOBAL_SCOPE);
  }

  const activeGroup = groups.find((g) => g.code === scope) ?? null;
  const visible = sortDoubts(doubts, sort);
  const helps = countDoubtHelps(doubts, memberId);
  const unanswered = doubts.filter((d) => d.replies.length === 0).length;

  function cancelReply() {
    setReplyTo(null);
    setReplyText("");
    setReplyWork("");
    setReplyShowWork(false);
  }

  // There's only ever one reply box open at a time, so a single element is
  // handed to whichever row is composing.
  const composer = (
    <DoubtReplyComposer
      text={replyText}
      work={replyWork}
      showWork={replyShowWork}
      busy={busy}
      onText={setReplyText}
      onWork={setReplyWork}
      onShowWork={() => setReplyShowWork(true)}
      onSubmit={() => void submitReply()}
      onCancel={cancelReply}
    />
  );

  return (
    <>
      {/* Scope: the global feed, or one of your groups */}
      <div style={styles.card}>
        <div style={styles.cardHead}>
          <span style={styles.cardClass}>🙋 Doubts</span>
          {helps > 0 && (
            <span style={dstyles.karma} title="Answers people marked as what helped">
              ⭐ Helped {helps}
            </span>
          )}
        </div>
        <p style={{ color: "var(--muted)", fontSize: 14.5, margin: "0 0 12px" }}>
          Stuck on something? Post it with what you&apos;ve already tried, and
          other learners answer in a thread. Help someone else and they can mark
          your answer as the one that unstuck them.
        </p>
        <div style={dstyles.scopeRow}>
          <button
            style={dstyles.scopeChip(scope === DOUBT_GLOBAL_SCOPE)}
            onClick={() => pickScope(DOUBT_GLOBAL_SCOPE)}
          >
            🌍 Global
          </button>
          {groups.map((g) => (
            <button
              key={g.code}
              style={dstyles.scopeChip(scope === g.code)}
              onClick={() => pickScope(g.code)}
              title={`Group code ${g.code}`}
            >
              👥 {g.name}
            </button>
          ))}
          <button
            style={dstyles.scopeChip(false)}
            onClick={() => setShowGroups((v) => !v)}
          >
            {showGroups ? "× Close" : "+ Group"}
          </button>
        </div>

        {showGroups && (
          <div style={{ ...tstyles.landingGrid, marginTop: 14 }}>
            <div style={tstyles.landingCol}>
              <div style={tstyles.colTitle}>Start a group</div>
              <input
                style={styles.input}
                placeholder="e.g. Chem class"
                value={groupName}
                maxLength={40}
                onChange={(e) => setGroupName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void makeGroup();
                }}
              />
              <button
                style={styles.primaryBtn}
                disabled={busy || !groupName.trim()}
                onClick={() => void makeGroup()}
              >
                Create group
              </button>
            </div>
            <div style={tstyles.landingCol}>
              <div style={tstyles.colTitle}>Join a group</div>
              <input
                style={{
                  ...styles.input,
                  textTransform: "uppercase",
                  letterSpacing: 2,
                  fontWeight: 700,
                }}
                placeholder="Enter code"
                value={joinCode}
                maxLength={6}
                onChange={(e) =>
                  setJoinCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter" && joinCode.length === 6) void enterGroup();
                }}
              />
              <button
                style={styles.secondaryBtn}
                disabled={busy || joinCode.length !== 6}
                onClick={() => void enterGroup()}
              >
                Join group
              </button>
            </div>
          </div>
        )}

        {activeGroup && (
          <div style={{ ...tstyles.codeRow, marginTop: 12 }}>
            <span style={{ color: "var(--muted)", fontSize: 13 }}>
              Invite to {activeGroup.name}
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <button
                style={tstyles.codeChip}
                title="Copy code"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(activeGroup.code);
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 1500);
                  } catch {
                    /* ignore */
                  }
                }}
              >
                {activeGroup.code} {copied ? "✓" : "⧉"}
              </button>
              <button
                style={styles.linkBtn}
                onClick={() => forgetGroup(activeGroup.code)}
              >
                Leave
              </button>
            </span>
          </div>
        )}
        {err && <div style={{ ...tstyles.err, marginTop: 12, marginBottom: 0 }}>{err}</div>}
      </div>

      {/* Ask */}
      <div style={styles.card}>
        {asking ? (
          <>
            <div style={styles.cardHead}>
              <span style={styles.cardClass}>
                Ask {activeGroup ? activeGroup.name : "everyone"}
              </span>
            </div>
            <div style={dstyles.composer}>
              <input
                style={styles.input}
                placeholder="What are you stuck on? (one line)"
                value={title}
                maxLength={DOUBT_TITLE_MAX}
                autoFocus
                onChange={(e) => setTitle(e.target.value)}
              />
              <input
                style={styles.input}
                placeholder="Subject (optional) — e.g. Physics"
                value={subject}
                maxLength={40}
                onChange={(e) => setSubject(e.target.value)}
              />
              <textarea
                style={{ ...styles.input, minHeight: 90 }}
                placeholder="Give the full question and where exactly it stops making sense…"
                value={body}
                maxLength={DOUBT_BODY_MAX}
                onChange={(e) => setBody(e.target.value)}
              />
              <textarea
                style={{
                  ...styles.input,
                  minHeight: 90,
                  fontFamily: "ui-monospace, Menlo, monospace",
                }}
                placeholder={"What you've tried so far (optional but you'll get better answers)…\n1) …\n2) …"}
                value={work}
                maxLength={DOUBT_WORK_MAX}
                onChange={(e) => setWork(e.target.value)}
              />
              <div style={dstyles.composerBtns}>
                <button
                  style={styles.primaryBtn}
                  disabled={busy || !title.trim()}
                  onClick={() => void submitAsk()}
                >
                  {busy ? "Posting…" : "Post doubt"}
                </button>
                <button style={styles.secondaryBtn} onClick={() => setAsking(false)}>
                  Cancel
                </button>
              </div>
            </div>
          </>
        ) : (
          <button style={dstyles.askBtn} onClick={() => setAsking(true)}>
            🙋 Ask a doubt{activeGroup ? ` in ${activeGroup.name}` : ""}…
          </button>
        )}
      </div>

      {/* Feed */}
      <div style={styles.card}>
        <div style={styles.tabBar}>
          {(
            [
              ["top", "🔥 Top"],
              ["new", "🕒 New"],
              ["unanswered", `🫥 Unanswered${unanswered ? ` · ${unanswered}` : ""}`],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              style={{
                ...styles.viewTab,
                ...(sort === key ? styles.viewTabActive : {}),
              }}
              onClick={() => setSort(key)}
            >
              {label}
            </button>
          ))}
        </div>

        {!loaded ? (
          <p style={{ color: "var(--muted)", fontSize: 14 }}>Loading doubts…</p>
        ) : visible.length === 0 ? (
          <p style={{ color: "var(--muted)", fontSize: 14 }}>
            {sort === "unanswered"
              ? "Nothing unanswered right now — everyone's been helped 🎉"
              : activeGroup
                ? `No doubts in ${activeGroup.name} yet. Be the first to ask.`
                : "No doubts yet. Ask the first one — someone will pick it up."}
          </p>
        ) : (
          <div style={dstyles.feed}>
            {visible.map((d) => {
              const open = openId === d.id;
              const mine = d.authorId === memberId;
              const vote = myVote(d.votes, memberId);
              const solved = Boolean(d.solvedReplyId);
              return (
                <div key={d.id} style={dstyles.post(open)}>
                  <div style={dstyles.replyRow}>
                    <div style={dstyles.voteCol}>
                      <button
                        style={dstyles.arrow(vote === 1)}
                        title="Good question"
                        disabled={mine}
                        onClick={() =>
                          void act({ action: "vote", doubtId: d.id, value: 1 })
                        }
                      >
                        ▲
                      </button>
                      <span style={dstyles.score(vote)}>{doubtScore(d.votes)}</span>
                      <button
                        style={dstyles.arrow(vote === -1)}
                        title="Not useful"
                        disabled={mine}
                        onClick={() =>
                          void act({ action: "vote", doubtId: d.id, value: -1 })
                        }
                      >
                        ▼
                      </button>
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <button
                        style={dstyles.titleBtn}
                        onClick={() => setOpenId(open ? null : d.id)}
                      >
                        {d.title}
                      </button>
                      <div style={dstyles.byline}>
                        {d.subject && <span style={dstyles.subjectPill}>{d.subject}</span>}
                        {solved && <span style={dstyles.solvedPill}>✓ Solved</span>}
                        <span>
                          {mine ? "You" : d.authorName} · {doubtAgo(d.createdAt, now)} ·{" "}
                          {d.replies.length === 0
                            ? "no answers yet"
                            : `${d.replies.length} ${
                                d.replies.length === 1 ? "answer" : "answers"
                              }`}
                        </span>
                      </div>

                      {open && (
                        <>
                          {d.body && <div style={dstyles.bodyText}>{d.body}</div>}
                          {d.work && (
                            <div style={dstyles.workBlock}>
                              <div style={dstyles.workLabel}>What they&apos;ve tried</div>
                              {d.work}
                            </div>
                          )}
                          <div style={dstyles.actionRow}>
                            <button
                              style={styles.linkBtn}
                              onClick={() =>
                                setReplyTo(
                                  replyTo?.doubtId === d.id && !replyTo.parentId
                                    ? null
                                    : { doubtId: d.id },
                                )
                              }
                            >
                              {replyTo?.doubtId === d.id && !replyTo.parentId
                                ? "Cancel"
                                : "Answer this"}
                            </button>
                            {mine && (
                              <button
                                style={styles.linkBtn}
                                onClick={() =>
                                  void act({ action: "delete", doubtId: d.id })
                                }
                              >
                                Delete
                              </button>
                            )}
                          </div>
                          {replyTo?.doubtId === d.id && !replyTo.parentId && composer}
                          {d.replies.length > 0 && (
                            <div style={dstyles.thread}>
                              {buildDoubtTree(d).map((node) => (
                                <DoubtBranch
                                  key={node.reply.id}
                                  node={node}
                                  doubt={d}
                                  memberId={memberId}
                                  now={now}
                                  replyTo={replyTo}
                                  onReplyTo={setReplyTo}
                                  onAct={act}
                                  composer={composer}
                                />
                              ))}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}

// The reply box, shared by "Answer this" and every nested Reply link. Defined
// at module scope (not inside DoubtsBoard) so React keeps the same element type
// across renders — an inline component would remount the textarea on every
// keystroke and steal the caret.
function DoubtReplyComposer({
  text,
  work,
  showWork,
  busy,
  onText,
  onWork,
  onShowWork,
  onSubmit,
  onCancel,
}: {
  text: string;
  work: string;
  showWork: boolean;
  busy: boolean;
  onText: (v: string) => void;
  onWork: (v: string) => void;
  onShowWork: () => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <div style={dstyles.composer}>
      <textarea
        style={{ ...styles.input, minHeight: 70 }}
        placeholder="Explain it the way you'd want it explained to you…"
        value={text}
        maxLength={DOUBT_REPLY_MAX}
        autoFocus
        onChange={(e) => onText(e.target.value)}
      />
      {showWork ? (
        <textarea
          style={{
            ...styles.input,
            minHeight: 90,
            fontFamily: "ui-monospace, Menlo, monospace",
          }}
          placeholder={"Your working, step by step…\n1) …\n2) …"}
          value={work}
          maxLength={DOUBT_WORK_MAX}
          onChange={(e) => onWork(e.target.value)}
        />
      ) : (
        <button style={styles.linkBtn} onClick={onShowWork}>
          + Show your working
        </button>
      )}
      <div style={dstyles.composerBtns}>
        <button
          style={styles.primaryBtn}
          disabled={busy || (!text.trim() && !work.trim())}
          onClick={onSubmit}
        >
          {busy ? "Posting…" : "Post answer"}
        </button>
        <button style={styles.secondaryBtn} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// One reply and its children, rendered recursively — the Reddit-style thread.
// Also module-scope, for the same remount reason as the composer above.
function DoubtBranch({
  node,
  doubt,
  memberId,
  now,
  replyTo,
  onReplyTo,
  onAct,
  composer,
}: {
  node: DoubtReplyNode;
  doubt: Doubt;
  memberId: string;
  now: number;
  replyTo: { doubtId: string; parentId?: string } | null;
  onReplyTo: (v: { doubtId: string; parentId?: string } | null) => void;
  onAct: (payload: Record<string, unknown>) => Promise<boolean>;
  composer: ReactNode;
}) {
  const r = node.reply;
  const mine = r.authorId === memberId;
  const accepted = doubt.solvedReplyId === r.id;
  const vote = myVote(r.votes, memberId);
  const composing = replyTo?.doubtId === doubt.id && replyTo.parentId === r.id;

  return (
    <div style={dstyles.branch(node.depth)}>
      <div style={dstyles.replyRow}>
        <div style={dstyles.voteColSm}>
          <button
            style={dstyles.arrow(vote === 1)}
            title="Helpful"
            disabled={mine}
            onClick={() =>
              void onAct({ action: "vote", doubtId: doubt.id, replyId: r.id, value: 1 })
            }
          >
            ▲
          </button>
          <span style={dstyles.scoreSm(vote)}>{doubtScore(r.votes)}</span>
          <button
            style={dstyles.arrow(vote === -1)}
            title="Not helpful"
            disabled={mine}
            onClick={() =>
              void onAct({ action: "vote", doubtId: doubt.id, replyId: r.id, value: -1 })
            }
          >
            ▼
          </button>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={dstyles.byline}>
            <strong style={{ color: mine ? "var(--accent)" : "var(--text)" }}>
              {mine ? "You" : r.authorName}
            </strong>
            {r.authorId === doubt.authorId && <span style={dstyles.opPill}>asker</span>}
            {accepted && <span style={dstyles.solvedPill}>✓ This helped</span>}
            <span>· {doubtAgo(r.at, now)}</span>
          </div>
          {r.text && <div style={dstyles.replyText}>{r.text}</div>}
          {r.work && (
            <div style={dstyles.workBlock}>
              <div style={dstyles.workLabel}>Their working</div>
              {r.work}
            </div>
          )}
          <div style={dstyles.actionRow}>
            <button
              style={styles.linkBtn}
              onClick={() =>
                onReplyTo(composing ? null : { doubtId: doubt.id, parentId: r.id })
              }
            >
              {composing ? "Cancel" : "Reply"}
            </button>
            {doubt.authorId === memberId && !mine && (
              <button
                style={styles.linkBtn}
                onClick={() =>
                  void onAct({ action: "accept", doubtId: doubt.id, replyId: r.id })
                }
              >
                {accepted ? "Unmark" : "Mark as what helped"}
              </button>
            )}
            {mine && (
              <button
                style={styles.linkBtn}
                onClick={() =>
                  void onAct({ action: "delete", doubtId: doubt.id, replyId: r.id })
                }
              >
                Delete
              </button>
            )}
          </div>
          {composing && composer}
        </div>
      </div>
      {node.children.map((child) => (
        <DoubtBranch
          key={child.reply.id}
          node={child}
          doubt={doubt}
          memberId={memberId}
          now={now}
          replyTo={replyTo}
          onReplyTo={onReplyTo}
          onAct={onAct}
          composer={composer}
        />
      ))}
    </div>
  );
}

// Local styles for the doubts board (same convention as tstyles above: kept
// next to the component, themed off the shared CSS variables).
const dstyles = {
  scopeRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: 8,
  } as React.CSSProperties,
  scopeChip: (active: boolean): React.CSSProperties => ({
    background: active ? "var(--accent)" : "var(--surface)",
    color: active ? "#fff" : "var(--muted)",
    border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
    borderRadius: 999,
    padding: "7px 14px",
    fontSize: 13.5,
    fontWeight: 600,
    cursor: "pointer",
    maxWidth: 220,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  }),
  karma: {
    fontSize: 12.5,
    fontWeight: 700,
    color: "var(--accent)",
    background: "var(--assistant-bubble)",
    border: "1px solid var(--border)",
    borderRadius: 999,
    padding: "3px 10px",
    whiteSpace: "nowrap",
  } as React.CSSProperties,
  askBtn: {
    width: "100%",
    textAlign: "left",
    background: "var(--assistant-bubble)",
    color: "var(--muted)",
    border: "1px dashed var(--border-strong)",
    borderRadius: "var(--radius-md)",
    padding: "14px 16px",
    fontSize: 15,
    cursor: "pointer",
  } as React.CSSProperties,
  composer: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
    alignItems: "stretch",
    marginTop: 8,
  } as React.CSSProperties,
  composerBtns: {
    display: "flex",
    gap: 10,
    flexWrap: "wrap",
  } as React.CSSProperties,
  feed: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
  } as React.CSSProperties,
  post: (open: boolean): React.CSSProperties => ({
    border: `1px solid ${open ? "var(--accent)" : "var(--border)"}`,
    borderRadius: "var(--radius-md)",
    padding: "12px 14px",
    background: open ? "var(--surface)" : "transparent",
  }),
  replyRow: { display: "flex", gap: 10, alignItems: "flex-start" } as React.CSSProperties,
  voteCol: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 1,
    paddingTop: 2,
    minWidth: 30,
  } as React.CSSProperties,
  voteColSm: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 0,
    minWidth: 24,
  } as React.CSSProperties,
  arrow: (on: boolean): React.CSSProperties => ({
    background: "transparent",
    border: "none",
    cursor: "pointer",
    fontSize: 13,
    lineHeight: 1.1,
    padding: 1,
    color: on ? "var(--accent)" : "var(--muted)",
    opacity: on ? 1 : 0.65,
  }),
  score: (vote: number): React.CSSProperties => ({
    fontSize: 14,
    fontWeight: 800,
    fontVariantNumeric: "tabular-nums",
    color: vote !== 0 ? "var(--accent)" : "var(--text)",
  }),
  scoreSm: (vote: number): React.CSSProperties => ({
    fontSize: 12.5,
    fontWeight: 700,
    fontVariantNumeric: "tabular-nums",
    color: vote !== 0 ? "var(--accent)" : "var(--muted)",
  }),
  titleBtn: {
    background: "transparent",
    border: "none",
    padding: 0,
    textAlign: "left",
    fontSize: 15.5,
    fontWeight: 700,
    lineHeight: 1.35,
    color: "var(--text)",
    cursor: "pointer",
  } as React.CSSProperties,
  byline: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 6,
    fontSize: 12.5,
    color: "var(--muted)",
    marginTop: 4,
  } as React.CSSProperties,
  subjectPill: {
    fontSize: 11,
    fontWeight: 700,
    color: "var(--assistant-text)",
    background: "var(--assistant-bubble)",
    borderRadius: 999,
    padding: "2px 8px",
  } as React.CSSProperties,
  solvedPill: {
    fontSize: 11,
    fontWeight: 700,
    color: "#fff",
    background: "#3b9e6f",
    borderRadius: 999,
    padding: "2px 8px",
  } as React.CSSProperties,
  opPill: {
    fontSize: 11,
    fontWeight: 700,
    color: "#fff",
    background: "var(--accent)",
    borderRadius: 999,
    padding: "2px 8px",
  } as React.CSSProperties,
  bodyText: {
    fontSize: 14.5,
    lineHeight: 1.55,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    margin: "10px 0 0",
  } as React.CSSProperties,
  replyText: {
    fontSize: 14,
    lineHeight: 1.5,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    margin: "4px 0 0",
  } as React.CSSProperties,
  // The "show your work" panel: monospaced and boxed so step-by-step working
  // stays legible instead of reading as another paragraph of prose.
  workBlock: {
    fontFamily: "ui-monospace, Menlo, monospace",
    fontSize: 13,
    lineHeight: 1.6,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    background: "var(--assistant-bubble)",
    border: "1px solid var(--border)",
    borderRadius: 10,
    padding: "10px 12px",
    marginTop: 10,
  } as React.CSSProperties,
  workLabel: {
    fontFamily: "inherit",
    fontSize: 11,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    color: "var(--muted)",
    marginBottom: 6,
  } as React.CSSProperties,
  actionRow: {
    display: "flex",
    gap: 14,
    flexWrap: "wrap",
    marginTop: 8,
  } as React.CSSProperties,
  thread: {
    marginTop: 12,
    paddingTop: 10,
    borderTop: "1px solid var(--border)",
    display: "flex",
    flexDirection: "column",
    gap: 12,
  } as React.CSSProperties,
  // Nested replies get a left rule per level, Reddit-style. Depth is clamped
  // server-side (DOUBT_MAX_DEPTH) so the indent can't run off a phone screen.
  branch: (depth: number): React.CSSProperties => ({
    marginLeft: depth === 0 ? 0 : 12,
    paddingLeft: depth === 0 ? 0 : 10,
    borderLeft: depth === 0 ? "none" : "2px solid var(--border)",
    display: "flex",
    flexDirection: "column",
    gap: 12,
  }),
};

// ---------------------------------------------------------------------------
// Shared folder — a study space two friends keep in sync (client-side copies of
// the @eliora/shared types, matching how StudyTogether above keeps its own).
// Friends share the join code and stock the folder with upcoming tests,
// projects, assignments, and notes; everyone can add, tick off, and remove.
// ---------------------------------------------------------------------------
type FolderItemKind = "test" | "project" | "assignment" | "note";
type FolderItem = {
  id: string;
  kind: FolderItemKind;
  title: string;
  subject?: string;
  due?: string;
  details?: string;
  done: boolean;
  addedBy: string;
  addedById: string;
  createdAt: number;
  updatedAt: number;
};
type FolderMember = { id: string; name: string; lastSeen: number };
type SharedFolderData = {
  code: string;
  name: string;
  createdAt: number;
  members: FolderMember[];
  items: FolderItem[];
};

const FOLDER_KINDS: readonly FolderItemKind[] = [
  "test",
  "project",
  "assignment",
  "note",
];
const FOLDER_KIND_META: Record<
  FolderItemKind,
  { label: string; emoji: string }
> = {
  test: { label: "Test", emoji: "📝" },
  project: { label: "Project", emoji: "🛠️" },
  assignment: { label: "Assignment", emoji: "📚" },
  note: { label: "Note", emoji: "📌" },
};
const FOLDER_PRESENCE_MS = 30_000;
const FOLDER_LAST_KEY = "eliora-folder-last";

// Order: still-to-do first (soonest due, undated last), done sink to the bottom.
function sortFolderItems(items: FolderItem[]): FolderItem[] {
  const rank = (it: FolderItem): number => {
    if (it.done) return Number.MAX_SAFE_INTEGER;
    return it.due
      ? new Date(`${it.due}T00:00:00`).getTime()
      : Number.MAX_SAFE_INTEGER - 1;
  };
  return [...items].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    return a.createdAt - b.createdAt;
  });
}

// A friendly "when is this due" label + urgency tone for coloring.
function folderDueLabel(
  due: string,
  now: number,
): { text: string; tone: "over" | "soon" | "later" } {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const target = new Date(`${due}T00:00:00`);
  const days = Math.round((target.getTime() - today.getTime()) / 86_400_000);
  if (days < 0) return { text: `${-days}d overdue`, tone: "over" };
  if (days === 0) return { text: "Due today", tone: "soon" };
  if (days === 1) return { text: "Due tomorrow", tone: "soon" };
  if (days <= 6) return { text: `Due in ${days}d`, tone: "soon" };
  const label = target.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  return { text: `Due ${label}`, tone: "later" };
}

function SharedFolder({ name }: { name: string }) {
  const [folder, setFolder] = useState<SharedFolderData | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [createName, setCreateName] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [copied, setCopied] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  // New-item composer.
  const [draftKind, setDraftKind] = useState<FolderItemKind>("assignment");
  const [draftTitle, setDraftTitle] = useState("");
  const [draftSubject, setDraftSubject] = useState("");
  const [draftDue, setDraftDue] = useState("");
  const [draftDetails, setDraftDetails] = useState("");
  const memberIdRef = useRef<string>("");

  // Stable per-device member id (shared with Study Together) + auto-rejoin.
  useEffect(() => {
    let id = localStorage.getItem(TOGETHER_ID_KEY);
    if (!id) {
      id =
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `m-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
      localStorage.setItem(TOGETHER_ID_KEY, id);
    }
    memberIdRef.current = id;
    const last = localStorage.getItem(FOLDER_LAST_KEY);
    if (last) void enter("join", { code: last }, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll while in a folder so both friends see each other's edits.
  const code = folder?.code;
  useEffect(() => {
    if (!code) return;
    let alive = true;
    async function poll() {
      try {
        const res = await fetch(
          `/api/folders/${code}?memberId=${encodeURIComponent(
            memberIdRef.current,
          )}&name=${encodeURIComponent(name)}`,
          { cache: "no-store" },
        );
        if (!alive) return;
        if (res.status === 404) {
          localStorage.removeItem(FOLDER_LAST_KEY);
          setFolder(null);
          setErr("That folder is no longer available.");
          return;
        }
        const data = (await res.json()) as { folder?: SharedFolderData };
        if (data.folder) {
          setFolder(data.folder);
          setNow(Date.now());
        }
      } catch {
        /* transient — next tick retries */
      }
    }
    void poll();
    const t = setInterval(poll, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [code, name]);

  async function enter(
    action: "create" | "join",
    extra: { name?: string; code?: string },
    silent = false,
  ) {
    if (!silent) {
      setBusy(true);
      setErr("");
    }
    try {
      const res = await fetch("/api/folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          memberId: memberIdRef.current,
          memberName: name,
          ...extra,
        }),
      });
      const data = (await res.json()) as {
        folder?: SharedFolderData;
        error?: string;
      };
      if (data.folder) {
        setFolder(data.folder);
        setNow(Date.now());
        localStorage.setItem(FOLDER_LAST_KEY, data.folder.code);
        setJoinCode("");
        setCreateName("");
      } else if (!silent) {
        setErr(data.error || "Couldn't reach that folder — try again.");
      } else {
        localStorage.removeItem(FOLDER_LAST_KEY);
      }
    } catch {
      if (!silent) setErr("Couldn't reach the server. Please try again.");
    } finally {
      if (!silent) setBusy(false);
    }
  }

  // Fire a folder action and adopt the returned state for a snappy response.
  async function act(body: Record<string, unknown>) {
    if (!folder) return;
    try {
      const res = await fetch(`/api/folders/${folder.code}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memberId: memberIdRef.current, name, ...body }),
      });
      const data = (await res.json()) as { folder?: SharedFolderData };
      if (data.folder) {
        setFolder(data.folder);
        setNow(Date.now());
      }
    } catch {
      /* the poll loop will reconcile */
    }
  }

  function addDraft() {
    const title = draftTitle.trim();
    if (!title) return;
    void act({
      action: "add",
      item: {
        kind: draftKind,
        title,
        subject: draftSubject.trim() || undefined,
        due: draftDue || undefined,
        details: draftDetails.trim() || undefined,
      },
    });
    setDraftTitle("");
    setDraftSubject("");
    setDraftDue("");
    setDraftDetails("");
  }

  async function leave() {
    const current = folder;
    localStorage.removeItem(FOLDER_LAST_KEY);
    setFolder(null);
    if (current) {
      try {
        await fetch(`/api/folders/${current.code}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "leave", memberId: memberIdRef.current }),
        });
      } catch {
        /* presence timeout will drop us anyway */
      }
    }
  }

  // ---- Landing: create or join --------------------------------------------
  if (!folder) {
    return (
      <div style={styles.studyScroll}>
        <div style={styles.card}>
          <div style={styles.cardHead}>
            <span style={styles.cardClass}>🗂️ Shared folder</span>
          </div>
          <p style={{ color: "var(--muted)", fontSize: 14.5, margin: "0 0 14px" }}>
            Share one folder with a friend to keep upcoming tests, projects, and
            assignments in one place. Anyone with the code can add and check off
            items — great for a class or study group.
          </p>
          {err && <div style={tstyles.err}>{err}</div>}
          <div style={tstyles.landingGrid}>
            <div style={tstyles.landingCol}>
              <div style={tstyles.colTitle}>Start a folder</div>
              <input
                style={styles.input}
                placeholder="Folder name (e.g. AP Bio squad)"
                value={createName}
                maxLength={40}
                onChange={(e) => setCreateName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && createName.trim())
                    void enter("create", { name: createName.trim() });
                }}
              />
              <button
                style={styles.primaryBtn}
                disabled={busy || !createName.trim()}
                onClick={() => void enter("create", { name: createName.trim() })}
              >
                {busy ? "Creating…" : "Create folder"}
              </button>
            </div>
            <div style={tstyles.landingCol}>
              <div style={tstyles.colTitle}>Join a folder</div>
              <input
                style={{
                  ...styles.input,
                  textTransform: "uppercase",
                  letterSpacing: 2,
                  fontWeight: 700,
                }}
                placeholder="Enter code"
                value={joinCode}
                maxLength={6}
                onChange={(e) =>
                  setJoinCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter" && joinCode.length === 6)
                    void enter("join", { code: joinCode });
                }}
              />
              <button
                style={styles.secondaryBtn}
                disabled={busy || joinCode.length !== 6}
                onClick={() => void enter("join", { code: joinCode })}
              >
                Join folder
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ---- Inside a folder -----------------------------------------------------
  const present = folder.members
    .filter((m) => now - m.lastSeen < FOLDER_PRESENCE_MS)
    .sort((a, b) => b.lastSeen - a.lastSeen);
  const sorted = sortFolderItems(folder.items);
  const openCount = folder.items.filter((i) => !i.done).length;

  return (
    <div style={styles.studyScroll}>
      {/* Header */}
      <div style={styles.card}>
        <div style={{ ...styles.cardHead, marginBottom: 2 }}>
          {editingName ? (
            <input
              autoFocus
              style={{ ...styles.input, maxWidth: 260 }}
              value={nameDraft}
              maxLength={40}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={() => {
                const n = nameDraft.trim();
                if (n && n !== folder.name)
                  void act({ action: "rename", folderName: n });
                setEditingName(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") setEditingName(false);
              }}
            />
          ) : (
            <span
              style={{ ...styles.cardClass, cursor: "pointer" }}
              title="Rename folder"
              onClick={() => {
                setNameDraft(folder.name);
                setEditingName(true);
              }}
            >
              🗂️ {folder.name}
            </span>
          )}
          <button style={styles.linkBtn} onClick={() => void leave()}>
            Leave
          </button>
        </div>
        <div style={tstyles.codeRow}>
          <span style={{ color: "var(--muted)", fontSize: 13 }}>
            Share code{present.length > 1 ? ` · ${present.length} here now` : ""}
          </span>
          <button
            style={tstyles.codeChip}
            title="Copy code"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(folder.code);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              } catch {
                /* ignore */
              }
            }}
          >
            {folder.code} {copied ? "✓" : "⧉"}
          </button>
        </div>
      </div>

      {/* Add an item */}
      <div style={styles.card}>
        <div style={styles.cardHead}>
          <span style={styles.cardClass}>➕ Add to the folder</span>
        </div>
        <div style={fstyles.kindRow}>
          {FOLDER_KINDS.map((k) => (
            <button
              key={k}
              style={fstyles.kindBtn(draftKind === k)}
              onClick={() => setDraftKind(k)}
            >
              {FOLDER_KIND_META[k].emoji} {FOLDER_KIND_META[k].label}
            </button>
          ))}
        </div>
        <input
          style={{ ...styles.input, marginTop: 10 }}
          placeholder={
            draftKind === "note" ? "What's the note?" : "What is it? (title)"
          }
          value={draftTitle}
          maxLength={160}
          onChange={(e) => setDraftTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") addDraft();
          }}
        />
        <div style={fstyles.metaRow}>
          <input
            style={{ ...styles.input, flex: 1, minWidth: 120 }}
            placeholder="Subject (optional)"
            value={draftSubject}
            maxLength={60}
            onChange={(e) => setDraftSubject(e.target.value)}
          />
          {draftKind !== "note" && (
            <input
              type="date"
              style={{ ...styles.input, flex: 1, minWidth: 150 }}
              value={draftDue}
              onChange={(e) => setDraftDue(e.target.value)}
            />
          )}
        </div>
        <textarea
          style={fstyles.detailsInput}
          placeholder="Details — what it covers, rubric, page count… (optional)"
          value={draftDetails}
          maxLength={600}
          rows={2}
          onChange={(e) => setDraftDetails(e.target.value)}
        />
        <button
          style={{ ...styles.primaryBtn, marginTop: 10 }}
          disabled={!draftTitle.trim()}
          onClick={addDraft}
        >
          Add {FOLDER_KIND_META[draftKind].label.toLowerCase()}
        </button>
      </div>

      {/* The list */}
      <div style={styles.card}>
        <div style={styles.cardHead}>
          <span style={styles.cardClass}>
            📋 {openCount} to do{folder.items.length !== openCount
              ? ` · ${folder.items.length - openCount} done`
              : ""}
          </span>
        </div>
        {folder.items.length === 0 ? (
          <div style={{ color: "var(--muted)", fontSize: 13.5, padding: "8px 2px" }}>
            Nothing here yet. Add a test, project, or assignment above — your
            friend will see it too.
          </div>
        ) : (
          <div style={fstyles.list}>
            {sorted.map((it) => {
              const meta = FOLDER_KIND_META[it.kind];
              const due = it.due && !it.done ? folderDueLabel(it.due, now) : null;
              const mine = it.addedById === memberIdRef.current;
              return (
                <div key={it.id} style={fstyles.item(it.done)}>
                  <button
                    style={fstyles.check(it.done)}
                    title={it.done ? "Mark not done" : "Mark done"}
                    onClick={() =>
                      void act({
                        action: "update",
                        itemId: it.id,
                        patch: { done: !it.done },
                      })
                    }
                  >
                    {it.done ? "✓" : ""}
                  </button>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={fstyles.itemTitle(it.done)}>
                      <span>{meta.emoji}</span>
                      <span>{it.title}</span>
                    </div>
                    <div style={fstyles.chipRow}>
                      <span style={fstyles.kindChip}>{meta.label}</span>
                      {it.subject && (
                        <span style={fstyles.subjectChip}>{it.subject}</span>
                      )}
                      {due && <span style={fstyles.dueChip(due.tone)}>{due.text}</span>}
                    </div>
                    {it.details && (
                      <div style={fstyles.details}>{it.details}</div>
                    )}
                    <div style={fstyles.addedBy}>
                      Added by {mine ? "you" : it.addedBy}
                    </div>
                  </div>
                  <button
                    style={fstyles.remove}
                    title="Remove"
                    onClick={() =>
                      void act({ action: "remove", itemId: it.id })
                    }
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// Local styles for Shared folder (reuse the shared CSS variables so it themes).
const fstyles = {
  kindRow: { display: "flex", flexWrap: "wrap", gap: 8 } as React.CSSProperties,
  kindBtn: (active: boolean): React.CSSProperties => ({
    padding: "6px 12px",
    borderRadius: 999,
    fontSize: 13.5,
    fontWeight: 600,
    cursor: "pointer",
    border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
    color: active ? "#fff" : "var(--assistant-text)",
    background: active ? "var(--accent)" : "var(--assistant-bubble)",
  }),
  metaRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 8,
  } as React.CSSProperties,
  detailsInput: {
    width: "100%",
    marginTop: 8,
    padding: "10px 12px",
    borderRadius: 10,
    border: "1px solid var(--border)",
    background: "var(--assistant-bubble)",
    color: "var(--assistant-text)",
    fontSize: 14,
    fontFamily: "inherit",
    resize: "vertical",
    boxSizing: "border-box",
  } as React.CSSProperties,
  list: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
  } as React.CSSProperties,
  item: (done: boolean): React.CSSProperties => ({
    display: "flex",
    alignItems: "flex-start",
    gap: 10,
    padding: "10px 12px",
    borderRadius: 12,
    border: "1px solid var(--border)",
    background: "var(--assistant-bubble)",
    opacity: done ? 0.6 : 1,
  }),
  check: (done: boolean): React.CSSProperties => ({
    flexShrink: 0,
    width: 22,
    height: 22,
    marginTop: 1,
    borderRadius: 6,
    border: `1.5px solid ${done ? "#37b26b" : "var(--border)"}`,
    background: done ? "#37b26b" : "transparent",
    color: "#fff",
    fontSize: 13,
    fontWeight: 800,
    lineHeight: "20px",
    cursor: "pointer",
  }),
  itemTitle: (done: boolean): React.CSSProperties => ({
    display: "flex",
    gap: 7,
    fontSize: 15,
    fontWeight: 600,
    color: "var(--assistant-text)",
    textDecoration: done ? "line-through" : "none",
    wordBreak: "break-word",
  }),
  chipRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: 6,
    marginTop: 5,
  } as React.CSSProperties,
  kindChip: {
    fontSize: 11.5,
    fontWeight: 700,
    padding: "2px 8px",
    borderRadius: 999,
    color: "var(--muted)",
    background: "var(--bg)",
    border: "1px solid var(--border)",
  } as React.CSSProperties,
  subjectChip: {
    fontSize: 11.5,
    fontWeight: 600,
    padding: "2px 8px",
    borderRadius: 999,
    color: "var(--accent)",
    background: "var(--bg)",
    border: "1px solid var(--border)",
  } as React.CSSProperties,
  dueChip: (tone: "over" | "soon" | "later"): React.CSSProperties => ({
    fontSize: 11.5,
    fontWeight: 700,
    padding: "2px 8px",
    borderRadius: 999,
    color: "#fff",
    background:
      tone === "over" ? "#d4483b" : tone === "soon" ? "#e08a2b" : "#5a7fb0",
  }),
  details: {
    fontSize: 13.5,
    color: "var(--muted)",
    marginTop: 6,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  } as React.CSSProperties,
  addedBy: {
    fontSize: 11.5,
    color: "var(--muted)",
    marginTop: 6,
  } as React.CSSProperties,
  remove: {
    flexShrink: 0,
    background: "transparent",
    border: "none",
    color: "var(--muted)",
    fontSize: 20,
    lineHeight: 1,
    cursor: "pointer",
    padding: "0 2px",
  } as React.CSSProperties,
};

function ElioraApp() {
  const { data: session } = useSession();
  // Namespace all saved data by the signed-in user so each account gets its own
  // profile, plan, chats, etc. These shadow the module-level key constants — all
  // localStorage access inside this component uses the per-user keys.
  const ns = (session?.user?.email || "guest").toLowerCase();
  const STORAGE_KEY = `eliora-chat::${ns}`; // legacy single conversation
  const CHATS_KEY = `eliora-chats::${ns}`;
  const ACTIVE_KEY = `eliora-active-chat::${ns}`;
  const PROFILE_KEY = `eliora-profile::${ns}`;
  const PLAN_KEY = `eliora-plan::${ns}`;
  const EVENTS_KEY = `eliora-events::${ns}`;
  const MISSED_KEY = `eliora-missed::${ns}`;
  const MISTAKES_KEY = `eliora-mistakes::${ns}`;
  const SUBJECTS_KEY = `eliora-subjects::${ns}`;
  const ASSIGNMENTS_KEY = `eliora-assignments::${ns}`;
  const GOALS_KEY = `eliora-goals::${ns}`;
  const FOUR_YEAR_KEY = `eliora-four-year-plan::${ns}`;
  const REFLECTIONS_KEY = `eliora-reflections::${ns}`;
  const REFLECTION_SUMMARY_KEY = `eliora-reflection-summary::${ns}`;
  const MONTHLY_REPORTS_KEY = `eliora-monthly-reports::${ns}`; // AI monthly recaps, keyed YYYY-MM
  const WEEKLY_REPORTS_KEY = `eliora-weekly-reports::${ns}`; // AI weekly recaps, keyed by Monday's YYYY-MM-DD
  const TIME_MGMT_KEY = `eliora-timemgmt::${ns}`;
  const PROGRESS_KEY = `eliora-progress::${ns}`;
  const STUDY_KEY = `eliora-study-minutes::${ns}`; // minutes studied per day
  const ROOM_KEY = `eliora-room::${ns}`;
  const CUSTOM_REWARDS_KEY = `eliora-custom-rewards::${ns}`; // learner's own rewards
  const SPENT_KEY = `eliora-spent-xp::${ns}`; // XP spent redeeming custom rewards
  const A11Y_KEY = `eliora-a11y::${ns}`;
  const CHAT_FOLDERS_KEY = `eliora-chat-folders::${ns}`;
  const DAILY_KEY = `eliora-daily::${ns}`; // today's auto-generated tasks
  const BADGES_KEY = `eliora-badges::${ns}`; // badge ids already rewarded
  const SCHEDULE_KEY = `eliora-schedule::${ns}`; // today's 9am–9pm schedule
  const HOMETIME_KEY = `eliora-hometime::${ns}`; // hour the learner gets home
  const MUSIC_KEY = `eliora-music::${ns}`; // connected focus-music playlists
  const TUTOR_KEY = `eliora-tutor::${ns}`; // the AI tutor persona they picked
  const MATERIAL_KEY = `eliora-material::${ns}`; // textbook digests to teach from
  const [chats, setChats] = useState<Chat[]>([]);
  const [folders, setFolders] = useState<ChatFolder[]>([]);
  const [folderMenuFor, setFolderMenuFor] = useState<string | null>(null);
  const [collapsedFolders, setCollapsedFolders] = useState<
    Record<string, boolean>
  >({});
  const [activeChatId, setActiveChatId] = useState<string>("");
  const activeChat = chats.find((c) => c.id === activeChatId);
  const messages = activeChat?.messages ?? [];
  // Writes go to the active chat — keeps the rest of the code unchanged.
  const setMessages = (
    updater: Message[] | ((prev: Message[]) => Message[]),
  ) => {
    setChats((prev) =>
      prev.map((c) => {
        if (c.id !== activeChatId) return c;
        const next =
          typeof updater === "function"
            ? (updater as (p: Message[]) => Message[])(c.messages)
            : updater;
        return {
          ...c,
          messages: next,
          title: c.named ? c.title : chatTitle(next),
        };
      }),
    );
  };
  const [editingChatId, setEditingChatId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  function renameChat(id: string, raw: string) {
    const title = raw.trim();
    setChats((prev) =>
      prev.map((c) =>
        c.id === id
          ? { ...c, title: title || c.title, named: title ? true : c.named }
          : c,
      ),
    );
    setEditingChatId(null);
  }
  const [profile, setProfile] = useState<LearnerProfile | null>(null);
  const [plan, setPlan] = useState<Milestone[]>([]);
  const [events, setEvents] = useState<StudyEvent[]>([]);
  const [missed, setMissed] = useState<string[]>([]);
  const [mistakes, setMistakes] = useState<Mistake[]>([]);
  const [subjects, setSubjects] = useState<string[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [goals, setGoals] = useState<SmartGoal[]>([]);
  const [breakingGoalId, setBreakingGoalId] = useState<string | null>(null);
  const [breakingEventId, setBreakingEventId] = useState<string | null>(null);
  // Time management + "review your work?" on completion.
  const [timeMgmt, setTimeMgmt] = useState(false);
  const [reviewFor, setReviewFor] = useState<{ title: string } | null>(null);
  const [feedbackSeed, setFeedbackSeed] = useState("");
  // Duolingo-style progress: XP earned per day (drives streak + total XP).
  const [progress, setProgress] = useState<Record<string, number>>({});
  // Real time on task: minutes studied per day (YYYY-MM-DD → minutes), logged
  // when a focus timer runs down. Drives the "hours studied each week" chart.
  const [studyLog, setStudyLog] = useState<Record<string, number>>({});
  const logStudyMinutes = (mins: number) => {
    if (!(mins > 0)) return;
    const t = localISO();
    setStudyLog((s) => ({ ...s, [t]: (s[t] || 0) + mins }));
  };
  const [xpToast, setXpToast] = useState<string | null>(null);
  const [equippedRoom, setEquippedRoom] = useState("meadow"); // reward background
  const [tutorId, setTutorId] = useState(ELIORA_DEFAULT_TUTOR); // AI tutor persona
  // The learner's own textbook/handout digests, and the state of a pending read.
  const [materials, setMaterials] = useState<StudyMaterial[]>([]);
  const [materialBusy, setMaterialBusy] = useState<string | null>(null);
  const [materialError, setMaterialError] = useState("");
  // Learner-created rewards + how much XP they've spent redeeming them.
  const [customRewards, setCustomRewards] = useState<CustomReward[]>([]);
  const [spentXp, setSpentXp] = useState(0);
  // Today's tasks: a fresh short list regenerated once per day (keyed on date).
  const [dailyTasks, setDailyTasks] = useState<DailyTasksState | null>(null);
  const [dailyLoading, setDailyLoading] = useState(false);
  // Today's 9am–9pm time-block schedule (resets each new day, like daily tasks).
  const [schedule, setSchedule] = useState<DaySchedule | null>(null);
  const [homeHour, setHomeHour] = useState(16); // when they get home (24h)
  const [generatingSchedule, setGeneratingSchedule] = useState(false);
  // Latest schedule-survey answers: today's study-minute cap and what to focus on.
  const [scheduleBudgetMin, setScheduleBudgetMin] = useState<
    number | undefined
  >(undefined);
  const [scheduleFocusNote, setScheduleFocusNote] = useState("");
  // Badge ids the learner has already been rewarded for (so we grant the bonus
  // XP only once, and never retroactively for badges earned before this shipped).
  const [claimedBadges, setClaimedBadges] = useState<string[]>([]);
  const [badgeCelebration, setBadgeCelebration] = useState<BadgeDef | null>(null);
  const totalXp = Object.values(progress).reduce((a, b) => a + b, 0);
  // XP still available to spend on custom rewards (earned minus already spent).
  const availableXp = Math.max(0, totalXp - spentXp);
  // Award XP; +20% consistency bonus if the learner was also active yesterday.
  const award = (baseXp: number, label = "") => {
    const y = new Date();
    y.setDate(y.getDate() - 1);
    const onStreak = (progress[localISO(y)] || 0) > 0;
    const xp = Math.round(onStreak ? baseXp * 1.2 : baseXp);
    const t = localISO();
    setProgress((p) => ({ ...p, [t]: (p[t] || 0) + xp }));
    setXpToast(
      `+${xp} XP${onStreak ? " · 🔥 streak bonus" : ""}${label ? ` · ${label}` : ""}`,
    );
  };
  // Auto-hide the XP toast.
  useEffect(() => {
    if (!xpToast) return;
    const id = setTimeout(() => setXpToast(null), 2600);
    return () => clearTimeout(id);
  }, [xpToast]);
  // Learner-created rewards: add, redeem (spend available XP), and remove.
  const addCustomReward = (emoji: string, title: string, cost: number) => {
    setCustomRewards((prev) => [
      ...prev,
      {
        id: `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        emoji,
        title,
        cost,
        redeemed: 0,
      },
    ]);
  };
  const redeemCustomReward = (id: string, note?: string) => {
    const r = customRewards.find((x) => x.id === id);
    if (!r || totalXp - spentXp < r.cost) return; // can't afford it
    setSpentXp((s) => s + r.cost);
    const entry = note?.trim();
    setCustomRewards((prev) =>
      prev.map((x) =>
        x.id === id
          ? {
              ...x,
              redeemed: x.redeemed + 1,
              log: entry ? [...(x.log ?? []), entry] : x.log,
            }
          : x,
      ),
    );
    setXpToast(`🎉 Redeemed ${r.emoji} ${r.title} · −${r.cost} XP`);
  };
  const removeCustomReward = (id: string) =>
    setCustomRewards((prev) => prev.filter((x) => x.id !== id));
  const [fourYearPlan, setFourYearPlan] = useState<FourYearPlan | null>(null);
  const [generatingFyp, setGeneratingFyp] = useState(false);
  // End-of-semester reflections, keyed by year label.
  const [reflections, setReflections] = useState<
    Record<string, { message: string; focus: string[] }>
  >({});
  // Big-picture summary synthesized across all semester reflections.
  const [reflectionSummary, setReflectionSummary] = useState<{
    message: string;
    focus: string[];
  } | null>(null);
  // AI monthly progress recaps, keyed by "YYYY-MM". Generated on demand and kept
  // so a month's recap doesn't regenerate every time it's viewed.
  const [monthlyReports, setMonthlyReports] = useState<
    Record<string, { message: string; focus: string[]; generatedAt: string }>
  >({});
  const [monthlyReportBusy, setMonthlyReportBusy] = useState<string | null>(null);
  // AI weekly "what you learned" recaps, keyed by the Monday's "YYYY-MM-DD".
  // Generated on demand and kept so a week's recap doesn't regenerate on view.
  const [weeklyReports, setWeeklyReports] = useState<
    Record<string, { message: string; focus: string[]; generatedAt: string }>
  >({});
  const [weeklyReportBusy, setWeeklyReportBusy] = useState<string | null>(null);
  const [summarizingReflections, setSummarizingReflections] = useState(false);
  const [creatingReflGoals, setCreatingReflGoals] = useState(false);
  const [editing, setEditing] = useState(false);
  const [tab, setTab] = useState<
    | "home"
    | "chat"
    | "notebook"
    | "practice"
    | "calendar"
    | "plan"
    | "progress"
    | "study"
    | "together"
    | "folder"
    | "school"
  >("home");
  // Smart Notes holds two tools: the notebook itself and the summarizer, which
  // used to be its own sidebar tab. Sub-tab picks which one is showing.
  const [notesView, setNotesView] = useState<"notes" | "summarize">("notes");
  // Sub-sections within the Plan tab, so it's not one overwhelming scroll.
  // "overview" is the main landing page that summarizes everything.
  const [planSection, setPlanSection] = useState<
    | "overview"
    | "monthly"
    | "week"
    | "goals"
    | "tasks"
    | "steps"
    | "fyp"
  >("overview");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [viewportW, setViewportW] = useState(1024);
  useEffect(() => {
    const onResize = () => setViewportW(window.innerWidth);
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const [a11y, setA11y] = useState<A11y>(DEFAULT_A11Y);
  const [showA11y, setShowA11y] = useState(false);
  const [showNotifs, setShowNotifs] = useState(false);
  // Top-right notification bell has its own open state so it doesn't fight the
  // sidebar-footer bell (both drive the same reminder list, different anchors).
  const [showTopNotifs, setShowTopNotifs] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  // What Eliora is doing right now (streamed "status" events while tools run),
  // shown in the pending assistant bubble instead of a bare "…".
  const [chatStatus, setChatStatus] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  // A deck/note a friend shared via ?share=… — offered for import once loaded.
  const [incomingShare, setIncomingShare] = useState<SharePayload | null>(null);
  const [autoBuild, setAutoBuild] = useState(false);
  // A kickoff message queued for a freshly-created topic chat, sent once that
  // chat is the active one (see the effect below) so it lands in the new chat.
  const [pendingKickoff, setPendingKickoff] = useState<string | null>(null);
  const [showClassSurvey, setShowClassSurvey] = useState(false);
  const [showStudySurvey, setShowStudySurvey] = useState(false);
  const [generatingStudyPlan, setGeneratingStudyPlan] = useState(false);
  const [studyPlanSubject, setStudyPlanSubject] = useState("");
  const [listening, setListening] = useState(false);
  const [speechSupported, setSpeechSupported] = useState(false);
  // Hands-free voice conversation overlay (talk to Eliora, she talks back).
  const [voiceMode, setVoiceMode] = useState(false);
  // Photos/files/videos staged in the composer, sent with the next message.
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attaching, setAttaching] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // When set, the teach-back video recorder is open (value = concept to teach).
  const [recorderOpen, setRecorderOpen] = useState<string | null>(null);
  // How hard the next teach-back should push — shared by the composer chips and
  // the recorder so every teach-back entry point respects the current pick.
  const [teachLevel, setTeachLevel] = useState<TeachLevel>("middle");
  // Which kind of learner Eliora role-plays in "Teach a student" — the topic you
  // teach stays the same, but the student you have to reach changes.
  const [studentStyle, setStudentStyle] = useState<StudentStyle>("visual");
  const [remindersOn, setRemindersOn] = useState(false);
  const [notifSupported, setNotifSupported] = useState(false);
  const [dismissed, setDismissed] = useState<string[]>([]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recognitionRef = useRef<any>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Lets the Stop button cancel an in-flight chat reply.
  const chatAbortRef = useRef<AbortController | null>(null);

  // Detect Web Speech API support (client-only, avoids hydration mismatch).
  useEffect(() => {
    setSpeechSupported(
      typeof window !== "undefined" &&
        ("SpeechRecognition" in window || "webkitSpeechRecognition" in window),
    );
  }, []);

  // Voice-to-text: dictate a message into the composer.
  function toggleDictation() {
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    const SR = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!SR) return;
    const rec = new SR();
    rec.lang = "en-US";
    rec.interimResults = true;
    rec.continuous = false;
    const base = input.trim() ? input.trim() + " " : "";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rec.onresult = (e: any) => {
      let transcript = "";
      for (let i = 0; i < e.results.length; i++) {
        transcript += e.results[i][0].transcript;
      }
      setInput(base + transcript);
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recognitionRef.current = rec;
    setListening(true);
    rec.start();
  }

  // ----- Reminders & notifications -----
  type Reminder = {
    id: string;
    icon: string;
    text: string;
    kind: "plan" | "calendar" | "chat" | "home" | "progress";
    chatMsg?: string;
  };
  const reminders: Reminder[] = [];
  for (const a of assignments) {
    if (a.done || !a.due) continue;
    const n = daysUntil(a.due);
    if (n <= 0)
      reminders.push({
        id: `asg-${a.id}`,
        icon: "⏰",
        text: `${a.title}${a.subject ? ` · ${a.subject}` : ""} — ${
          n < 0 ? "overdue" : "due today"
        }`,
        kind: "plan",
      });
    // A day-ahead heads-up. Separate id from `asg-` so checking it off just
    // dismisses the warning instead of marking the assignment done.
    else if (n === 1)
      reminders.push({
        id: `asgsoon-${a.id}`,
        icon: "⏰",
        text: `${a.title}${a.subject ? ` · ${a.subject}` : ""} — due tomorrow`,
        kind: "plan",
      });
  }
  for (const e of events) {
    const n = daysUntil(e.date);
    if (n >= 0 && n <= 2)
      reminders.push({
        id: `evt-${e.id}`,
        icon: "📅",
        text: `${e.title} — ${
          n === 0 ? "today" : n === 1 ? "tomorrow" : `in ${n} days`
        }`,
        kind: "calendar",
      });
    else if (n < 0 && n >= -3)
      reminders.push({
        id: `fu-${e.id}`,
        icon: "🔁",
        text: `How did ${e.title} go?`,
        kind: "chat",
        chatMsg: `My ${e.kind ?? "exam"} "${e.title}" just happened. Help me reflect on how it went and plan what to do next.`,
      });
    else if (n <= -4 && n >= -6)
      reminders.push({
        id: `fix-${e.id}`,
        icon: "🔁",
        text: `Correct mistakes from ${e.title}`,
        kind: "chat",
        chatMsg: `It's about a week since my ${e.kind ?? "test"} "${e.title}". Let's go over the questions I got wrong and fix those mistakes — re-teach me and quiz me on just those.`,
      });
    // A week after every exam and test, follow up on the results — by now the
    // grade is usually back, so nudge a review of how it went and what to focus
    // on next. Only for exams/tests (not plain assignments or misc events).
    else if (
      n <= -7 &&
      n >= -11 &&
      (!e.kind || e.kind === "exam" || e.kind === "final" || e.kind === "quiz")
    )
      reminders.push({
        id: `res-${e.id}`,
        icon: "📊",
        text: `Results back for ${e.title}? Let's review them`,
        kind: "chat",
        chatMsg: `It's been about a week since my ${e.kind ?? "exam"} "${e.title}", so the results should be back. Help me review how I did — talk through my grade, what went well, and the topics to focus on next.`,
      });
  }
  // Goal target dates: the day a goal is meant to finish by (and shortly after),
  // nudge a check-in — did they reach it?
  for (const g of goals) {
    if (g.done || !g.timeBound) continue;
    const n = daysUntil(g.timeBound);
    if (n <= 0 && n >= -14)
      reminders.push({
        id: `goal-${g.id}`,
        icon: "🌟",
        text: `Goal ${n === 0 ? "due today" : "date passed"}: ${g.specific} — did you reach it?`,
        kind: "chat",
        chatMsg: `Today is around the target date for my goal "${g.statement?.trim() || g.specific}". Check in with me: ask if I reached it, celebrate if I did, or help me adjust the goal or pick a new date if I didn't.`,
      });
  }
  // Today's daily tasks: nudge until they're all checked off. The id is
  // date-scoped so a dismissal only silences it for the day.
  if (dailyTasks?.date === localISO()) {
    const left = dailyTasks.tasks.filter((t) => !t.done).length;
    if (left > 0)
      reminders.push({
        id: `daily-${dailyTasks.date}`,
        icon: "📋",
        text: `${left} daily task${left === 1 ? "" : "s"} left today`,
        kind: "home", // the 🌞 Today's tasks card lives on the Home tab
      });
  }
  // Streak at risk: they earned XP yesterday but nothing yet today.
  {
    const yd = new Date();
    yd.setDate(yd.getDate() - 1);
    if (
      (progress[localISO(yd)] || 0) > 0 &&
      (progress[localISO()] || 0) === 0
    ) {
      const streak = computeStreak(progress);
      reminders.push({
        id: `streak-${localISO()}`,
        icon: "🔥",
        text: `Keep your ${streak}-day streak alive — earn some XP today`,
        kind: "progress",
      });
    }
  }
  const shownReminders = reminders.filter((r) => !dismissed.includes(r.id));
  const reminderSig = shownReminders.map((r) => r.id).join("|");

  // Check off a reminder: assignments toggle done; others get dismissed so they
  // don't come back.
  function checkReminder(r: Reminder) {
    if (r.id.startsWith("asg-")) toggleAssignment(r.id.slice(4));
    else setDismissed((prev) => (prev.includes(r.id) ? prev : [...prev, r.id]));
  }

  // Detect notification support + restore the per-user reminders preference.
  useEffect(() => {
    setNotifSupported(typeof window !== "undefined" && "Notification" in window);
    try {
      if (localStorage.getItem(`eliora-reminders::${ns}`) === "1")
        setRemindersOn(true);
      const d = localStorage.getItem(`eliora-rem-dismissed::${ns}`);
      if (d) setDismissed(JSON.parse(d));
    } catch {
      /* ignore */
    }
  }, [ns]);

  // Persist dismissed reminders.
  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(
        `eliora-rem-dismissed::${ns}`,
        JSON.stringify(dismissed),
      );
    } catch {
      /* ignore */
    }
  }, [dismissed, loaded, ns]);

  // Fire OS notifications for due-soon items (once per item per day).
  useEffect(() => {
    if (!loaded || !remindersOn || !notifSupported) return;
    if (typeof Notification === "undefined" || Notification.permission !== "granted")
      return;
    const todayKey = new Date().toDateString();
    try {
      const key = `eliora-notified::${ns}`;
      const sent = new Set<string>(JSON.parse(localStorage.getItem(key) || "[]"));
      let changed = false;
      for (const r of shownReminders) {
        const tag = `${r.id}@${todayKey}`;
        if (sent.has(tag)) continue;
        new Notification("Eliora", { body: `${r.icon} ${r.text}` });
        sent.add(tag);
        changed = true;
      }
      if (changed) localStorage.setItem(key, JSON.stringify([...sent]));
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remindersOn, notifSupported, loaded, reminderSig, ns]);

  function enableNotifications() {
    if (!notifSupported || typeof Notification === "undefined") return;
    Notification.requestPermission().then((perm) => {
      if (perm === "granted") {
        setRemindersOn(true);
        try {
          localStorage.setItem(`eliora-reminders::${ns}`, "1");
        } catch {
          /* ignore */
        }
      }
    });
  }

  function handleReminder(r: Reminder) {
    if (r.kind === "calendar") setTab("calendar");
    else if (r.kind === "home") setTab("home");
    else if (r.kind === "progress") setTab("progress");
    else if (r.kind === "chat") {
      setTab("chat");
      if (r.chatMsg) send(r.chatMsg);
    } else {
      setTab("plan");
    }
  }

  // Restore saved profile + plan + conversation.
  useEffect(() => {
    try {
      const rawP = localStorage.getItem(PROFILE_KEY);
      const savedProfile = rawP ? (JSON.parse(rawP) as LearnerProfile) : null;
      if (savedProfile) setProfile(savedProfile);

      const rawPlan = localStorage.getItem(PLAN_KEY);
      const savedPlan = rawPlan ? (JSON.parse(rawPlan) as Milestone[]) : null;
      if (Array.isArray(savedPlan)) setPlan(savedPlan);

      const rawEvents = localStorage.getItem(EVENTS_KEY);
      const savedEvents = rawEvents ? (JSON.parse(rawEvents) as StudyEvent[]) : null;
      if (Array.isArray(savedEvents)) setEvents(savedEvents);

      const rawMissed = localStorage.getItem(MISSED_KEY);
      const savedMissed = rawMissed ? (JSON.parse(rawMissed) as string[]) : null;
      if (Array.isArray(savedMissed)) setMissed(savedMissed);

      const rawMistakes = localStorage.getItem(MISTAKES_KEY);
      const savedMistakes = rawMistakes
        ? (JSON.parse(rawMistakes) as Mistake[])
        : null;
      if (Array.isArray(savedMistakes)) setMistakes(savedMistakes);

      const rawSubjects = localStorage.getItem(SUBJECTS_KEY);
      const savedSubjects = rawSubjects
        ? (JSON.parse(rawSubjects) as string[])
        : null;
      if (Array.isArray(savedSubjects)) setSubjects(savedSubjects);

      const rawAssign = localStorage.getItem(ASSIGNMENTS_KEY);
      const savedAssign = rawAssign
        ? (JSON.parse(rawAssign) as Assignment[])
        : null;
      if (Array.isArray(savedAssign)) setAssignments(savedAssign);

      const rawGoals = localStorage.getItem(GOALS_KEY);
      const savedGoals = rawGoals ? (JSON.parse(rawGoals) as SmartGoal[]) : null;
      if (Array.isArray(savedGoals)) setGoals(savedGoals);

      const rawFyp = localStorage.getItem(FOUR_YEAR_KEY);
      const savedFyp = rawFyp ? JSON.parse(rawFyp) : null;
      if (savedFyp && Array.isArray(savedFyp.years)) {
        setFourYearPlan(normalizeFourYearPlan(savedFyp));
      }

      const rawRefl = localStorage.getItem(REFLECTIONS_KEY);
      const savedRefl = rawRefl ? JSON.parse(rawRefl) : null;
      if (savedRefl && typeof savedRefl === "object") setReflections(savedRefl);

      const rawReflSum = localStorage.getItem(REFLECTION_SUMMARY_KEY);
      const savedReflSum = rawReflSum ? JSON.parse(rawReflSum) : null;
      if (savedReflSum && savedReflSum.message)
        setReflectionSummary(savedReflSum);

      const rawMonthly = localStorage.getItem(MONTHLY_REPORTS_KEY);
      const savedMonthly = rawMonthly ? JSON.parse(rawMonthly) : null;
      if (savedMonthly && typeof savedMonthly === "object")
        setMonthlyReports(savedMonthly);

      const rawWeekly = localStorage.getItem(WEEKLY_REPORTS_KEY);
      const savedWeekly = rawWeekly ? JSON.parse(rawWeekly) : null;
      if (savedWeekly && typeof savedWeekly === "object")
        setWeeklyReports(savedWeekly);

      const rawDaily = localStorage.getItem(DAILY_KEY);
      const savedDaily = rawDaily ? JSON.parse(rawDaily) : null;
      if (
        savedDaily &&
        typeof savedDaily.date === "string" &&
        Array.isArray(savedDaily.tasks)
      )
        setDailyTasks(savedDaily as DailyTasksState);

      const rawSched = localStorage.getItem(SCHEDULE_KEY);
      const savedSched = rawSched ? JSON.parse(rawSched) : null;
      if (
        savedSched &&
        typeof savedSched.date === "string" &&
        savedSched.blocks &&
        typeof savedSched.blocks === "object"
      )
        setSchedule(savedSched as DaySchedule);

      const rawHome = localStorage.getItem(HOMETIME_KEY);
      const savedHome = rawHome ? parseInt(rawHome, 10) : NaN;
      if (Number.isInteger(savedHome) && savedHome >= 9 && savedHome <= 20)
        setHomeHour(savedHome);

      if (localStorage.getItem(TIME_MGMT_KEY) === "1") setTimeMgmt(true);

      const rawProg = localStorage.getItem(PROGRESS_KEY);
      const savedProg = rawProg ? JSON.parse(rawProg) : null;
      if (savedProg && typeof savedProg === "object") setProgress(savedProg);

      const rawStudy = localStorage.getItem(STUDY_KEY);
      const savedStudy = rawStudy ? JSON.parse(rawStudy) : null;
      if (savedStudy && typeof savedStudy === "object") setStudyLog(savedStudy);

      // Claimed badges: if we've stored them before, restore. Otherwise this is
      // the first run since badge rewards shipped — backfill every ALREADY-earned
      // badge as claimed (no retroactive payout for progress made before now).
      const rawBadges = localStorage.getItem(BADGES_KEY);
      if (rawBadges) {
        const parsed = JSON.parse(rawBadges);
        if (Array.isArray(parsed)) setClaimedBadges(parsed as string[]);
      } else {
        const already =
          savedProg && typeof savedProg === "object"
            ? earnedBadgeIds(savedProg, savedGoals ?? [])
            : [];
        setClaimedBadges(already);
        localStorage.setItem(BADGES_KEY, JSON.stringify(already));
      }

      const savedRoom = localStorage.getItem(ROOM_KEY);
      if (savedRoom) setEquippedRoom(savedRoom);

      const rawMaterial = localStorage.getItem(MATERIAL_KEY);
      if (rawMaterial) {
        const parsed = JSON.parse(rawMaterial);
        if (Array.isArray(parsed)) setMaterials(parsed as StudyMaterial[]);
      }

      const savedTutor = localStorage.getItem(TUTOR_KEY);
      // Ignore a tutor id that no longer exists so a renamed persona falls back
      // to the default instead of silently sending an unknown id.
      if (savedTutor && ELIORA_TUTORS.some((t) => t.id === savedTutor))
        setTutorId(savedTutor);

      const rawRewards = localStorage.getItem(CUSTOM_REWARDS_KEY);
      if (rawRewards) {
        const parsed = JSON.parse(rawRewards);
        if (Array.isArray(parsed)) setCustomRewards(parsed as CustomReward[]);
      }
      const rawSpent = localStorage.getItem(SPENT_KEY);
      const savedSpent = rawSpent ? parseInt(rawSpent, 10) : 0;
      if (Number.isFinite(savedSpent) && savedSpent > 0) setSpentXp(savedSpent);

      const rawA11y = localStorage.getItem(A11Y_KEY);
      if (rawA11y) {
        const parsed = JSON.parse(rawA11y);
        // Migrate the old on/off "large" toggle to the new font scale.
        if (parsed.large && parsed.fontScale == null) parsed.fontScale = 1.3;
        setA11y({ ...DEFAULT_A11Y, ...parsed });
      }

      const rawChats = localStorage.getItem(CHATS_KEY);
      let loadedChats = rawChats ? (JSON.parse(rawChats) as Chat[]) : null;
      if (!Array.isArray(loadedChats) || !loadedChats.length) {
        // Migrate the old single conversation (or start fresh).
        const old = localStorage.getItem(STORAGE_KEY);
        const msgs: Message[] = old
          ? (JSON.parse(old) as Message[])
          : savedProfile
            ? [greetingFor(savedProfile)]
            : [];
        loadedChats = [{ id: newChatId(), title: chatTitle(msgs), messages: msgs }];
      }
      setChats(loadedChats);
      const savedActive = localStorage.getItem(ACTIVE_KEY);
      setActiveChatId(
        loadedChats.find((c) => c.id === savedActive)?.id ?? loadedChats[0].id,
      );

      const rawFolders = localStorage.getItem(CHAT_FOLDERS_KEY);
      const savedFolders = rawFolders
        ? (JSON.parse(rawFolders) as ChatFolder[])
        : null;
      if (Array.isArray(savedFolders)) setFolders(savedFolders);
    } catch {
      /* ignore corrupt storage */
    }
    setLoaded(true);
  }, []);

  // If the app was opened from a share link (?share=…), pick up the shared deck
  // or note and offer to import it. Clear the param so a refresh doesn't re-ask.
  useEffect(() => {
    if (!loaded) return;
    const shared = readShareFromUrl();
    if (shared) {
      setIncomingShare(shared);
      window.history.replaceState({}, "", window.location.pathname);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  // Bring an imported deck/note into the current chat as a message, so the
  // friend can study it right away (and it's saved with the conversation).
  function importShare(shared: SharePayload) {
    if (shared.kind === "flashcards") {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: shared.title
            ? `A friend shared these flashcards with you: **${shared.title}**`
            : "A friend shared these flashcards with you:",
          flashcards: shared.cards,
        },
      ]);
    } else {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content:
            (shared.title ? `**${shared.title}** — shared by a friend\n\n` : "") +
            shared.text,
        },
      ]);
    }
    setIncomingShare(null);
    setTab("chat");
  }

  // Persist chat folders.
  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(CHAT_FOLDERS_KEY, JSON.stringify(folders));
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folders, loaded]);

  // ----- Chat folders -----
  function createFolder(name: string): string | null {
    const n = name.trim();
    if (!n) return null;
    const id = `f${Date.now().toString(36)}`;
    setFolders((prev) => [...prev, { id, name: n }]);
    return id;
  }
  function renameFolder(id: string, name: string) {
    const n = name.trim();
    if (!n) return;
    setFolders((prev) => prev.map((f) => (f.id === id ? { ...f, name: n } : f)));
  }
  function deleteFolder(id: string) {
    setFolders((prev) => prev.filter((f) => f.id !== id));
    setChats((prev) =>
      prev.map((c) => (c.folderId === id ? { ...c, folderId: undefined } : c)),
    );
  }
  function moveChatToFolder(chatId: string, folderId: string | undefined) {
    setChats((prev) =>
      prev.map((c) => (c.id === chatId ? { ...c, folderId } : c)),
    );
    setFolderMenuFor(null);
  }

  // One chat row in the sidebar (used for both folder groups and ungrouped).
  function renderChat(c: Chat) {
    return (
      <div
        key={c.id}
        style={{
          ...styles.sideChat,
          position: "relative",
          ...(c.id === activeChatId && tab === "chat"
            ? styles.sideChatActive
            : {}),
        }}
      >
        {editingChatId === c.id ? (
          <input
            style={styles.sideChatEdit}
            value={editTitle}
            autoFocus
            placeholder="Name this chat…"
            onChange={(e) => setEditTitle(e.target.value)}
            onBlur={() => renameChat(c.id, editTitle)}
            onKeyDown={(e) => {
              if (e.key === "Enter") renameChat(c.id, editTitle);
              if (e.key === "Escape") setEditingChatId(null);
            }}
          />
        ) : (
          <button
            style={styles.sideChatBtn}
            onClick={() => {
              setActiveChatId(c.id);
              setTab("chat");
              setSidebarOpen(false);
            }}
            onDoubleClick={() => {
              setEditingChatId(c.id);
              setEditTitle(c.title);
            }}
            title="Double-click to rename"
          >
            💬 {c.title}
          </button>
        )}
        {editingChatId !== c.id && (
          <>
            <button
              style={styles.sideChatDel}
              aria-label="Move to folder"
              title="Move to folder"
              onClick={() =>
                setFolderMenuFor((cur) => (cur === c.id ? null : c.id))
              }
            >
              📁
            </button>
            <button
              style={styles.sideChatDel}
              aria-label="Rename chat"
              title="Rename chat"
              onClick={() => {
                setEditingChatId(c.id);
                setEditTitle(c.title);
              }}
            >
              ✎
            </button>
            {(chats.length > 1 ||
              c.messages.some((m) => m.role === "user")) && (
              <button
                style={styles.sideChatDel}
                aria-label="Delete chat"
                title="Delete chat"
                onClick={() => closeChat(c.id)}
              >
                ×
              </button>
            )}
          </>
        )}
        {folderMenuFor === c.id && (
          <div style={styles.folderMenu}>
            <button
              style={styles.folderMenuItem}
              onClick={() => moveChatToFolder(c.id, undefined)}
            >
              No folder
            </button>
            {folders.map((f) => (
              <button
                key={f.id}
                style={styles.folderMenuItem}
                onClick={() => moveChatToFolder(c.id, f.id)}
              >
                📁 {f.name}
              </button>
            ))}
            <button
              style={styles.folderMenuItem}
              onClick={() => {
                const name = window.prompt("New folder name");
                if (name) {
                  const id = createFolder(name);
                  if (id) moveChatToFolder(c.id, id);
                }
              }}
            >
              ＋ New folder
            </button>
          </div>
        )}
      </div>
    );
  }

  // Persist all chats + which one is active. Debounced so token-by-token
  // streaming doesn't thrash storage, but it now saves DURING a reply (not only
  // after it finishes) so nothing is lost if the page reloads mid-stream.
  const saveRef = useRef({ chats, activeChatId });
  saveRef.current = { chats, activeChatId };
  function flushChats() {
    const { chats: cs, activeChatId: act } = saveRef.current;
    if (!cs.length) return;
    try {
      localStorage.setItem(CHATS_KEY, JSON.stringify(cs));
      localStorage.setItem(ACTIVE_KEY, act);
    } catch {
      /* storage full or unavailable */
    }
  }
  useEffect(() => {
    if (!loaded || !chats.length) return;
    const id = setTimeout(flushChats, 400);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chats, activeChatId, loaded]);

  // Flush immediately when the tab is hidden or closed, so an in-progress chat
  // (e.g. mid-reply) is never lost.
  useEffect(() => {
    if (!loaded) return;
    const onHide = () => flushChats();
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onHide);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  // Persist the plan.
  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(PLAN_KEY, JSON.stringify(plan));
    } catch {
      /* ignore */
    }
  }, [plan, loaded]);

  // Persist the calendar.
  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(EVENTS_KEY, JSON.stringify(events));
    } catch {
      /* ignore */
    }
  }, [events, loaded]);

  function addEvent(e: StudyEvent) {
    setEvents((prev) =>
      prev.some((x) => x.id === e.id) ? prev : [...prev, e],
    );
  }
  function removeEvent(id: string) {
    setEvents((prev) => prev.filter((x) => x.id !== id));
  }
  // Break a calendar date into a prep checklist working BACKWARD from its date.
  // Reuses /api/goal-tasks (which paces steps to a target date) by mapping the
  // event to a goal-like object, then stores the steps on the event.
  async function breakDownEvent(e: StudyEvent) {
    if (breakingEventId) return;
    setBreakingEventId(e.id);
    try {
      const goalLike = {
        specific: e.title,
        statement: `Be fully ready for "${e.title}" (${e.kind ?? "event"}) by its date`,
        timeBound: e.date,
      };
      const res = await fetch("/api/goal-tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal: goalLike, profile: profile ?? undefined }),
      });
      const data = (await res.json()) as { tasks?: string[]; error?: string };
      const titles = (data.tasks ?? []).filter((t) => t.trim());
      if (titles.length) {
        setEvents((prev) =>
          prev.map((x) =>
            x.id === e.id
              ? { ...x, tasks: titles.map((title) => ({ title, done: false })) }
              : x,
          ),
        );
      }
    } catch {
      /* ignore — the button can be tapped again */
    } finally {
      setBreakingEventId(null);
    }
  }
  function toggleEventTask(eventId: string, index: number) {
    const et = events.find((x) => x.id === eventId)?.tasks?.[index];
    if (et && !et.done) award(10); // checking off a prep step earns XP
    setEvents((prev) =>
      prev.map((e) => {
        if (e.id !== eventId) return e;
        const tasks = (e.tasks ?? []).map((t, i) =>
          i === index ? { ...t, done: !t.done } : t,
        );
        // All prep steps done → offer to review the work.
        if (tasks.length && tasks.every((t) => t.done))
          setReviewFor({ title: e.title });
        return { ...e, tasks };
      }),
    );
  }

  // Persist daily assignments.
  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(ASSIGNMENTS_KEY, JSON.stringify(assignments));
    } catch {
      /* ignore */
    }
  }, [assignments, loaded]);

  function addAssignment(a: {
    title: string;
    subject?: string;
    due?: string;
    estMin?: number;
    planDate?: string;
  }) {
    const title = a.title.trim();
    if (!title) return;
    setAssignments((prev) => [
      ...prev,
      {
        id: `a${Date.now().toString(36)}`,
        title,
        subject: a.subject?.trim() || undefined,
        due: a.due || undefined,
        estMin:
          typeof a.estMin === "number" && a.estMin > 0 ? a.estMin : undefined,
        planDate: a.planDate || undefined,
        done: false,
      },
    ]);
  }
  function toggleAssignment(id: string) {
    const a = assignments.find((x) => x.id === id);
    if (a && !a.done) {
      // Hard tasks (essays, test prep, projects…) are worth 100+; others 60.
      const hard =
        /essay|exam|test|prep|project|paper|research|final|midterm|study guide/i.test(
          a.title,
        );
      award(hard ? 100 : 60, hard ? "hard task!" : "task done");
      setReviewFor({ title: a.title });
    }
    setAssignments((prev) =>
      prev.map((x) => (x.id === id ? { ...x, done: !x.done } : x)),
    );
  }
  function setAssignmentTime(
    id: string,
    fields: { estMin?: number; planDate?: string },
  ) {
    setAssignments((prev) =>
      prev.map((a) =>
        a.id === id
          ? {
              ...a,
              estMin:
                fields.estMin != null
                  ? fields.estMin > 0
                    ? fields.estMin
                    : undefined
                  : a.estMin,
              planDate:
                fields.planDate !== undefined ? fields.planDate : a.planDate,
            }
          : a,
      ),
    );
  }
  function setAssignmentConcern(id: string, concern: string) {
    setAssignments((prev) =>
      prev.map((a) =>
        a.id === id ? { ...a, concern: concern.trim() || undefined } : a,
      ),
    );
  }
  function removeAssignment(id: string) {
    setAssignments((prev) => prev.filter((a) => a.id !== id));
  }

  // Persist SMART goals.
  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(GOALS_KEY, JSON.stringify(goals));
    } catch {
      /* ignore */
    }
  }, [goals, loaded]);

  // The learner (or Eliora) adds a SMART goal.
  function addGoal(g: Omit<SmartGoal, "id" | "done">) {
    const specific = g.specific.trim();
    if (!specific) return;
    setGoals((prev) => [
      ...prev,
      {
        ...g,
        specific,
        measurable: g.measurable?.trim() || undefined,
        achievable: g.achievable?.trim() || undefined,
        relevant: g.relevant?.trim() || undefined,
        subject: g.subject?.trim() || undefined,
        horizon: g.horizon || undefined,
        timeBound: g.timeBound || undefined,
        statement: g.statement?.trim() || undefined,
        target:
          typeof g.target === "number" && g.target > 0 ? g.target : undefined,
        current: typeof g.target === "number" && g.target > 0 ? 0 : undefined,
        // Random suffix so rapid multi-adds (e.g. goals from a reflection) don't
        // collide on the same-millisecond Date.now().
        id: `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        done: false,
      },
    ]);
  }
  // Grant the reward "prize" a learner tied to a goal — claimed FOR FREE the
  // moment the goal is achieved (hitting the goal IS the price, no XP spent). It
  // still counts toward the reward's claim tally so it shows up as a treat won.
  const grantGoalReward = (g: SmartGoal) => {
    if (!g.rewardId) return;
    const r = customRewards.find((x) => x.id === g.rewardId);
    if (!r) return;
    setCustomRewards((prev) =>
      prev.map((x) =>
        x.id === r.id ? { ...x, redeemed: x.redeemed + 1 } : x,
      ),
    );
    setXpToast(`🎁 Reward unlocked: ${r.emoji} ${r.title}!`);
  };
  // Nudge numeric progress up or down (clamped to 0..target). Auto-completes
  // the goal when it reaches the target, and reopens it if backed off.
  function stepGoal(id: string, delta: number) {
    const g = goals.find((x) => x.id === id);
    // Decide "just achieved" from the current closure (the setGoals updater runs
    // later during reconciliation, so a flag set inside it isn't visible here).
    let justAchieved = false;
    if (g && typeof g.target === "number") {
      const next = Math.max(0, Math.min(g.target, (g.current ?? 0) + delta));
      justAchieved = next >= g.target && !g.done;
    }
    setGoals((prev) =>
      prev.map((x) => {
        if (x.id !== id || typeof x.target !== "number") return x;
        const current = Math.max(
          0,
          Math.min(x.target, (x.current ?? 0) + delta),
        );
        return { ...x, current, done: current >= x.target };
      }),
    );
    if (justAchieved && g) {
      award(80, "goal achieved!"); // hitting the target is a big win too
      grantGoalReward(g);
    }
  }
  function toggleGoalDone(id: string) {
    const g = goals.find((x) => x.id === id);
    if (g && !g.done) {
      award(80, "goal achieved!"); // achieving a goal is a big win
      grantGoalReward(g); // and hand over the prize they tied to it
    }
    setGoals((prev) =>
      prev.map((x) => (x.id === id ? { ...x, done: !x.done } : x)),
    );
  }
  // Tie a custom reward to a goal (or clear it) — the prize for achieving it.
  function linkGoalReward(goalId: string, rewardId: string | undefined) {
    setGoals((prev) =>
      prev.map((g) => (g.id === goalId ? { ...g, rewardId } : g)),
    );
  }
  function removeGoal(id: string) {
    setGoals((prev) => prev.filter((g) => g.id !== id));
  }
  // Break a goal into a checklist of steps (right here on the Plan tab). Calls
  // the goal-tasks endpoint, which reliably returns an ordered step list, and
  // stores it on the goal so it renders as a checklist under that goal.
  async function breakDownGoal(g: SmartGoal) {
    if (breakingGoalId) return;
    setBreakingGoalId(g.id);
    try {
      const res = await fetch("/api/goal-tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal: g, profile: profile ?? undefined }),
      });
      const data = (await res.json()) as { tasks?: string[]; error?: string };
      const titles = (data.tasks ?? []).filter((t) => t.trim());
      if (titles.length) {
        setGoals((prev) =>
          prev.map((x) =>
            x.id === g.id
              ? { ...x, tasks: titles.map((title) => ({ title, done: false })) }
              : x,
          ),
        );
      }
    } catch {
      /* ignore — the button can be tapped again */
    } finally {
      setBreakingGoalId(null);
    }
  }
  function toggleGoalTask(goalId: string, index: number) {
    const t = goals.find((x) => x.id === goalId)?.tasks?.[index];
    if (t && !t.done) award(10); // checking off a step earns XP
    setGoals((prev) =>
      prev.map((g) =>
        g.id === goalId
          ? {
              ...g,
              tasks: (g.tasks ?? []).map((t, i) =>
                i === index ? { ...t, done: !t.done } : t,
              ),
            }
          : g,
      ),
    );
  }
  // Take the learner to chat and have Eliora coach them through a specific step:
  // the tiniest first action + resources for online/study work + a focus sprint.
  function helpWithTask(g: SmartGoal, taskTitle: string) {
    if (busy) return;
    setTab("chat");
    const goalText = g.statement?.trim() || g.specific;
    send(
      `Help me actually do this step toward my goal — walk me through it, don't ` +
        `just cheerlead. Step: "${taskTitle}" (part of my goal "${goalText}"` +
        (g.subject ? `, subject: ${g.subject}` : "") +
        `). Break it into the ONE tiniest thing I can do right now to start. If ` +
        `it's a learning or online task, give me a couple of real study videos ` +
        `and links/docs to do the research. Then offer to start a focus sprint ` +
        `with me. Keep it to one tiny step — don't dump the whole thing.`,
    );
  }

  // Persist the 4-year academic roadmap.
  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(FOUR_YEAR_KEY, JSON.stringify(fourYearPlan));
    } catch {
      /* ignore */
    }
  }, [fourYearPlan, loaded]);

  // Persist semester reflections.
  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(REFLECTIONS_KEY, JSON.stringify(reflections));
    } catch {
      /* ignore */
    }
  }, [reflections, loaded]);

  // Persist the AI monthly progress recaps.
  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(MONTHLY_REPORTS_KEY, JSON.stringify(monthlyReports));
    } catch {
      /* ignore */
    }
  }, [monthlyReports, loaded]);

  // Persist the AI weekly progress recaps.
  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(WEEKLY_REPORTS_KEY, JSON.stringify(weeklyReports));
    } catch {
      /* ignore */
    }
  }, [weeklyReports, loaded]);

  // Persist the cross-semester reflection summary.
  useEffect(() => {
    if (!loaded) return;
    try {
      if (reflectionSummary)
        localStorage.setItem(
          REFLECTION_SUMMARY_KEY,
          JSON.stringify(reflectionSummary),
        );
      else localStorage.removeItem(REFLECTION_SUMMARY_KEY);
    } catch {
      /* ignore */
    }
  }, [reflectionSummary, loaded]);

  // Persist the time-management toggle.
  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(TIME_MGMT_KEY, timeMgmt ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [timeMgmt, loaded]);

  // Persist today's tasks.
  useEffect(() => {
    if (!loaded) return;
    try {
      if (dailyTasks) localStorage.setItem(DAILY_KEY, JSON.stringify(dailyTasks));
      else localStorage.removeItem(DAILY_KEY);
    } catch {
      /* ignore */
    }
  }, [dailyTasks, loaded]);

  // Persist today's schedule.
  useEffect(() => {
    if (!loaded) return;
    try {
      if (schedule) localStorage.setItem(SCHEDULE_KEY, JSON.stringify(schedule));
      else localStorage.removeItem(SCHEDULE_KEY);
    } catch {
      /* ignore */
    }
  }, [schedule, loaded]);

  // Persist the learner's home / free-to-study hour.
  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(HOMETIME_KEY, String(homeHour));
    } catch {
      /* ignore */
    }
  }, [homeHour, loaded]);

  // Build today's after-school study schedule from when they get home + how they
  // study (profile) + their real work (plan steps, tasks, assignments).
  const generateStudySchedule = async (opts?: {
    homeHour?: number;
    budgetMin?: number;
    focusNote?: string;
  }) => {
    if (generatingSchedule) return;
    setGeneratingSchedule(true);
    try {
      const today = localISO();
      const planSteps = plan.filter((m) => !m.done).map((m) => m.title);
      const budgetMin = opts?.budgetMin ?? scheduleBudgetMin;
      const focusNote = (opts?.focusNote ?? scheduleFocusNote).trim();
      // Pass each open task with its time estimate so the schedule can budget
      // the evening by minutes (e.g. "Review Bio notes (~20 min)").
      const taskTitles =
        dailyTasks?.date === today
          ? dailyTasks.tasks
              .filter((t) => !t.done)
              .map((t) =>
                t.estMin ? `${t.title} (~${t.estMin} min)` : t.title,
              )
          : [];
      const res = await fetch("/api/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "schedule",
          homeHour: opts?.homeHour ?? homeHour,
          budgetMin: budgetMin || undefined,
          focusNote: focusNote || undefined,
          profile: profile ?? undefined,
          plan: planSteps,
          tasks: taskTitles,
          assignments: assignments
            .filter((a) => !a.done)
            .map((a) => ({ title: a.title, subject: a.subject, due: a.due })),
          goals: goals.length ? goals : undefined,
        }),
      });
      const data = (await res.json()) as {
        blocks?: { hour?: number; kind?: string; text?: string }[];
      };
      const blocks = Array.isArray(data.blocks) ? data.blocks : [];
      if (blocks.length) {
        const map: Record<number, ScheduleBlock> = {};
        for (const b of blocks) {
          if (
            typeof b.hour === "number" &&
            b.hour >= 9 &&
            b.hour <= 20 &&
            (b.text ?? "").trim()
          ) {
            const kind = (
              ["study", "break", "class", "other"] as ScheduleKind[]
            ).includes(b.kind as ScheduleKind)
              ? (b.kind as ScheduleKind)
              : "study";
            map[b.hour] = { text: String(b.text).trim(), kind };
          }
        }
        if (Object.keys(map).length) setSchedule({ date: today, blocks: map });
      }
    } catch {
      /* ignore — the button can be tapped again */
    } finally {
      setGeneratingSchedule(false);
    }
  };

  // Take the schedule-setup survey answers, remember the learner's study prefs
  // on their profile, then build today's schedule from the fresh answers.
  const handleScheduleSurvey = (a: {
    homeTime: string;
    budget: string;
    focusTime: string;
    sessionLength: string;
    focusHelp: string;
    focusNote: string;
  }) => {
    const nextHomeHour = HOME_TIME_HOUR[a.homeTime] ?? homeHour;
    const budgetMin = a.budget ? STUDY_BUDGET_MIN[a.budget] : undefined;
    setHomeHour(nextHomeHour);
    setScheduleBudgetMin(budgetMin);
    setScheduleFocusNote(a.focusNote);
    if (profile && (a.focusTime || a.sessionLength || a.focusHelp)) {
      const next: LearnerProfile = {
        ...profile,
        focusTime: a.focusTime || profile.focusTime,
        sessionLength: a.sessionLength || profile.sessionLength,
        focusHelp: a.focusHelp || profile.focusHelp,
      };
      setProfile(next);
      try {
        localStorage.setItem(PROFILE_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
    }
    generateStudySchedule({
      homeHour: nextHomeHour,
      budgetMin,
      focusNote: a.focusNote,
    });
  };

  // Update one hour block of today's schedule (starting a fresh day if needed).
  const setScheduleBlock = (hour: number, patch: Partial<ScheduleBlock>) => {
    const today = localISO();
    setSchedule((prev) => {
      const base =
        prev && prev.date === today ? prev : { date: today, blocks: {} };
      const existing: ScheduleBlock = base.blocks[hour] ?? {
        text: "",
        kind: "study",
      };
      return {
        date: today,
        blocks: { ...base.blocks, [hour]: { ...existing, ...patch } },
      };
    });
  };
  // Wipe today's schedule clean.
  const clearSchedule = () => setSchedule({ date: localISO(), blocks: {} });

  // The day's task time budget, taken from today's schedule: each hour block
  // marked "study" contributes 60 minutes. 0 when there's no schedule yet.
  const scheduledStudyMin =
    schedule && schedule.date === localISO()
      ? Object.values(schedule.blocks).filter((b) => b.kind === "study")
          .length * 60
      : 0;

  // Generate a fresh set of tasks for today, grounded in the learner's plan,
  // goals, calendar, assignments, and weak spots. If today's schedule exists,
  // its study time becomes the budget the tasks' estimates must fit.
  const generateDailyTasks = async () => {
    if (dailyLoading) return;
    setDailyLoading(true);
    try {
      const res = await fetch("/api/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "daily",
          budgetMin: scheduledStudyMin || undefined,
          plan: plan.filter((m) => !m.done).map((m) => m.title),
          goals: goals.length ? goals : undefined,
          events: events.length ? events : undefined,
          assignments: assignments
            .filter((a) => !a.done)
            .map((a) => ({ title: a.title, subject: a.subject, due: a.due })),
          missed: missed.length ? missed : undefined,
          mistakes: mistakes.length ? mistakes : undefined,
          profile: profile ?? undefined,
        }),
      });
      const data = (await res.json()) as {
        items?: Array<SugItem & { estMin?: number; priority?: string }>;
      };
      const items = Array.isArray(data.items) ? data.items : [];
      if (items.length) {
        setDailyTasks({
          date: localISO(),
          tasks: items
            .filter((it) => it.title)
            .map((it) => {
              const m = Number(it.estMin);
              const p = it.priority;
              return {
                title: String(it.title).trim(),
                why: it.why || undefined,
                subject: it.subject || undefined,
                priority:
                  p === "high" || p === "med" || p === "low" ? p : "med",
                estMin: Number.isFinite(m) && m > 0 ? Math.round(m) : undefined,
                done: false,
              };
            }),
        });
      }
    } catch {
      /* ignore — the card offers a manual retry */
    } finally {
      setDailyLoading(false);
    }
  };

  // Auto-refresh once per day: when a new day begins (or there are no tasks yet),
  // generate a fresh list. `dailyAttemptRef` records the last date we tried so an
  // empty/failed attempt doesn't loop.
  const dailyAttemptRef = useRef<string>("");
  useEffect(() => {
    if (!loaded || dailyLoading) return;
    const today = localISO();
    if (dailyTasks?.date === today) return; // already have today's set
    if (dailyAttemptRef.current === today) return; // already tried today
    // Only auto-generate once the learner has enough set up to ground the tasks.
    const hasContext =
      !!profile?.klass?.trim() || plan.length > 0 || goals.length > 0;
    if (!hasContext) return;
    dailyAttemptRef.current = today;
    void generateDailyTasks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, dailyTasks, profile, plan, goals, dailyLoading]);

  // Toggle a today's-task done; award XP the first time each is completed.
  const toggleDailyTask = (i: number) => {
    setDailyTasks((prev) => {
      if (!prev) return prev;
      const tasks = prev.tasks.map((t, x) =>
        x === i ? { ...t, done: !t.done } : t,
      );
      if (!prev.tasks[i]?.done && tasks[i]?.done) award(15, "task done");
      return { ...prev, tasks };
    });
  };

  // Adjust a task's time budget (minutes). 0/blank clears the estimate.
  const setDailyTaskMin = (i: number, min: number) => {
    setDailyTasks((prev) => {
      if (!prev) return prev;
      const estMin = Number.isFinite(min) && min > 0 ? Math.round(min) : undefined;
      const tasks = prev.tasks.map((t, x) => (x === i ? { ...t, estMin } : t));
      return { ...prev, tasks };
    });
  };

  // Re-rank a task's priority (High/Med/Low). Ordering + time budget follow it.
  const setDailyTaskPriority = (i: number, priority: Priority) => {
    setDailyTasks((prev) => {
      if (!prev) return prev;
      const tasks = prev.tasks.map((t, x) =>
        x === i ? { ...t, priority } : t,
      );
      return { ...prev, tasks };
    });
  };

  // Divide a fixed block of study minutes across today's open tasks, weighted by
  // priority (High tasks get the biggest slice), writing each task's estMin.
  const budgetDailyTime = (blockMin: number) => {
    setDailyTasks((prev) => {
      if (!prev) return prev;
      const slices = budgetByPriority(prev.tasks, blockMin);
      const tasks = prev.tasks.map((t, x) =>
        slices[x] != null ? { ...t, estMin: slices[x] } : t,
      );
      return { ...prev, tasks };
    });
  };

  // Persist progress XP log.
  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
    } catch {
      /* ignore */
    }
  }, [progress, loaded]);

  // Persist minutes-studied log.
  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(STUDY_KEY, JSON.stringify(studyLog));
    } catch {
      /* ignore */
    }
  }, [studyLog, loaded]);

  // Persist which badges have been rewarded.
  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(BADGES_KEY, JSON.stringify(claimedBadges));
    } catch {
      /* ignore */
    }
  }, [claimedBadges, loaded]);

  // Reward newly-earned badges: grant each badge's bonus XP once, then mark it
  // claimed and pop a celebration. Adding the XP can push the learner over the
  // next badge's threshold — the effect re-runs and rewards that one too.
  useEffect(() => {
    if (!loaded) return;
    const fresh = earnedBadgeIds(progress, goals).filter(
      (id) => !claimedBadges.includes(id),
    );
    if (!fresh.length) return;
    const defs = fresh
      .map((id) => BADGE_DEFS.find((b) => b.id === id))
      .filter((b): b is BadgeDef => Boolean(b));
    const totalReward = defs.reduce((s, d) => s + d.reward, 0);
    const t = localISO();
    setProgress((p) => ({ ...p, [t]: (p[t] || 0) + totalReward }));
    setClaimedBadges((prev) => [...prev, ...fresh]);
    setBadgeCelebration(defs[0]);
    setXpToast(
      defs.length === 1
        ? `🎖️ ${defs[0].label} earned · +${totalReward} XP`
        : `🎖️ ${defs.length} badges earned · +${totalReward} XP`,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress, goals, claimedBadges, loaded]);

  // Persist the equipped study-room reward.
  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(ROOM_KEY, equippedRoom);
    } catch {
      /* ignore */
    }
  }, [equippedRoom, loaded]);

  // Persist the chosen AI tutor, and point read-aloud at that tutor's voice so
  // they sound like themselves. Settings' VoicePicker writes the same key, so
  // picking a voice by hand there still wins until the tutor is changed again.
  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(TUTOR_KEY, tutorId);
      localStorage.setItem(TTS_VOICE_KEY, tutorById(tutorId).voice);
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tutorId, loaded]);

  // Persist the uploaded textbook digests.
  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(MATERIAL_KEY, JSON.stringify(materials));
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [materials, loaded]);

  // Persist the learner's custom rewards + spent-XP balance.
  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(CUSTOM_REWARDS_KEY, JSON.stringify(customRewards));
      localStorage.setItem(SPENT_KEY, String(spentXp));
    } catch {
      /* ignore */
    }
  }, [customRewards, spentXp, loaded]);

  // Build (or rebuild) the roadmap. With `blank`, start an empty 4-year skeleton
  // the learner fills in; otherwise ask Eliora to draft it toward the destination.
  async function generateFourYearPlan(input: FypGenInput) {
    if (generatingFyp) return;
    const dest = input.career.trim();
    if (input.blank) {
      setFourYearPlan({
        destination: dest,
        years: blankYearLabels(input.grade ?? "").map((label) => ({
          label,
          courses: [],
          milestones: [],
        })),
      });
      setTab("plan");
      return;
    }
    if (!dest) return;
    setGeneratingFyp(true);
    try {
      const res = await fetch("/api/four-year-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          destination: dest,
          classes: input.classes?.trim() || undefined,
          grade: input.grade?.trim() || undefined,
          strengths: input.strengths?.trim() || undefined,
          interests: input.interests?.trim() || undefined,
          afterPlan: input.afterPlan?.trim() || undefined,
          notes: input.notes?.trim() || undefined,
          requirements: input.requirements?.trim() || undefined,
          catalog: input.catalog?.trim() || undefined,
          docs: input.docs?.length ? input.docs : undefined,
          profile: profile ?? undefined,
        }),
      });
      const data = (await res.json()) as {
        plan?: FourYearPlan;
        error?: string;
      };
      if (data.plan?.years?.length) {
        const np = normalizeFourYearPlan(data.plan, dest);
        setFourYearPlan(np);
        // After a survey-built plan, jump to chat and advise the next steps;
        // otherwise (e.g. Rebuild) just show the refreshed roadmap.
        if (input.advise) adviseNextSteps(np);
        else setTab("plan");
      }
    } catch {
      /* ignore — the button can be tapped again */
    } finally {
      setGeneratingFyp(false);
    }
  }

  // Take the freshly built roadmap to chat and have Eliora advise what to do
  // NEXT — the couple of things to focus on this year + one tiny first step.
  function adviseNextSteps(fp: FourYearPlan) {
    setTab("chat");
    const y1 = fp.years[0];
    const summary = fp.years
      .map((y) => {
        const cs = y.courses.map((c) => c.title).join(", ");
        const ms = y.milestones.map((m) => m.title).join(", ");
        return `${y.label} — courses: ${cs || "—"}${
          ms ? `; milestones: ${ms}` : ""
        }`;
      })
      .join(" | ");
    send(
      `I just built my 4-year plan toward becoming ${
        fp.destination || "my career goal"
      }. Here it is: ${summary}. It's saved in my Plan tab. In a few short, ` +
        `encouraging lines, tell me what to do NEXT — the 2–3 things to focus on ` +
        `THIS year (${y1?.label ?? "year 1"}) and the ONE tiny first step I can ` +
        `take today. If a step needs resources, share a real link or two ` +
        `(never invent a URL). Keep it simple.`,
    );
  }

  function setFypDestination(dest: string) {
    setFourYearPlan((p) => (p ? { ...p, destination: dest } : p));
  }
  // Apply a change to a single year, leaving the rest untouched.
  function fypMutateYear(i: number, fn: (y: FourYearYear) => FourYearYear) {
    setFourYearPlan((p) =>
      p ? { ...p, years: p.years.map((y, idx) => (idx === i ? fn(y) : y)) } : p,
    );
  }
  function addFypCourse(i: number, title: string) {
    const t = title.trim();
    if (!t) return;
    fypMutateYear(i, (y) => ({ ...y, courses: [...y.courses, { title: t }] }));
  }
  function removeFypCourse(i: number, ci: number) {
    fypMutateYear(i, (y) => ({
      ...y,
      courses: y.courses.filter((_, x) => x !== ci),
    }));
  }
  function toggleFypCourse(i: number, ci: number) {
    fypMutateYear(i, (y) => ({
      ...y,
      courses: y.courses.map((c, x) =>
        x === ci ? { ...c, done: !c.done } : c,
      ),
    }));
  }
  // Patch a single course's fields (level/grade) so the tracker can compute GPA.
  function setFypCourse(i: number, ci: number, patch: Partial<FourYearCourse>) {
    fypMutateYear(i, (y) => ({
      ...y,
      courses: y.courses.map((c, x) => (x === ci ? { ...c, ...patch } : c)),
    }));
  }
  function addFypMilestone(i: number, title: string) {
    const t = title.trim();
    if (!t) return;
    fypMutateYear(i, (y) => ({
      ...y,
      milestones: [...y.milestones, { title: t }],
    }));
  }
  function removeFypMilestone(i: number, mi: number) {
    fypMutateYear(i, (y) => ({
      ...y,
      milestones: y.milestones.filter((_, x) => x !== mi),
    }));
  }
  function toggleFypMilestone(i: number, mi: number) {
    fypMutateYear(i, (y) => ({
      ...y,
      milestones: y.milestones.map((m, x) =>
        x === mi ? { ...m, done: !m.done } : m,
      ),
    }));
  }
  function toggleFypCheckpoint(i: number, mi: number) {
    fypMutateYear(i, (y) => ({
      ...y,
      milestones: y.milestones.map((m, x) =>
        x === mi ? { ...m, checkpoint: !m.checkpoint } : m,
      ),
    }));
  }
  function clearFourYearPlan() {
    if (
      window.confirm("Clear your whole 4-year plan? This can't be undone.")
    ) {
      setFourYearPlan(null);
    }
  }
  // Generate (or regenerate) the AI monthly recap for a month. The MonthlyReport
  // component has already tallied the month's stats from the local logs; this just
  // sends them to Eliora and stores the returned recap (keyed by "YYYY-MM").
  async function generateMonthlyReport(
    monthKey: string,
    payload: Record<string, unknown>,
  ) {
    if (monthlyReportBusy) return;
    setMonthlyReportBusy(monthKey);
    try {
      const res = await fetch("/api/monthly-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, profile: profile ?? undefined }),
      });
      const data = (await res.json()) as {
        message?: string;
        focus?: string[];
        error?: string;
      };
      if (data.message) {
        setMonthlyReports((prev) => ({
          ...prev,
          [monthKey]: {
            message: data.message!,
            focus: data.focus ?? [],
            generatedAt: new Date().toISOString(),
          },
        }));
      }
    } catch {
      /* ignore — the button can be tapped again */
    } finally {
      setMonthlyReportBusy(null);
    }
  }
  // Generate (or regenerate) the AI weekly "what you learned" recap for a week.
  // The WeeklyRecap component has already tallied the week's stats from the local
  // logs; this just sends them to Eliora and stores the returned recap (keyed by
  // the Monday's "YYYY-MM-DD").
  async function generateWeeklyReport(
    weekKey: string,
    payload: Record<string, unknown>,
  ) {
    if (weeklyReportBusy) return;
    setWeeklyReportBusy(weekKey);
    try {
      const res = await fetch("/api/weekly-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, profile: profile ?? undefined }),
      });
      const data = (await res.json()) as {
        message?: string;
        focus?: string[];
        error?: string;
      };
      if (data.message) {
        setWeeklyReports((prev) => ({
          ...prev,
          [weekKey]: {
            message: data.message!,
            focus: data.focus ?? [],
            generatedAt: new Date().toISOString(),
          },
        }));
      }
    } catch {
      /* ignore — the button can be tapped again */
    } finally {
      setWeeklyReportBusy(null);
    }
  }
  // Post-semester reflection: send the finished year's grades + survey answers to
  // Eliora and store the returned reflection (keyed by year label).
  async function reflectOnYear(
    yearIndex: number,
    answers: { feel: string; wins: string; hard: string; change: string; note: string },
  ) {
    const year = fourYearPlan?.years[yearIndex];
    if (!year) return;
    const cr = (c: FourYearCourse) =>
      typeof c.credits === "number" ? c.credits : 1;
    let gp = 0;
    let w = 0;
    const grades = year.courses
      .filter((c) => c.done)
      .map((c) => {
        const pts = fypGradePoints(c.grade);
        if (pts != null) {
          gp += pts * cr(c);
          w += cr(c);
        }
        return { title: c.title, grade: c.grade };
      });
    const gpa = w > 0 ? gp / w : undefined;
    try {
      const res = await fetch("/api/reflection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          yearLabel: year.label,
          career: fourYearPlan?.destination,
          gpa,
          grades,
          ...answers,
          profile: profile ?? undefined,
        }),
      });
      const data = (await res.json()) as {
        message?: string;
        focus?: string[];
        error?: string;
      };
      if (data.message) {
        setReflections((prev) => ({
          ...prev,
          [year.label]: { message: data.message!, focus: data.focus ?? [] },
        }));
      }
    } catch {
      /* ignore — can retry */
    }
  }
  // Summarize the whole journey across every saved semester reflection.
  async function summarizeReflections() {
    if (summarizingReflections || !fourYearPlan) return;
    const past = fourYearPlan.years
      .filter((y) => reflections[y.label])
      .map((y) => ({
        yearLabel: y.label,
        gpa: fypYearGpa(y),
        message: reflections[y.label].message,
      }));
    if (past.length < 2) return;
    setSummarizingReflections(true);
    try {
      const res = await fetch("/api/reflection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          summary: true,
          career: fourYearPlan.destination,
          reflections: past,
          profile: profile ?? undefined,
        }),
      });
      const data = (await res.json()) as {
        message?: string;
        focus?: string[];
        error?: string;
      };
      if (data.message)
        setReflectionSummary({ message: data.message, focus: data.focus ?? [] });
    } catch {
      /* ignore — can retry */
    } finally {
      setSummarizingReflections(false);
    }
  }
  // Turn the reflections (summary + focuses + each year's reflection) into SMART
  // goals and add them to the Goals section.
  async function goalsFromReflections() {
    if (creatingReflGoals) return;
    const parts: string[] = [];
    if (reflectionSummary) {
      parts.push(reflectionSummary.message);
      if (reflectionSummary.focus.length)
        parts.push(`Focus areas: ${reflectionSummary.focus.join("; ")}`);
    }
    for (const [label, r] of Object.entries(reflections)) {
      parts.push(`${label}: ${r.message}`);
      if (r.focus.length) parts.push(`${label} focus: ${r.focus.join("; ")}`);
    }
    const reflection = parts.join("\n").trim();
    if (!reflection) return;
    setCreatingReflGoals(true);
    try {
      const res = await fetch("/api/goal-suggestions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reflection,
          career: fourYearPlan?.destination,
          existing: goals.map((g) => g.specific),
          profile: profile ?? undefined,
        }),
      });
      const data = (await res.json()) as {
        suggestions?: {
          specific: string;
          horizon?: string;
          measurable?: string;
          timeBound?: string;
          subject?: string;
        }[];
      };
      const have = new Set(goals.map((g) => g.specific.trim().toLowerCase()));
      const fresh = (data.suggestions ?? [])
        .filter((s) => s.specific?.trim())
        .filter((s) => !have.has(s.specific.trim().toLowerCase()))
        .slice(0, 4);
      if (fresh.length) {
        for (const s of fresh) {
          addGoal({
            specific: s.specific,
            measurable: s.measurable,
            timeBound: s.timeBound,
            subject: s.subject,
            horizon: (["short", "mid", "long"].includes(s.horizon ?? "")
              ? s.horizon
              : "short") as GoalHorizon,
            relevant: "Based on my semester reflection.",
          });
        }
        setPlanSection("goals");
        setXpToast(`🎯 Added ${fresh.length} goal${fresh.length > 1 ? "s" : ""}`);
      }
    } catch {
      /* ignore — can retry */
    } finally {
      setCreatingReflGoals(false);
    }
  }
  // Edit the graduation credit requirements (so the tracker shows the right
  // "credits left"). Learners can adjust the AI's numbers or add their own.
  function setFypRequirement(i: number, required: number) {
    setFourYearPlan((p) =>
      p
        ? {
            ...p,
            requirements: (p.requirements ?? []).map((r, idx) =>
              idx === i ? { ...r, required: Math.max(0, required) } : r,
            ),
          }
        : p,
    );
  }
  function addFypRequirement(subject: string, required: number) {
    const s = subject.trim();
    if (!s) return;
    setFourYearPlan((p) =>
      p
        ? {
            ...p,
            requirements: [
              ...(p.requirements ?? []),
              { subject: s, required: Math.max(0, required) },
            ],
          }
        : p,
    );
  }
  function removeFypRequirement(i: number) {
    setFourYearPlan((p) =>
      p
        ? { ...p, requirements: (p.requirements ?? []).filter((_, x) => x !== i) }
        : p,
    );
  }
  function setFypTotalRequired(n: number | undefined) {
    setFourYearPlan((p) =>
      p ? { ...p, totalRequired: n != null ? Math.max(0, n) : undefined } : p,
    );
  }
  // One-tap typical US high-school requirements, for learners who don't have
  // their school's numbers in hand — editable afterwards like any other entry.
  // Only offered when no requirements exist yet, so nothing is overwritten.
  function useTypicalFypRequirements() {
    setFourYearPlan((p) =>
      p
        ? {
            ...p,
            requirements: p.requirements?.length
              ? p.requirements
              : [
                  { subject: "English", required: 4 },
                  { subject: "Math", required: 3 },
                  { subject: "Science", required: 3 },
                  { subject: "Social Studies", required: 3 },
                  { subject: "World Language", required: 2 },
                  { subject: "PE / Health", required: 2 },
                  { subject: "Arts", required: 1 },
                  { subject: "Electives", required: 6 },
                ],
            totalRequired: p.totalRequired ?? 24,
          }
        : p,
    );
  }
  function setFypGpaGoal(n: number | undefined) {
    setFourYearPlan((p) =>
      p
        ? { ...p, gpaGoal: n != null ? Math.min(5, Math.max(0, n)) : undefined }
        : p,
    );
  }
  function setFypProjectedGrade(grade: string) {
    setFourYearPlan((p) => (p ? { ...p, projectedGrade: grade } : p));
  }
  // Fold grades pulled from an uploaded transcript into the plan: match each one
  // to an existing course by title (so it counts toward the GPA calculator), and
  // append the leftovers as completed courses to Year 1. Returns a tally so the
  // panel can tell the learner what happened.
  function applyFypGrades(
    entries: {
      title: string;
      grade: string;
      credits?: number;
      level?: CourseLevel;
    }[],
  ): { matched: number; added: number } {
    const cur = fourYearPlan;
    if (!cur || !entries.length) return { matched: 0, added: 0 };
    const norm = (s: string) =>
      s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const years = cur.years.map((y) => ({
      ...y,
      courses: y.courses.map((c) => ({ ...c })),
    }));
    const claimed = new Set<string>();
    let matched = 0;
    const unmatched: typeof entries = [];
    for (const e of entries) {
      const en = norm(e.title);
      if (!en) continue;
      let best: { yi: number; ci: number; score: number } | null = null;
      years.forEach((y, yi) =>
        y.courses.forEach((c, ci) => {
          const key = `${yi}:${ci}`;
          if (claimed.has(key)) return;
          const cn = norm(c.title);
          if (!cn) return;
          let score = 0;
          if (cn === en) score = 3;
          else if (cn.includes(en) || en.includes(cn)) score = 2;
          else {
            const ew = new Set(en.split(" "));
            const overlap = cn.split(" ").filter((w) => ew.has(w)).length;
            if (overlap >= 2) score = 1;
          }
          if (score && (!best || score > best.score))
            best = { yi, ci, score };
        }),
      );
      if (best) {
        const b: { yi: number; ci: number; score: number } = best;
        const c = years[b.yi].courses[b.ci];
        c.grade = e.grade;
        c.done = true;
        if (c.credits == null && e.credits != null) c.credits = e.credits;
        if (!c.level && e.level) c.level = e.level;
        claimed.add(`${b.yi}:${b.ci}`);
        matched++;
      } else {
        unmatched.push(e);
      }
    }
    if (unmatched.length) {
      years[0] = {
        ...years[0],
        courses: [
          ...years[0].courses,
          ...unmatched.map((e) => ({
            title: e.title,
            grade: e.grade,
            done: true,
            credits: e.credits,
            level: e.level,
          })),
        ],
      };
    }
    setFourYearPlan({ ...cur, years });
    return { matched, added: unmatched.length };
  }
  // Jump to chat and have Eliora surface REAL resources + a tiny first step for
  // completing a specific roadmap milestone, tied to the learner's career goal.
  function milestoneResources(title: string) {
    if (busy) return;
    setTab("chat");
    const career = fourYearPlan?.destination?.trim();
    send(
      `I want to complete this milestone from my 4-year plan${
        career ? ` (career goal: ${career})` : ""
      }: "${title}". Show me real resources to get it done — 2–3 genuinely ` +
        `useful links or docs (real, well-known sites; use a Google search link ` +
        `if you're unsure — never invent a URL), plus a study video if one helps ` +
        `(use search_youtube). Then give me the ONE tiny first step to start. ` +
        `Keep it short.`,
    );
  }

  // Persist weak topics for revision.
  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(MISSED_KEY, JSON.stringify(missed));
    } catch {
      /* ignore */
    }
  }, [missed, loaded]);

  function addMissed(topic: string) {
    const t = topic.trim();
    if (!t) return;
    setMissed((prev) => (prev.includes(t) ? prev : [...prev, t]));
  }

  // Persist the mistake tracker.
  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(MISTAKES_KEY, JSON.stringify(mistakes));
    } catch {
      /* ignore */
    }
  }, [mistakes, loaded]);

  // Add a concept to the mistake tracker — or, if it's already there, bump its
  // count + lastSeen and reopen it (it came up again). Deduped case-insensitively
  // by concept; a fresh why/fix backfills fields the existing entry was missing.
  function logMistake(m: {
    concept: string;
    subject?: string;
    why?: string;
    fix?: string;
    source: MistakeSource;
  }) {
    const concept = m.concept.trim();
    if (!concept) return;
    const now = new Date().toISOString();
    const clean = (v?: string) => (v && v.trim() ? v.trim() : undefined);
    setMistakes((prev) => {
      const i = prev.findIndex(
        (x) => x.concept.toLowerCase() === concept.toLowerCase(),
      );
      if (i >= 0) {
        const copy = [...prev];
        const cur = copy[i];
        copy[i] = {
          ...cur,
          count: cur.count + 1,
          lastSeen: now,
          resolved: false,
          subject: cur.subject || clean(m.subject),
          why: cur.why || clean(m.why),
          fix: cur.fix || clean(m.fix),
        };
        return copy;
      }
      return [
        ...prev,
        {
          id: `m${Date.now().toString(36)}${Math.random()
            .toString(36)
            .slice(2, 8)}`,
          concept,
          subject: clean(m.subject),
          why: clean(m.why),
          fix: clean(m.fix),
          source: m.source,
          count: 1,
          createdAt: now,
          lastSeen: now,
          resolved: false,
        },
      ];
    });
  }

  function setMistakeResolved(id: string, resolved: boolean) {
    setMistakes((prev) =>
      prev.map((m) => (m.id === id ? { ...m, resolved } : m)),
    );
  }

  function removeMistake(id: string) {
    setMistakes((prev) => prev.filter((m) => m.id !== id));
  }

  // Jump to chat and have Eliora re-teach a tracked mistake from scratch.
  function reviewMistake(m: Mistake) {
    if (busy) return;
    setTab("chat");
    send(
      `Help me finally get "${m.concept}"${
        m.subject ? ` (${m.subject})` : ""
      } — it's on my mistake tracker` +
        (m.count > 1 ? ` and I've gotten it wrong ${m.count} times` : "") +
        `.${m.why ? ` I keep messing up: ${m.why}.` : ""} Re-teach it in a ` +
        `fresh, simple way tied to my interests, give me one worked example, ` +
        `then quiz me on just this to check it stuck.`,
    );
  }

  // Persist subject folders.
  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(SUBJECTS_KEY, JSON.stringify(subjects));
    } catch {
      /* ignore */
    }
  }, [subjects, loaded]);

  function addSubject(name: string) {
    const n = name.trim();
    if (!n) return;
    setSubjects((prev) =>
      prev.some((s) => s.toLowerCase() === n.toLowerCase()) ? prev : [...prev, n],
    );
  }
  function removeSubject(name: string) {
    setSubjects((prev) => prev.filter((s) => s !== name));
  }

  // Persist + apply accessibility settings to the whole app.
  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(A11Y_KEY, JSON.stringify(a11y));
    } catch {
      /* ignore */
    }
    const b = document.body;
    b.classList.toggle("a11y-dyslexic", a11y.dyslexic);
    b.classList.toggle("a11y-spacing", a11y.spacing);
    b.classList.toggle("a11y-contrast", a11y.contrast);
    b.classList.toggle("a11y-reduce-motion", a11y.reduceMotion);
    document.documentElement.setAttribute("data-theme", a11y.theme);
    document.documentElement.classList.toggle(
      "dark",
      DARK_THEMES.includes(a11y.theme),
    );
    b.style.setProperty("zoom", String(a11y.fontScale || 1));
  }, [a11y, loaded]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  function handleProfile(p: LearnerProfile) {
    try {
      localStorage.setItem(PROFILE_KEY, JSON.stringify(p));
    } catch {
      /* ignore */
    }
    const firstTime = !profile;
    setProfile(p);
    setEditing(false);
    if (firstTime) {
      // Auto-build the plan right after sign-up: show a warm "building it now"
      // greeting, then silently kick off plan creation (see the effect below).
      const name = p.name?.trim() ? `, ${p.name.trim()}` : "";
      setMessages([
        {
          role: "assistant",
          content:
            `Hi${name} 🌱 Thanks for sharing all that — give me a sec to look ` +
            `over your answers.`,
        },
      ]);
      setTab("chat");
      setAutoBuild(true);
    } else if (messages.length === 0) {
      setMessages([greetingFor(p)]);
    }
  }

  // After a fresh sign-up, silently kick off the analysis — Eliora reflects on
  // the survey and chats a little before building the plan (see profileContext).
  useEffect(() => {
    if (!autoBuild || !profile || busy) return;
    setAutoBuild(false);
    send(
      "I just finished the sign-up survey. First, ANALYZE my answers — in 2–4 " +
        "warm, specific sentences reflect back what stands out (my class, my " +
        "biggest challenge, how I like to learn, what helps me focus, my study " +
        "habits, and my goal), connecting the dots. Then chat with me a little: " +
        "ask me ONE short, friendly question to understand what's most pressing " +
        "right now. Do NOT build the plan yet — but build it on my very next " +
        "answer (don't keep asking more questions).",
      { hidden: true },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoBuild, profile, busy]);

  // Start a brand-new chat tab and switch to it. Opens the sidebar with the new
  // chat's name field focused so the user can name it right away (optional).
  function newChat() {
    const id = newChatId();
    const msgs = profile ? [greetingFor(profile)] : [];
    setChats((prev) => [...prev, { id, title: chatTitle(msgs), messages: msgs }]);
    setActiveChatId(id);
    setInput("");
    setTab("chat");
    setSidebarOpen(true);
    setEditingChatId(id);
    setEditTitle("");
  }

  // Start a brand-new chat that's already about a topic: create the chat, name
  // it after the topic, switch to it, and queue a kickoff message so Eliora
  // opens the conversation on that subject (sent once the new chat is active).
  function startTopicChat(rawTopic: string) {
    const topic = rawTopic.trim();
    if (!topic || busy || pendingKickoff) return;
    const id = newChatId();
    // Keep the greeting first so send()'s history slicing stays correct.
    const msgs = profile ? [greetingFor(profile)] : [];
    const title = topic.length > 26 ? topic.slice(0, 26) + "…" : topic;
    setChats((prev) => [
      ...prev,
      { id, title, messages: msgs, named: true },
    ]);
    setActiveChatId(id);
    setInput("");
    setTab("chat");
    setSidebarOpen(false);
    setPendingKickoff(
      `I want to work on ${topic}. First, help me actually understand it — a ` +
        `quick, beginner-friendly intro, then research ${topic} and explain it ` +
        `clearly, and share a couple of real study videos or links (sources) I ` +
        `can learn from. Walk me through ${topic} step by step, checking in as ` +
        `we go. Then, once I've got the basics down, switch into a teach-back on ` +
        `the same topic (the Feynman technique) — ` +
        teachBackChallenge(teachLevel) +
        ` Finally, once it's clicked, ` +
        extraWork(),
    );
  }

  // Read an uploaded textbook chapter / photographed page / pasted text into a
  // digest the tutor can teach from. The heavy file goes to the server exactly
  // once — from then on only the small digest travels with each chat message.
  async function addMaterial({ file, text }: { file?: File; text?: string }) {
    if (materialBusy) return;
    const label = file?.name ?? "your notes";
    setMaterialError("");
    setMaterialBusy(label);
    try {
      const payload: Record<string, unknown> = {
        profile: profile ?? undefined,
        subject: subjects[0] || undefined,
      };
      if (file) {
        // Text files go up as text; PDFs and photos go up as base64 for the
        // model to read directly (same path the lesson + notes tools use).
        const isText =
          file.type.startsWith("text/") ||
          /\.(txt|md|markdown|csv)$/i.test(file.name);
        payload.fileName = file.name;
        if (isText) {
          payload.text = await file.text();
        } else {
          const dataUrl: string = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result ?? ""));
            reader.onerror = () => reject(new Error("Couldn't read that file"));
            reader.readAsDataURL(file);
          });
          payload.fileBase64 = dataUrl.split(",")[1] ?? "";
          payload.fileMediaType = file.type || "application/octet-stream";
        }
      } else {
        payload.text = text;
      }

      const res = await fetch("/api/material", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`Upload failed (${res.status})`);
      const data = (await res.json()) as {
        material?: StudyMaterial;
        error?: string;
      };
      if (!data.material) {
        setMaterialError(data.error || "Couldn't read that material.");
        return;
      }
      // Newest last — materialContext() keeps the most recent ones when it
      // trims to MATERIAL_MAX, and so does this.
      setMaterials((prev) => [...prev, data.material!].slice(-MATERIAL_MAX));
    } catch (e) {
      setMaterialError(
        e instanceof Error ? e.message : "Couldn't read that material.",
      );
    } finally {
      setMaterialBusy(null);
    }
  }

  function removeMaterial(id: string) {
    setMaterials((prev) => prev.filter((m) => m.id !== id));
  }

  // Open a fresh chat with a tutor. The persona itself rides along in the
  // request body (see the `tutor` field in send()), so the kickoff only has to
  // get the conversation started in their voice.
  function startTutorChat(tutor: ElioraTutor) {
    if (busy || pendingKickoff) return;
    setTutorId(tutor.id);
    const id = newChatId();
    // Keep the greeting first so send()'s history slicing stays correct.
    const msgs = profile ? [greetingFor(profile)] : [];
    setChats((prev) => [
      ...prev,
      {
        id,
        title: `${tutor.emoji} ${tutor.name}`,
        messages: msgs,
        named: true,
      },
    ]);
    setActiveChatId(id);
    setInput("");
    setTab("chat");
    setSidebarOpen(false);
    const book = materials[materials.length - 1];
    setPendingKickoff(
      `I'd like to work with you, ${tutor.name}. Introduce yourself in a line ` +
        `or two, say how you like to teach ${tutor.subject.toLowerCase()}, and ` +
        (book
          ? `mention that you've read my material ("${book.title}") and will ` +
            `teach from it. Then ask me ONE question — which section I want to ` +
            `start with, or what I'm stuck on.`
          : `then ask me ONE question about what I'm working on right now so we ` +
            `can start on something small.`),
    );
  }

  // The "extra work" tail — an applied challenge / mini-project the learner
  // does AFTER the teach-back, using the topic on a fresh real-world example to
  // make it stick. Practice, not a graded assignment, so Eliora coaches rather
  // than doing it. Shared so any lesson flow that wants extra work stays in sync.
  function extraWork(): string {
    return (
      `give me a small piece of extra work to make it stick: an applied ` +
      `challenge or mini-project where I use what I just learned on a fresh, ` +
      `real-world example (not one we already did). Explain the task in a line ` +
      `or two and what "done" looks like, then let me attempt it and coach my ` +
      `work — don't do it for me.`
    );
  }

  // The teach-back (Feynman) challenge tail — identical whether the teach-back
  // stands alone or caps off a lesson, so both flows stay in sync. It's the
  // part after "…and": frame the challenge, wait, then surface gaps + coach.
  function teachBackChallenge(level: TeachLevel = "middle"): string {
    return (
      `give me a short teaching challenge, pitched at a ` +
      `${teachLevelWord(level)} level. ` +
      teachLevelFraming(level) +
      `Then wait for my explanation. Once I've explained, tell me what I got ` +
      `right, what's missing, and any misconceptions — then coach me on the ` +
      `gaps so it sticks.`
    );
  }

  // The message that kicks off a teach-back (Feynman) exercise in chat. If a
  // concept is given it's baked in; otherwise Eliora picks one from the
  // conversation so far (or asks). Eliora frames the challenge, waits for the
  // learner's explanation, then surfaces gaps + misconceptions and coaches.
  function teachBackKickoff(concept: string, level: TeachLevel = "middle"): string {
    const c = concept.trim();
    const about = c
      ? `the concept "${c}"`
      : "a concept from what we've been working on (or ask me what I want to teach)";
    return (
      `Let's do a teach-back so I can find the holes in what I know (the ` +
      `Feynman technique). Pick ${about} and ` +
      teachBackChallenge(level)
    );
  }

  // Open a brand-new chat that runs a teach-back on a concept (Home card path).
  function startTeachBack(rawConcept: string, level: TeachLevel = "middle") {
    const concept = rawConcept.trim();
    if (!concept || busy || pendingKickoff) return;
    const id = newChatId();
    // Keep the greeting first so send()'s history slicing stays correct.
    const msgs = profile ? [greetingFor(profile)] : [];
    const label = `Teach back: ${concept}`;
    const title = label.length > 28 ? label.slice(0, 28) + "…" : label;
    setChats((prev) => [...prev, { id, title, messages: msgs, named: true }]);
    setActiveChatId(id);
    setInput("");
    setTab("chat");
    setSidebarOpen(false);
    setPendingKickoff(teachBackKickoff(concept, level));
  }

  // Open a brand-new chat where you teach a topic to Eliora playing a student
  // with a particular learning style (Home "Teach a student" card path).
  function startTeachStudent(
    rawTopic: string,
    style: StudentStyle,
    level: TeachLevel = "middle",
  ) {
    const topic = rawTopic.trim();
    if (!topic || busy || pendingKickoff) return;
    const s = studentStyleInfo(style);
    const id = newChatId();
    // Keep the greeting first so send()'s history slicing stays correct.
    const msgs = profile ? [greetingFor(profile)] : [];
    const label = `Teach ${s.name}: ${topic}`;
    const title = label.length > 28 ? label.slice(0, 28) + "…" : label;
    setChats((prev) => [...prev, { id, title, messages: msgs, named: true }]);
    setActiveChatId(id);
    setInput("");
    setTab("chat");
    setSidebarOpen(false);
    setPendingKickoff(teachStudentKickoff(topic, style, level));
  }

  // Start a teach-back inside the CURRENT chat (composer quick-action). Uses
  // whatever's in the composer as the concept, or lets Eliora pick from context.
  function teachBackInChat() {
    if (busy || pendingKickoff) return;
    const concept = input.trim();
    setInput("");
    void send(teachBackKickoff(concept, teachLevel));
  }

  // Ask Eliora for one quick, practical study tip. Ties it to whatever the
  // learner typed (or the current lesson topic) so the tip fits what they're
  // working on right now, not generic advice.
  function studyTipInChat() {
    if (busy || pendingKickoff) return;
    const topic = input.trim() || activeChat?.title?.trim() || "";
    setInput("");
    void send(studyTipPrompt(topic));
  }

  // Open the camera recorder so the learner can teach the concept out loud.
  // Their spoken explanation (transcribed) is what gets sent to Eliora.
  function recordTeachBack() {
    if (busy || pendingKickoff) return;
    setRecorderOpen(input.trim());
  }

  // Called when a recording is finished: send the transcript as the learner's
  // teach-back explanation and frame it so Eliora critiques it for gaps.
  function submitRecordedTeachBack(transcript: string) {
    setRecorderOpen(null);
    const text = transcript.trim();
    if (!text) return;
    setInput("");
    void send(
      `I just recorded myself teaching this back out loud, aiming for a ` +
        `${teachLevelWord(teachLevel)} level. Here's what I said:\n\n` +
        `"${text}"\n\n` +
        `Check my explanation the way a teacher would, holding me to a ` +
        `${teachLevelWord(teachLevel)} standard: point out anything I got wrong ` +
        `or muddled, the gaps or missing steps, and one thing I explained well. ` +
        `Then ask me ` +
        (teachLevel === "college" || teachLevel === "high"
          ? `two probing questions to expose the biggest gaps.`
          : teachLevel === "kindergarten" || teachLevel === "elementary"
            ? `one gentle question to close the biggest gap.`
            : `one question to close the biggest gap.`),
    );
  }

  // Send the queued kickoff once the new topic chat has become the active chat,
  // so the message lands in the new conversation rather than the previous one.
  useEffect(() => {
    if (!pendingKickoff || busy) return;
    const text = pendingKickoff;
    setPendingKickoff(null);
    void send(text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingKickoff, activeChatId, busy]);

  function closeChat(id: string) {
    // Confirm before deleting a conversation that has real messages — chats are
    // saved, so this is permanent. Empty "New chat" tabs delete without a prompt.
    const chat = chats.find((c) => c.id === id);
    const hasContent = chat?.messages.some((m) => m.role === "user") ?? false;
    if (
      hasContent &&
      !window.confirm("Delete this conversation? This can't be undone.")
    )
      return;
    setChats((prev) => {
      const remaining = prev.filter((c) => c.id !== id);
      if (!remaining.length) {
        const nid = newChatId();
        const msgs = profile ? [greetingFor(profile)] : [];
        setActiveChatId(nid);
        return [{ id: nid, title: chatTitle(msgs), messages: msgs }];
      }
      if (id === activeChatId) setActiveChatId(remaining[0].id);
      return remaining;
    });
  }

  function togglePlan(i: number) {
    if (plan[i] && !plan[i].done) award(15); // completing a plan step earns XP
    setPlan((prev) =>
      prev.map((m, idx) => (idx === i ? { ...m, done: !m.done } : m)),
    );
  }
  // The learner adds their own step to the plan.
  function addMilestone(title: string) {
    const t = title.trim();
    if (!t) return;
    setPlan((prev) =>
      prev.some((m) => m.title === t)
        ? prev
        : [...prev, { title: t, done: false, added: true }],
    );
  }
  function removeMilestone(i: number) {
    setPlan((prev) => prev.filter((_, idx) => idx !== i));
  }
  // The learner edits a plan step in place: rename it, change its detail, or
  // toggle whether it's a checkpoint. Only the provided fields are changed.
  function editMilestone(
    i: number,
    patch: { title?: string; detail?: string; checkpoint?: boolean },
  ) {
    setPlan((prev) =>
      prev.map((m, idx) => {
        if (idx !== i) return m;
        const next = { ...m };
        if (patch.title !== undefined) {
          const t = patch.title.trim();
          if (t) next.title = t;
        }
        if (patch.detail !== undefined) {
          const d = patch.detail.trim();
          next.detail = d || undefined;
        }
        if (patch.checkpoint !== undefined)
          next.checkpoint = patch.checkpoint || undefined;
        return next;
      }),
    );
  }
  // Ask Eliora to (re)build the plan from the whole conversation so far.
  function buildPlanFromChat() {
    if (busy) return;
    setTab("chat");
    send(PLAN_FROM_CHAT_PROMPT);
  }
  // Build the study plan (milestones) from the survey answers.
  async function generateStudyPlan(a: {
    subject: string;
    working: string;
    goal: string;
    deadline: string;
    learningStyle: string;
    time: string;
  }) {
    if (generatingStudyPlan) return;
    setGeneratingStudyPlan(true);
    try {
      const res = await fetch("/api/study-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...a, profile: profile ?? undefined }),
      });
      const data = (await res.json()) as {
        milestones?: IncomingMilestone[];
        error?: string;
      };
      if (data.milestones?.length) {
        if (a.subject.trim()) addSubject(a.subject.trim());
        setPlan((prev) => appendPlan(prev, data.milestones!));
        setShowStudySurvey(false);
      }
    } catch {
      /* ignore — the button can be tapped again */
    } finally {
      setGeneratingStudyPlan(false);
      setStudyPlanSubject("");
    }
  }
  // One-tap: build a plan straight from a subject name (no survey needed).
  function buildPlanForSubject(subject: string) {
    if (generatingStudyPlan) return;
    setStudyPlanSubject(subject.trim());
    generateStudyPlan({
      subject,
      working: "",
      goal: "",
      deadline: "",
      learningStyle: "",
      time: "",
    });
  }
  // Add another class (from the Plan-tab survey) and extend the plan for it.
  function addClass(d: {
    klass: string;
    struggles: string;
    goal: string;
    level: string;
    confidence: string;
  }) {
    const klass = d.klass.trim();
    if (!klass || busy) return;
    addSubject(klass);
    setTab("chat");
    const struggles = d.struggles.trim();
    const goal = d.goal.trim();
    const level = d.level.trim();
    const confidence = d.confidence.trim();
    send(
      `I also need help with another class: ${klass}.` +
        (level ? ` How much I already know here: ${level}.` : "") +
        (confidence ? ` How confident I feel about it: ${confidence}.` : "") +
        (struggles ? ` In this class I struggle with: ${struggles}.` : "") +
        (goal ? ` What I want to get done: ${goal}.` : "") +
        ` Add this class to my learning plan — call save_plan with the FULL ` +
        `updated list that KEEPS all my existing steps and ADDS 2–4 small steps ` +
        `(include one checkpoint) for ${klass}. Use my level and confidence above ` +
        `to set where the steps START: begin with the fundamentals if I'm new or ` +
        `low-confidence, or skip ahead to more challenging work if I'm strong. ` +
        `Start each new step's title with "${klass}: " so I can tell my classes ` +
        `apart. Then give me a short 2–3 sentence walkthrough and one tiny step ` +
        `to start.`,
      { hidden: true },
    );
  }
  function toggleNextStep() {
    const i = plan.findIndex((m) => !m.done);
    if (i >= 0) togglePlan(i);
  }

  // Make a study guide focused on the questions the learner just got wrong.
  function studyGuideFromQuiz(detail: string) {
    setTab("chat");
    send(
      "I just took a quiz and missed some questions. Make me a focused study " +
        "guide on ONLY these. For each one: first show me what I got wrong (my " +
        "answer vs. the correct answer), then gently walk me through WHY my " +
        "answer was wrong and re-teach the right idea in a fresh, simple way. " +
        "Once you've covered them all, give me 2–3 quick practice questions on " +
        "just these so I can check it stuck:\n" +
        detail,
    );
  }

  // Turn picked files into attachments and stage them in the composer.
  async function addFiles(list: FileList | File[] | null) {
    if (!list) return;
    const files = Array.from(list);
    if (!files.length) return;
    setAttaching(true);
    try {
      const room = Math.max(0, MAX_ATTACHMENTS - attachments.length);
      const built = await Promise.all(
        files.slice(0, room).map((f) => fileToAttachment(f).catch(() => null)),
      );
      const ok = built.filter((a): a is Attachment => a !== null);
      if (ok.length) setAttachments((prev) => [...prev, ...ok].slice(0, MAX_ATTACHMENTS));
    } finally {
      setAttaching(false);
    }
  }

  function removeAttachment(i: number) {
    setAttachments((prev) => prev.filter((_, idx) => idx !== i));
  }

  // Resolves with the assistant's finished reply, so callers that need the
  // answer (voice mode reads it aloud) don't have to watch `messages`.
  async function send(
    override?: string,
    opts?: { hidden?: boolean },
  ): Promise<string> {
    const text = (typeof override === "string" ? override : input).trim();
    // A typed override (quick chip, auto-build) is text-only; a real learner
    // turn may carry attachments with no text, which is a valid message.
    const outgoing = typeof override === "string" ? [] : attachments;
    if ((!text && outgoing.length === 0) || busy) return "";

    const userMsg: Message = {
      role: "user",
      content: text,
      ...(outgoing.length ? { attachments: outgoing } : {}),
    };
    // The model always sees the user/kickoff message; for a silent auto-build
    // (opts.hidden) we don't render it as a user bubble — only the reply shows.
    const apiMessages: Message[] = [...messages, userMsg];
    const visible: Message[] = opts?.hidden ? [...messages] : apiMessages;
    setMessages([...visible, { role: "assistant", content: "" }]);
    if (typeof override !== "string") {
      setInput("");
      setAttachments([]);
    }
    setBusy(true);
    setChatStatus(null);
    const aborter = new AbortController();
    chatAbortRef.current = aborter;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: aborter.signal,
        // Send role+text history plus the profile and current plan for context.
        body: JSON.stringify({
          messages: apiMessages
            .slice(1)
            .map((m) => ({
              role: m.role,
              content: m.content,
              ...(m.attachments?.length ? { attachments: m.attachments } : {}),
            })),
          profile: profile ?? undefined,
          plan: plan.length ? plan : undefined,
          events: events.length ? events : undefined,
          missed: missed.length ? missed : undefined,
          mistakes: mistakes.length ? mistakes : undefined,
          subjects: subjects.length ? subjects : undefined,
          assignments: assignments.length ? assignments : undefined,
          goals: goals.length ? goals : undefined,
          fourYearPlan: fourYearPlan ?? undefined,
          tutor: tutorId !== ELIORA_DEFAULT_TUTOR ? tutorId : undefined,
          material: materials.length ? materials : undefined,
        }),
      });

      // A non-200 (e.g. a dev-server hiccup) must surface as an error, not a
      // silent empty reply.
      if (!res.ok) throw new Error(`Chat request failed (${res.status})`);
      if (!res.body) throw new Error("No response stream");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let acc = "";
      const videos: Video[] = [];
      const socials: SocialRec[] = [];
      const examples: StudentExample[] = [];
      let flashcards: Flashcard[] | undefined;
      let quiz: QuizQuestion[] | undefined;

      const applyEvent = (line: string) => {
        if (!line.trim()) return;
        let evt: {
          type: string;
          value?: string;
          items?:
            | Video[]
            | SocialRec[]
            | StudentExample[]
            | IncomingMilestone[]
            | Flashcard[]
            | QuizQuestion[];
          item?: StudyEvent;
          name?: string;
        };
        try {
          evt = JSON.parse(line);
        } catch {
          return;
        }
        if (evt.type === "plan") {
          setPlan((prev) =>
            mergePlan(prev, (evt.items as IncomingMilestone[]) ?? []),
          );
          return;
        }
        if (evt.type === "event" && evt.item) {
          addEvent(evt.item);
          return;
        }
        if (evt.type === "folder" && evt.name) {
          addSubject(evt.name);
          return;
        }
        if (evt.type === "assignment" && evt.item) {
          const a = evt.item as unknown as {
            title?: string;
            subject?: string;
            due?: string;
          };
          if (a.title) {
            addAssignment({ title: a.title, subject: a.subject, due: a.due });
          }
          return;
        }
        if (evt.type === "goal" && evt.item) {
          const g = evt.item as unknown as Omit<SmartGoal, "id" | "done">;
          if (g.specific) addGoal(g);
          return;
        }
        if (evt.type === "mistake" && evt.item) {
          const mk = evt.item as unknown as {
            concept?: string;
            subject?: string;
            why?: string;
            fix?: string;
          };
          if (mk.concept) {
            logMistake({
              concept: mk.concept,
              subject: mk.subject,
              why: mk.why,
              fix: mk.fix,
              source: "chat",
            });
          }
          return;
        }
        if (evt.type === "fourYearPlan") {
          const item = (evt as { item?: unknown }).item;
          if (item) setFourYearPlan(normalizeFourYearPlan(item));
          return;
        }
        if (evt.type === "status") {
          setChatStatus(evt.value || null);
          return;
        }
        if (evt.type === "text" && evt.value) {
          acc += evt.value;
          setChatStatus(null);
        }
        else if (evt.type === "videos" && evt.items)
          videos.push(...(evt.items as Video[]));
        else if (evt.type === "socials" && evt.items)
          socials.push(...(evt.items as SocialRec[]));
        else if (evt.type === "examples" && evt.items)
          examples.push(...(evt.items as StudentExample[]));
        else if (evt.type === "flashcards")
          flashcards = (evt.items as Flashcard[]) ?? [];
        else if (evt.type === "quiz") quiz = (evt.items as QuizQuestion[]) ?? [];
        setMessages((prev) => {
          const copy = [...prev];
          copy[copy.length - 1] = {
            role: "assistant",
            content: acc,
            videos: videos.length ? [...videos] : undefined,
            socials: socials.length ? [...socials] : undefined,
            examples: examples.length ? [...examples] : undefined,
            flashcards,
            quiz,
          };
          return copy;
        });
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) applyEvent(line);
      }
      applyEvent(buffer);
      return acc;
    } catch (err) {
      const stopped = err instanceof DOMException && err.name === "AbortError";
      setMessages((prev) => {
        const copy = [...prev];
        const last = copy[copy.length - 1];
        if (stopped) {
          // Keep whatever streamed before Stop; only fill a truly empty bubble.
          if (!last?.content) {
            copy[copy.length - 1] = {
              role: "assistant",
              content: "Okay, stopped. Ask me anything when you're ready. 🌱",
            };
          }
        } else {
          copy[copy.length - 1] = {
            role: "assistant",
            content: "Sorry, I couldn't reach the server. Please try again.",
          };
        }
        return copy;
      });
      return stopped ? "" : "Sorry, I couldn't reach the server. Please try again.";
    } finally {
      chatAbortRef.current = null;
      setBusy(false);
      setChatStatus(null);
    }
  }

  // Cancels the in-flight reply (the Send button becomes Stop while busy).
  function stopReply() {
    chatAbortRef.current?.abort();
  }

  if (!loaded) return null;

  if (!profile || editing) {
    return (
      <SignUp
        initial={profile}
        onComplete={handleProfile}
        onCancel={profile ? () => setEditing(false) : undefined}
      />
    );
  }

  const heroName = profile?.name?.trim() ? `, ${profile.name.trim()}` : "";
  return (
    <div style={styles.shell}>
      <button
        className="eliora-side-toggle"
        style={styles.sideToggle}
        onClick={() => setSidebarOpen((s) => !s)}
        aria-label="Toggle menu"
      >
        ☰
      </button>
      {sidebarOpen && (
        <div
          style={styles.sideBackdrop}
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <aside
        className={"eliora-sidebar" + (sidebarOpen ? " open" : "")}
        style={styles.sidebar}
      >
        <div style={styles.sideBrand}>Eliora 🌱</div>
        <button
          style={styles.sideNewChat}
          onClick={() => newChat()}
          disabled={busy}
        >
          ✏️ New chat
        </button>
        <nav style={styles.sideNav}>
          {(
            [
              ["home", "🏠 Home"],
              ["chat", "💬 Chat"],
              ["notebook", "📓 Smart Notes"],
              ["practice", "🧠 Practice"],
              ["calendar", "📅 Calendar"],
              ["plan", "🎯 Plan"],
              ["progress", "📊 Progress"],
              ["study", "📋 Study"],
              ["together", "👥 Study Together"],
              ["folder", "🗂️ Shared Folder"],
              ["school", "🏫 School"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              style={{
                ...styles.sideNavItem,
                ...(tab === key ? styles.sideNavItemActive : {}),
              }}
              onClick={() => {
                setTab(key);
                setSidebarOpen(false);
              }}
            >
              {label}
            </button>
          ))}
        </nav>
        <div style={styles.sideChatsLabel}>
          <span>Chats</span>
          <button
            style={styles.sideFolderAdd}
            title="New folder"
            aria-label="New folder"
            onClick={() => {
              const name = window.prompt("New folder name");
              if (name) createFolder(name);
            }}
          >
            📁﹢
          </button>
        </div>
        <div style={styles.sideChats}>
          {folders.map((f) => {
            const inFolder = chats.filter((c) => c.folderId === f.id);
            const collapsed = collapsedFolders[f.id];
            return (
              <div key={f.id}>
                <div style={styles.folderHeader}>
                  <button
                    style={styles.folderHeaderBtn}
                    onClick={() =>
                      setCollapsedFolders((p) => ({ ...p, [f.id]: !p[f.id] }))
                    }
                  >
                    {collapsed ? "▸" : "▾"} 📁 {f.name}
                    <span style={styles.folderCount}>{inFolder.length}</span>
                  </button>
                  <button
                    style={styles.sideChatDel}
                    title="Delete folder"
                    aria-label="Delete folder"
                    onClick={() => deleteFolder(f.id)}
                  >
                    ×
                  </button>
                </div>
                {!collapsed && inFolder.map(renderChat)}
              </div>
            );
          })}
          {chats
            .filter(
              (c) => !c.folderId || !folders.some((f) => f.id === c.folderId),
            )
            .map(renderChat)}
        </div>
        <div style={styles.sideFooter}>
          <div style={{ position: "relative" }}>
            <button
              style={{ ...styles.sideFootBtn, position: "relative" }}
              onClick={() => setShowNotifs((v) => !v)}
              aria-label={
                shownReminders.length
                  ? `Notifications (${shownReminders.length} new)`
                  : "Notifications"
              }
              title="Notifications"
            >
              🔔
              {shownReminders.length > 0 && (
                <span style={styles.notifBadge}>
                  {shownReminders.length > 9 ? "9+" : shownReminders.length}
                </span>
              )}
            </button>
            {showNotifs && (
              <div style={styles.notifPanel} role="dialog" aria-label="Notifications">
                <div style={styles.notifHead}>
                  <span style={{ fontWeight: 700 }}>🔔 Notifications</span>
                  {notifSupported && !remindersOn && (
                    <button style={styles.linkBtn} onClick={enableNotifications}>
                      Turn on
                    </button>
                  )}
                  <button
                    style={styles.notifClose}
                    onClick={() => setShowNotifs(false)}
                    aria-label="Close notifications"
                  >
                    ×
                  </button>
                </div>
                {shownReminders.length === 0 ? (
                  <p style={styles.notifEmpty}>You&apos;re all caught up 🎉</p>
                ) : (
                  shownReminders.map((r) => (
                    <div key={r.id} style={styles.reminderRow}>
                      <button
                        style={styles.reminderCheck}
                        onClick={() => checkReminder(r)}
                        aria-label="Mark done"
                        title="Mark done"
                      />
                      <button
                        style={styles.reminderText}
                        onClick={() => {
                          setShowNotifs(false);
                          handleReminder(r);
                        }}
                      >
                        <span style={{ flexShrink: 0 }}>{r.icon}</span>
                        <span style={{ flex: 1, textAlign: "left" }}>
                          {r.text}
                        </span>
                        <span style={{ color: "var(--muted)" }}>›</span>
                      </button>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
          <button
            style={styles.sideFootBtn}
            onClick={() =>
              setA11y((prev) => {
                const i = THEMES.findIndex((t) => t.key === prev.theme);
                return { ...prev, theme: THEMES[(i + 1) % THEMES.length].key };
              })
            }
            aria-label="Cycle theme"
            title={`Theme: ${
              THEMES.find((t) => t.key === a11y.theme)?.label ?? "Light"
            } — tap to change`}
          >
            {THEMES.find((t) => t.key === a11y.theme)?.emoji ?? "☀️"}
          </button>
          <button
            style={styles.sideFootBtn}
            onClick={() => setShowA11y(true)}
            aria-label="Preferences"
            title="Preferences"
          >
            ⚙️
          </button>
          {session?.user && (
            <button
              style={styles.sideFootUser}
              onClick={() => signOut({ callbackUrl: "/" })}
              title={`Signed in as ${session.user.email ?? session.user.name ?? ""}`}
            >
              {session.user.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={session.user.image}
                  alt=""
                  style={styles.avatar}
                  referrerPolicy="no-referrer"
                />
              ) : null}
              Sign out
            </button>
          )}
        </div>
      </aside>

      <main style={styles.mainCol}>
        <div style={styles.topNotifWrap}>
          <button
            style={styles.topNotifBtn}
            onClick={() => setShowTopNotifs((v) => !v)}
            aria-label={
              shownReminders.length
                ? `Notifications (${shownReminders.length} new)`
                : "Notifications"
            }
            title="Notifications"
          >
            🔔
            {shownReminders.length > 0 && (
              <span style={styles.notifBadge}>
                {shownReminders.length > 9 ? "9+" : shownReminders.length}
              </span>
            )}
          </button>
          {showTopNotifs && (
            <div
              style={styles.topNotifPanel}
              role="dialog"
              aria-label="Notifications"
            >
              <div style={styles.notifHead}>
                <span style={{ fontWeight: 700 }}>🔔 Notifications</span>
                {notifSupported && !remindersOn && (
                  <button style={styles.linkBtn} onClick={enableNotifications}>
                    Turn on
                  </button>
                )}
                <button
                  style={styles.notifClose}
                  onClick={() => setShowTopNotifs(false)}
                  aria-label="Close notifications"
                >
                  ×
                </button>
              </div>
              {shownReminders.length === 0 ? (
                <p style={styles.notifEmpty}>You&apos;re all caught up 🎉</p>
              ) : (
                shownReminders.map((r) => (
                  <div key={r.id} style={styles.reminderRow}>
                    <button
                      style={styles.reminderCheck}
                      onClick={() => checkReminder(r)}
                      aria-label="Mark done"
                      title="Mark done"
                    />
                    <button
                      style={styles.reminderText}
                      onClick={() => {
                        setShowTopNotifs(false);
                        handleReminder(r);
                      }}
                    >
                      <span style={{ flexShrink: 0 }}>{r.icon}</span>
                      <span style={{ flex: 1, textAlign: "left" }}>
                        {r.text}
                      </span>
                      <span style={{ color: "var(--muted)" }}>›</span>
                    </button>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
        {showA11y && (
          <AccessibilityPanel
            value={a11y}
            onChange={setA11y}
            onClose={() => setShowA11y(false)}
          />
        )}

        {xpToast && (
          <div style={styles.xpToast} className="fade-in">
            {xpToast}
          </div>
        )}

        {badgeCelebration && (
          <div
            style={styles.overlay}
            onClick={() => setBadgeCelebration(null)}
          >
            <div
              style={styles.badgeModal}
              className="fade-in"
              onClick={(e) => e.stopPropagation()}
            >
              <div style={styles.badgeCelebrateKicker}>🎉 Badge earned!</div>
              <div
                style={{
                  ...styles.badgeModalMedal,
                  background: badgeCelebration.bg,
                }}
              >
                {badgeCelebration.emoji}
              </div>
              <div style={styles.badgeModalTitle}>{badgeCelebration.label}</div>
              <div
                style={{
                  ...styles.badgeModalStatus,
                  background: "var(--accent-soft)",
                  color: "var(--accent)",
                }}
              >
                ⭐ +{badgeCelebration.reward} XP reward
              </div>
              <p style={styles.badgeModalBlurb}>{badgeCelebration.blurb}</p>
              <button
                style={styles.goalSuggestBtn}
                onClick={() => setBadgeCelebration(null)}
              >
                Awesome!
              </button>
            </div>
          </div>
        )}

        {incomingShare && (
          <div style={styles.overlay} onClick={() => setIncomingShare(null)}>
            <div
              style={styles.badgeModal}
              className="fade-in"
              onClick={(e) => e.stopPropagation()}
            >
              <div style={styles.badgeCelebrateKicker}>
                {incomingShare.kind === "flashcards" ? "🃏 Shared deck" : "📝 Shared notes"}
              </div>
              <div style={styles.badgeModalTitle}>
                {incomingShare.title ||
                  (incomingShare.kind === "flashcards"
                    ? "Flashcards from a friend"
                    : "Notes from a friend")}
              </div>
              <p style={styles.badgeModalBlurb}>
                {incomingShare.kind === "flashcards"
                  ? `A friend shared ${incomingShare.cards.length} flashcard${
                      incomingShare.cards.length === 1 ? "" : "s"
                    } with you. Add them to your chat to study?`
                  : "A friend shared study notes with you. Add them to your chat?"}
              </p>
              <div style={styles.shareModalActions}>
                <button
                  style={styles.secondaryBtn}
                  onClick={() => setIncomingShare(null)}
                >
                  Not now
                </button>
                <button
                  style={styles.goalSuggestBtn}
                  onClick={() => importShare(incomingShare)}
                >
                  Add to my chat
                </button>
              </div>
            </div>
          </div>
        )}

        {reviewFor && (
          <div style={styles.reviewBanner}>
            <span style={{ flex: 1 }}>
              🎉 Nice work finishing <b>{reviewFor.title}</b>! Want feedback on
              it?
            </span>
            <button
              style={styles.reviewYes}
              onClick={() => {
                setFeedbackSeed(reviewFor.title);
                setReviewFor(null);
                setTab("study");
              }}
            >
              ✍️ Review my work
            </button>
            <button
              style={styles.reviewNo}
              onClick={() => setReviewFor(null)}
              aria-label="Dismiss"
            >
              Not now
            </button>
          </div>
        )}

        {recorderOpen !== null && (
          <TeachBackRecorder
            concept={recorderOpen}
            onSubmit={submitRecordedTeachBack}
            onClose={() => setRecorderOpen(null)}
          />
        )}

        {tab === "home" && (
          <div style={styles.studyScroll}>
            <div
              style={{
                ...styles.heroRoomBanner,
                background: roomById(equippedRoom).bg,
              }}
            >
              <span style={styles.heroRoomEmoji}>
                {roomById(equippedRoom).emoji}
              </span>
              <span style={styles.heroRoomName}>
                {roomById(equippedRoom).name} study room
              </span>
            </div>
            <div style={styles.homeHero}>
              <h1 style={styles.homeHi}>Hi{heroName} 🌱</h1>
              <p style={styles.homeSub}>What do you want to work on today?</p>
            </div>
            <TutorPicker
              selected={tutorId}
              busy={busy || !!pendingKickoff}
              materials={materials}
              materialBusy={materialBusy}
              materialError={materialError}
              onSelect={setTutorId}
              onStart={startTutorChat}
              onAddMaterial={(s) => void addMaterial(s)}
              onRemoveMaterial={removeMaterial}
            />
            <VideoFeed
              topics={Array.from(
                new Set(
                  [
                    ...subjects,
                    profile?.klass ?? "",
                    ...(profile?.subjectsStudying?.split(/[,;]+/) ?? []),
                  ]
                    .map((s) => s.trim())
                    .filter(Boolean),
                ),
              ).slice(0, 5)}
            />
            <DailyTasksCard
              state={dailyTasks}
              loading={dailyLoading}
              budgetMin={scheduledStudyMin}
              onGenerate={generateDailyTasks}
              onToggle={toggleDailyTask}
              onSetMin={setDailyTaskMin}
              onSetPriority={setDailyTaskPriority}
              onBudget={budgetDailyTime}
            />
            <DeadlineCountdownCard
              events={events}
              assignments={assignments}
              goals={goals}
              onOpen={() => setTab("calendar")}
            />
            <LearnStarter
              profile={profile}
              subjects={subjects}
              missed={missed}
              busy={busy || !!pendingKickoff}
              level={teachLevel}
              onLearn={startTopicChat}
              onTeachBack={startTeachBack}
            />
            <TeachStudentStarter
              subjects={subjects}
              missed={missed}
              busy={busy || !!pendingKickoff}
              style={studentStyle}
              onStyle={setStudentStyle}
              level={teachLevel}
              onLevel={setTeachLevel}
              onTeach={startTeachStudent}
            />
            <StudyNextCard
              profile={profile}
              missed={missed}
              events={events}
              career={fourYearPlan?.destination}
              busy={busy || !!pendingKickoff}
              onStart={startTopicChat}
            />
            <ProgressCard log={progress} study={studyLog} goals={goals} />
            <RewardsCard
              totalXp={totalXp}
              equipped={equippedRoom}
              onEquip={setEquippedRoom}
            />
            <MyRewardsCard
              availableXp={availableXp}
              rewards={customRewards}
              goals={goals}
              onAdd={addCustomReward}
              onRedeem={redeemCustomReward}
              onRemove={removeCustomReward}
            />
            <div className="eliora-home-actions" style={styles.homeActions}>
              {(
                [
                  ["💬", "New chat", "Talk through anything", () => newChat()],
                  ["📝", "Summarize notes", "Notes → study set", () => {
                    setNotesView("summarize");
                    setTab("notebook");
                  }],
                  ["🧠", "Practice quiz", "Test what you know", () => setTab("practice")],
                  ["🎯", "My plan", "See your next step", () => setTab("plan")],
                  ["🗺️", "4-year plan", "Map your path", () => setTab("plan")],
                  ["🏫", "Connect school", "Import assignments & grades", () => setTab("school")],
                  ["🗂️", "Shared folder", "Tests & assignments with a friend", () => setTab("folder")],
                ] as const
              ).map(([emoji, title, desc, fn]) => (
                <button
                  key={title}
                  className="eliora-action-card"
                  style={styles.homeAction}
                  onClick={fn}
                >
                  <span style={styles.homeActionIcon}>{emoji}</span>
                  <span style={styles.homeActionTitle}>{title}</span>
                  <span style={styles.homeActionDesc}>{desc}</span>
                </button>
              ))}
            </div>
            {shownReminders.length > 0 && (
              <div style={styles.card}>
                <div style={styles.cardHead}>
                  <span style={styles.cardClass}>🔔 Reminders</span>
                </div>
                {shownReminders.slice(0, 4).map((r) => (
                  <button
                    key={r.id}
                    className="eliora-row-btn"
                    style={styles.reminderText}
                    onClick={() => handleReminder(r)}
                  >
                    <span style={{ flexShrink: 0 }}>{r.icon}</span>
                    <span style={{ flex: 1, textAlign: "left" }}>{r.text}</span>
                    <span style={{ color: "var(--muted)" }}>›</span>
                  </button>
                ))}
              </div>
            )}
            {plan.length > 0 && (
              <PlanStrip
                plan={plan}
                onToggleNext={toggleNextStep}
                onOpen={() => setTab("plan")}
              />
            )}
            <GoalStrip goals={goals} onOpen={() => setTab("plan")} />
            <MistakeCenter
              mistakes={mistakes}
              onAdd={logMistake}
              onReview={reviewMistake}
              onResolve={setMistakeResolved}
              onRemove={removeMistake}
            />
            <FourYearStrip
              plan={fourYearPlan}
              onOpen={() => setTab("plan")}
            />
            {(() => {
              const recents = chats
                .filter(
                  (c) => c.named || c.messages.some((m) => m.role === "user"),
                )
                .slice(-6)
                .reverse();
              return recents.length > 0 ? (
                <div style={styles.card}>
                  <div style={styles.cardHead}>
                    <span style={styles.cardClass}>💬 Recent chats</span>
                  </div>
                  {recents.map((c) => (
                    <button
                      key={c.id}
                      className="eliora-row-btn"
                      style={styles.reminderText}
                      onClick={() => {
                        setActiveChatId(c.id);
                        setTab("chat");
                      }}
                    >
                      <span style={{ flexShrink: 0 }}>💬</span>
                      <span
                        style={{
                          flex: 1,
                          textAlign: "left",
                          overflow: "hidden",
                          whiteSpace: "nowrap",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {c.title}
                      </span>
                      <span style={{ color: "var(--muted)" }}>›</span>
                    </button>
                  ))}
                </div>
              ) : null;
            })()}
          </div>
        )}

      {tab === "notebook" && (
        <div style={{ padding: "8px 16px 24px" }}>
          <h2 style={{ fontSize: 22, fontWeight: 800, color: "var(--accent)", margin: "6px 0 2px" }}>
            📓 Smart Notes
          </h2>
          <p style={{ color: "var(--muted)", fontSize: 14, margin: "0 0 10px" }}>
            {notesView === "notes"
              ? "Your notes — free-form or Cornell, color-code key concepts, link notes with [[title]], and pin sticky notes."
              : "Paste notes, a link, or a doc and turn it into a summary, study guide, flashcards, or a quiz."}
          </p>
          {/* Sub-tabs: the notebook and the summarizer live side by side here. */}
          <div style={{ ...styles.outputRow, marginBottom: 12 }}>
            {(
              [
                ["notes", "📓 My notes"],
                ["summarize", "📝 Summarize"],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                onClick={() => setNotesView(k)}
                style={{
                  ...styles.outChip,
                  ...(notesView === k ? styles.outChipActive : {}),
                }}
              >
                {label}
              </button>
            ))}
          </div>
          {notesView === "notes" ? (
            <NotesWorkspace ns={ns} />
          ) : (
            <Summarizer
              profile={profile}
              onAddToChat={(msg) => {
                setMessages((prev) => [
                  ...prev,
                  {
                    role: "assistant",
                    content: msg.content,
                    flashcards: msg.flashcards,
                    quiz: msg.quiz,
                  },
                ]);
                setTab("chat");
              }}
              onStudyGuide={studyGuideFromQuiz}
            />
          )}
        </div>
      )}

      {tab === "practice" && (
        <PracticeQuiz
          profile={profile}
          subjects={subjects}
          missed={missed}
          onMissed={addMissed}
          onMistake={(m) => logMistake({ ...m, source: "quiz" })}
          onStudyGuide={studyGuideFromQuiz}
        />
      )}


      {tab === "calendar" && (
        <div style={styles.studyScroll}>
          <ScheduleGrid
            schedule={schedule}
            onSet={setScheduleBlock}
            onClear={clearSchedule}
            homeHour={homeHour}
            onSetHomeHour={setHomeHour}
            onGenerate={() => generateStudySchedule()}
            onSetupSubmit={handleScheduleSurvey}
            setupInitial={{
              focusTime: profile?.focusTime,
              sessionLength: profile?.sessionLength,
              focusHelp: profile?.focusHelp,
            }}
            generating={generatingSchedule}
            onStudyMinutes={logStudyMinutes}
          />
          <CalendarPanel
            events={events}
            assignments={assignments}
            dailyTasks={dailyTasks}
            profile={profile}
            career={fourYearPlan?.destination}
            onAdd={addEvent}
            onRemove={removeEvent}
            onBreakDown={breakDownEvent}
            onToggleTask={toggleEventTask}
            breakingEventId={breakingEventId}
          />
        </div>
      )}

      {tab === "plan" && (
        <div style={styles.studyScroll}>
          <div style={styles.planSectionNav}>
            {(
              [
                ["overview", "📋 Overview"],
                ["monthly", "📈 Monthly"],
                ["week", "📆 This week"],
                ["goals", "🌟 Goals"],
                ["tasks", "📌 Tasks"],
                ["steps", "🎯 Study plan"],
                ["fyp", "🗺️ 4-Year"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                style={{
                  ...styles.planSectionBtn,
                  ...(planSection === key ? styles.planSectionBtnActive : {}),
                }}
                onClick={() => setPlanSection(key)}
              >
                {label}
              </button>
            ))}
          </div>

          {planSection === "overview" && (
            <>
              <ProgressCard log={progress} study={studyLog} goals={goals} />
              <PlanStrip
                plan={plan}
                onToggleNext={toggleNextStep}
                onOpen={() => setPlanSection("steps")}
              />
              <GoalStrip goals={goals} onOpen={() => setPlanSection("goals")} />
              {(() => {
                const open = assignments.filter((a) => !a.done);
                if (!open.length) return null;
                const next = [...open].sort((a, b) =>
                  (a.due || "9999").localeCompare(b.due || "9999"),
                )[0];
                return (
                  <div style={styles.planStrip}>
                    <div style={styles.planStripHead}>
                      <span style={styles.planStripLabel}>
                        📌 Assignments · {open.length} to do
                      </span>
                      <button
                        style={styles.linkBtn}
                        onClick={() => setPlanSection("tasks")}
                      >
                        View
                      </button>
                    </div>
                    <button
                      style={styles.planStripNext}
                      onClick={() => setPlanSection("tasks")}
                    >
                      <span style={{ flex: 1, textAlign: "left" }}>
                        <span style={styles.planStripNextLabel}>Next: </span>
                        {next.title}
                      </span>
                      {next.due && (
                        <span style={styles.goalDue}>{countdown(next.due)}</span>
                      )}
                    </button>
                  </div>
                );
              })()}
              <FourYearStrip
                plan={fourYearPlan}
                onOpen={() => setPlanSection("fyp")}
              />
              <button
                style={{ ...styles.goalSuggestBtn, width: "100%" }}
                onClick={() => setPlanSection("week")}
              >
                🗓️ Plan my week
              </button>
              {plan.length === 0 &&
                goals.length === 0 &&
                assignments.length === 0 &&
                !fourYearPlan && (
                  <div style={styles.card}>
                    <p style={{ color: "var(--muted)", margin: "6px 0" }}>
                      Your plan lives here. Use the tabs above to set a goal, add
                      assignments, build a study plan, or map your 4-year path.
                    </p>
                  </div>
                )}
            </>
          )}

          {planSection === "monthly" && (
            <MonthlyReport
              log={progress}
              study={studyLog}
              goals={goals}
              assignments={assignments}
              mistakes={mistakes}
              fourYearPlan={fourYearPlan}
              reports={monthlyReports}
              busyKey={monthlyReportBusy}
              onGenerate={generateMonthlyReport}
            />
          )}

          {planSection === "week" && (
            <>
              <WeeklyLearnedRecap
                log={progress}
                study={studyLog}
                goals={goals}
                assignments={assignments}
                mistakes={mistakes}
                fourYearPlan={fourYearPlan}
                reports={weeklyReports}
                busyKey={weeklyReportBusy}
                onGenerate={generateWeeklyReport}
              />
              {shownReminders.length > 0 && (
                <div style={styles.card}>
                  <div style={styles.cardHead}>
                    <span style={styles.cardClass}>🔔 Reminders</span>
                    {notifSupported && !remindersOn && (
                      <button style={styles.linkBtn} onClick={enableNotifications}>
                        Turn on
                      </button>
                    )}
                  </div>
                  {shownReminders.map((r) => (
                    <div key={r.id} style={styles.reminderRow}>
                      <button
                        style={styles.reminderCheck}
                        onClick={() => checkReminder(r)}
                        aria-label="Mark done"
                        title="Mark done"
                      />
                      <button
                        style={styles.reminderText}
                        onClick={() => handleReminder(r)}
                      >
                        <span style={{ flexShrink: 0 }}>{r.icon}</span>
                        <span style={{ flex: 1, textAlign: "left" }}>
                          {r.text}
                        </span>
                        <span style={{ color: "var(--muted)" }}>›</span>
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <PlanStrip
                plan={plan}
                onToggleNext={toggleNextStep}
                onOpen={() => setTab("chat")}
              />
              <div style={styles.card}>
                <div style={styles.cardHead}>
                  <span style={styles.cardClass}>🗓️ This week</span>
                </div>
                <p
                  style={{
                    color: "var(--muted)",
                    margin: "2px 0 8px",
                    fontSize: 13,
                  }}
                >
                  A focus plan from your goals, calendar &amp; assignments.
                </p>
                <Suggestions
                  kind="week"
                  label="🗓️ Plan my week"
                  resultKey="items"
                  body={{
                    career: fourYearPlan?.destination,
                    goals: goals.length ? goals : undefined,
                    events: events.length ? events : undefined,
                    assignments: assignments.length ? assignments : undefined,
                    profile: profile ?? undefined,
                  }}
                  renderItem={(s, i, drop) => (
                    <div key={i} style={styles.sugItem}>
                      <div style={{ flex: 1 }}>
                        <div style={styles.sugText}>
                          {s.when ? <b>{s.when}: </b> : null}
                          {s.title}
                        </div>
                        {s.why && <div style={styles.sugMeta}>{s.why}</div>}
                      </div>
                      <button
                        style={styles.fypAddPlan}
                        title="Add to Today's assignments"
                        onClick={() => {
                          if (s.title) {
                            addAssignment({ title: s.title });
                            drop();
                          }
                        }}
                      >
                        ＋ To-do
                      </button>
                    </div>
                  )}
                />
              </div>
            </>
          )}

          {planSection === "goals" && (
            <GoalsPanel
              goals={goals}
              subjects={subjects}
              profile={profile}
              career={fourYearPlan?.destination}
              events={events}
              onAdd={addGoal}
              onStep={stepGoal}
              onToggle={toggleGoalDone}
              onRemove={removeGoal}
              onBreakDown={breakDownGoal}
              onToggleTask={toggleGoalTask}
              onHelpTask={helpWithTask}
              breakingGoalId={breakingGoalId}
              rewards={customRewards}
              onLinkReward={linkGoalReward}
            />
          )}

          {planSection === "tasks" && (
            <>
              <AssignmentsPanel
                assignments={assignments}
                subjects={subjects}
                events={events}
                goals={goals}
                profile={profile}
                timeMgmt={timeMgmt}
                onToggleTimeMgmt={() => setTimeMgmt((v) => !v)}
                onSetTime={setAssignmentTime}
                onSetConcern={setAssignmentConcern}
                onAdd={addAssignment}
                onToggle={toggleAssignment}
                onRemove={removeAssignment}
              />
              <div style={styles.card}>
                <div style={styles.cardHead}>
                  <span style={styles.cardClass}>📅 Calendar</span>
                  <button
                    style={styles.linkBtn}
                    onClick={() => setTab("calendar")}
                  >
                    Open ›
                  </button>
                </div>
                <MonthGrid
                  events={events}
                  assignments={assignments}
                  dailyTasks={dailyTasks}
                  onPickDate={() => setTab("calendar")}
                />
              </div>
            </>
          )}

          {planSection === "steps" && (
            <>
              {subjects.length > 0 && !showStudySurvey && (
                <div style={styles.quickPlanCard}>
                  <span style={styles.quickPlanLabel}>
                    ⚡ Instant plan — tap a subject
                  </span>
                  <div style={styles.quickPlanChips}>
                    {subjects.map((s) => {
                      const building =
                        generatingStudyPlan && studyPlanSubject === s;
                      return (
                        <button
                          key={s}
                          style={{
                            ...styles.quickPlanChip,
                            ...(building
                              ? { opacity: 0.6, cursor: "default" }
                              : {}),
                            ...(generatingStudyPlan && !building
                              ? { opacity: 0.4, cursor: "default" }
                              : {}),
                          }}
                          disabled={generatingStudyPlan}
                          onClick={() => buildPlanForSubject(s)}
                          title={`Build a study plan for ${s}`}
                        >
                          {building ? "Building…" : s}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              {showStudySurvey ? (
                <StudyPlanSurvey
                  profile={profile}
                  generating={generatingStudyPlan}
                  onBuild={generateStudyPlan}
                  onCancel={() => setShowStudySurvey(false)}
                />
              ) : plan.length > 0 ? (
                <>
                  <div style={styles.stepsBtnRow}>
                    <button
                      style={styles.planRebuildBtn}
                      disabled={busy}
                      onClick={buildPlanFromChat}
                      title="Rebuild the plan from your conversation"
                    >
                      ↻ Rebuild from chat
                    </button>
                    <button
                      style={styles.goalSuggestBtn}
                      onClick={() => setShowStudySurvey(true)}
                    >
                      📝 Build with a survey
                    </button>
                  </div>
                  <PlanBoard
                    plan={plan}
                    onToggle={togglePlan}
                    onAdd={addMilestone}
                    onRemove={removeMilestone}
                    onEdit={editMilestone}
                  />
                </>
              ) : (
                <div style={styles.card}>
                  <div style={styles.cardHead}>
                    <span style={styles.cardClass}>🎯 Your learning plan</span>
                  </div>
                  <p style={{ color: "var(--muted)", margin: "8px 0 12px" }}>
                    No plan yet. Answer a few questions and Eliora will build one,
                    or build it from your conversation.
                  </p>
                  <button
                    style={{ ...styles.studyToolBtn, width: "100%" }}
                    onClick={() => setShowStudySurvey(true)}
                  >
                    📝 Build my plan with a survey
                  </button>
                  <button
                    style={{
                      ...styles.goalNewBtn,
                      width: "100%",
                      marginTop: 8,
                    }}
                    disabled={busy}
                    onClick={buildPlanFromChat}
                  >
                    🎯 Build from our chat instead
                  </button>
                  <p style={{ color: "var(--muted)", margin: "12px 0 4px" }}>
                    …or add your own steps:
                  </p>
                  <PlanPanel
                    plan={plan}
                    onToggle={togglePlan}
                    onAdd={addMilestone}
                    onRemove={removeMilestone}
                    onEdit={editMilestone}
                  />
                </div>
              )}
              {showClassSurvey ? (
                <ClassSurvey
                  onCancel={() => setShowClassSurvey(false)}
                  onSubmit={(d) => {
                    setShowClassSurvey(false);
                    addClass(d);
                  }}
                />
              ) : (
                <div style={styles.addClassRow}>
                  <span style={styles.addClassLabel}>
                    Need help with another class?
                  </span>
                  <button
                    style={styles.addClassPlus}
                    disabled={busy}
                    onClick={() => setShowClassSurvey(true)}
                    aria-label="Add a class you need help with"
                    title="Add a class you need help with"
                  >
                    +
                  </button>
                </div>
              )}
            </>
          )}

          {planSection === "fyp" && (
            <FourYearPlanPanel
              plan={fourYearPlan}
              profile={profile}
              generating={generatingFyp}
              onGenerate={generateFourYearPlan}
              onSetDestination={setFypDestination}
              onAddCourse={addFypCourse}
              onRemoveCourse={removeFypCourse}
              onToggleCourse={toggleFypCourse}
              onSetCourse={setFypCourse}
              onAddMilestone={addFypMilestone}
              onRemoveMilestone={removeFypMilestone}
              onToggleMilestone={toggleFypMilestone}
              onToggleCheckpoint={toggleFypCheckpoint}
              onAddToPlan={addMilestone}
              onResources={milestoneResources}
              onAdvise={() => fourYearPlan && adviseNextSteps(fourYearPlan)}
              onSetRequirement={setFypRequirement}
              onAddRequirement={addFypRequirement}
              onRemoveRequirement={removeFypRequirement}
              onSetTotalRequired={setFypTotalRequired}
              onUseDefaultRequirements={useTypicalFypRequirements}
              onSetGpaGoal={setFypGpaGoal}
              onSetProjectedGrade={setFypProjectedGrade}
              onApplyGrades={applyFypGrades}
              planTitles={new Set(plan.map((m) => m.title))}
              reflections={reflections}
              onReflect={reflectOnYear}
              reflectionSummary={reflectionSummary}
              onSummarizeReflections={summarizeReflections}
              summarizingReflections={summarizingReflections}
              onCreateGoalsFromReflections={goalsFromReflections}
              creatingReflGoals={creatingReflGoals}
              onClear={clearFourYearPlan}
            />
          )}
        </div>
      )}

      {tab === "progress" && (
        <div style={styles.studyScroll}>
          <DailyRecap log={progress} assignments={assignments} events={events} />
          <WeeklyRecap
            log={progress}
            plan={plan}
            goals={goals}
            assignments={assignments}
            fourYearPlan={fourYearPlan}
          />
          <ProgressCard log={progress} study={studyLog} goals={goals} />
          {(() => {
            const fyCourses = fourYearPlan
              ? fourYearPlan.years.flatMap((y) => y.courses)
              : [];
            const areas = [
              {
                label: "🎯 Study plan",
                done: plan.filter((m) => m.done).length,
                total: plan.length,
              },
              {
                label: "🌟 Goals",
                done: goals.filter((g) => g.done).length,
                total: goals.length,
              },
              {
                label: "📌 Assignments",
                done: assignments.filter((a) => a.done).length,
                total: assignments.length,
              },
              {
                label: "🗺️ 4-Year courses",
                done: fyCourses.filter((c) => c.done).length,
                total: fyCourses.length,
              },
            ].filter((a) => a.total > 0);
            const done = areas.reduce((n, a) => n + a.done, 0);
            const totalItems = areas.reduce((n, a) => n + a.total, 0);
            const pct = totalItems ? Math.round((done / totalItems) * 100) : 0;
            return (
              <div style={styles.card}>
                <div style={styles.cardHead}>
                  <span style={styles.cardClass}>🎯 Plan progress</span>
                  <span style={styles.subjectsCount}>
                    {done}/{totalItems} done
                  </span>
                </div>
                {totalItems === 0 ? (
                  <p style={styles.assignEmpty}>
                    Nothing to track yet — add goals, assignments, or a study
                    plan and your progress shows up here.
                  </p>
                ) : (
                  <>
                    <div style={styles.planProgTrack}>
                      <div
                        style={{ ...styles.planProgFill, width: `${pct}%` }}
                      />
                    </div>
                    <div style={styles.planProgMeta}>
                      {pct}% complete
                      {pct === 100
                        ? " — 🎉 all done!"
                        : ` · ${totalItems - done} to go`}
                    </div>
                    <div style={{ marginTop: 14 }}>
                      {areas.map((a) => {
                        const p = Math.round((a.done / a.total) * 100);
                        return (
                          <div key={a.label} style={styles.areaRow}>
                            <span style={styles.areaLabel}>{a.label}</span>
                            <div style={styles.areaTrack}>
                              <div
                                style={{ ...styles.areaFill, width: `${p}%` }}
                              />
                            </div>
                            <span style={styles.areaCount}>
                              {a.done}/{a.total}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            );
          })()}
        </div>
      )}

      {tab === "school" && (
        <SchoolConnect
          profile={profile}
          onAddAssignment={addAssignment}
          onAddEvent={addEvent}
          onAddSubject={addSubject}
          onShareGrades={(grades) => {
            setTab("chat");
            send(
              "Here are my current grades from my school app:\n" +
                grades.map((g) => `- ${g.course}: ${g.grade}`).join("\n") +
                "\nKeep these in mind when you help me — start with where I'm " +
                "weakest, and celebrate what's going well.",
              { hidden: true },
            );
          }}
        />
      )}

      {tab === "study" && (
        <div style={styles.studyScroll}>
          <ProfileCard profile={profile} onEdit={() => setEditing(true)} />
          <SubjectsPanel
            subjects={subjects}
            onAdd={addSubject}
            onRemove={removeSubject}
          />
          <div style={styles.card}>
            <div style={styles.cardHead}>
              <span style={styles.cardClass}>🛠️ Study tools</span>
            </div>
            <div style={styles.studyToolsGrid}>
              {(
                [
                  ["🃏 Flashcards", "Make me flashcards to study."],
                  ["📝 Quiz me", "Quiz me on what I'm learning."],
                  ["📚 Study guide", "Make me a study guide for what I should review."],
                  ["🎬 Study videos", "Recommend me a few study videos for my class."],
                  ["📱 Short-form recs", "Recommend TikTok, YouTube Shorts, and Instagram accounts or searches for what I'm studying."],
                  ["💡 Suggestions", "Give me a couple of study suggestions."],
                ] as const
              ).map(([label, msg]) => (
                <button
                  key={label}
                  style={styles.studyToolBtn}
                  disabled={busy}
                  onClick={() => {
                    setTab("chat");
                    send(msg);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            <div style={{ marginTop: 12 }}>
              <Suggestions
                kind="tools"
                label="💡 Suggest study tools to make"
                body={{
                  career: fourYearPlan?.destination,
                  profile: profile ?? undefined,
                  events: events.length ? events : undefined,
                  missed: missed.length ? missed : undefined,
                  mistakes: mistakes.length ? mistakes : undefined,
                }}
                renderItem={(s, i, drop) => (
                  <div key={i} style={styles.sugItem}>
                    <div style={{ flex: 1 }}>
                      <div style={styles.sugText}>
                        {s.type === "quiz" ? "📝 Quiz" : "🃏 Flashcards"}:{" "}
                        {s.topic}
                      </div>
                      {s.why && <div style={styles.sugMeta}>{s.why}</div>}
                    </div>
                    <button
                      style={styles.fypAddPlan}
                      disabled={busy}
                      onClick={() => {
                        setTab("chat");
                        send(
                          s.type === "quiz"
                            ? `Make me a quiz on ${s.topic}.`
                            : `Make me flashcards on ${s.topic}.`,
                        );
                        drop();
                      }}
                    >
                      Make it
                    </button>
                  </div>
                )}
              />
            </div>
          </div>
          <SmartNotes profile={profile} />
          <PresentationPractice />
          <ProjectGrader profile={profile} />
          <AssignmentFeedback
            subjects={subjects}
            profile={profile}
            initialPrompt={feedbackSeed}
            onTrack={(m) => logMistake({ ...m, source: "feedback" })}
          />
        </div>
      )}

      {tab === "together" && (
        <StudyTogether
          name={
            session?.user?.name?.trim() ||
            profile?.name?.trim() ||
            session?.user?.email?.split("@")[0] ||
            "Guest"
          }
        />
      )}

      {tab === "folder" && (
        <SharedFolder
          name={
            session?.user?.name?.trim() ||
            profile?.name?.trim() ||
            session?.user?.email?.split("@")[0] ||
            "Guest"
          }
        />
      )}

      {tab === "chat" && (
        <>
      <PlanStrip
        plan={plan}
        onToggleNext={toggleNextStep}
        onOpen={() => setTab("study")}
      />
      <div ref={scrollRef} style={styles.scroll}>
        {messages.map((m, i) => (
          <div
            key={i}
            className="fade-in"
            style={{
              ...styles.row,
              flexDirection: "column",
              alignItems: m.role === "user" ? "flex-end" : "flex-start",
            }}
          >
            <div
              style={{
                ...styles.bubble,
                background:
                  m.role === "user"
                    ? "var(--user-bubble)"
                    : "var(--assistant-bubble)",
                color:
                  m.role === "user" ? "var(--user-text)" : "var(--assistant-text)",
                ...(m.role === "user"
                  ? { borderTopRightRadius: 6 }
                  : { borderTopLeftRadius: 6 }),
              }}
            >
              {m.content
                ? renderContent(
                    m.content,
                    m.role === "user" ? "#dff0e6" : "var(--accent)",
                  )
                : busy && !(i === messages.length - 1 && chatStatus)
                  ? "…"
                  : ""}
              {m.attachments && m.attachments.length > 0 && (
                <div
                  style={{
                    ...styles.attachStrip,
                    marginTop: m.content ? 8 : 0,
                    marginBottom: 0,
                  }}
                >
                  {m.attachments.map((a, ai) => (
                    <div key={ai} style={styles.msgAttach} title={a.name}>
                      {a.dataUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={a.dataUrl} alt={a.name} style={styles.msgAttachImg} />
                      ) : (
                        <span style={styles.msgAttachFile}>
                          {a.kind === "video" ? "🎬" : a.kind === "image" ? "🖼️" : "📄"}{" "}
                          {a.name}
                        </span>
                      )}
                      {a.kind === "video" && a.dataUrl && (
                        <span style={styles.msgAttachPlay} aria-hidden>
                          ▶
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {/* Live status while tools run — shown even under partial text,
                  since the model often writes a preamble before its tools. */}
              {busy && i === messages.length - 1 && chatStatus && (
                <div
                  style={{
                    fontStyle: "italic",
                    opacity: 0.75,
                    marginTop: m.content ? 6 : 0,
                  }}
                >
                  {chatStatus}
                </div>
              )}
            </div>
            {m.role === "assistant" && a11y.readAloud && m.content && (
              <SpeakButton text={m.content} />
            )}
            {m.videos && m.videos.length > 0 && <VideoCards videos={m.videos} />}
            {m.socials && m.socials.length > 0 && (
              <SocialCards socials={m.socials} />
            )}
            {m.examples && m.examples.length > 0 && (
              <ExampleCards examples={m.examples} />
            )}
            {m.flashcards && m.flashcards.length > 0 && (
              <FlashcardDeck
                cards={m.flashcards}
                onMissed={addMissed}
                onMistake={(c) =>
                  logMistake({
                    concept: c.front,
                    fix: c.back,
                    source: "quiz",
                  })
                }
              />
            )}
            {m.quiz && m.quiz.length > 0 && (
              <QuizView
                quiz={m.quiz}
                onMissed={addMissed}
                onMistake={(mk) => logMistake({ ...mk, source: "quiz" })}
                onStudyGuide={studyGuideFromQuiz}
              />
            )}
          </div>
        ))}
      </div>

      {messages.length > 0 && (
        <div
          style={styles.lessonAsk}
          role="group"
          aria-label="Ask a question about this lesson"
        >
          <span style={styles.lessonAskLabel}>Ask</span>
          {lessonPromptsFor(activeChat?.title ?? "", subjects, profile?.klass).map(
            (p) => (
              <button
                key={p.label}
                type="button"
                style={styles.quickChip}
                disabled={busy || !!pendingKickoff}
                onClick={() => void send(p.prompt)}
                title={p.prompt}
              >
                {p.label}
              </button>
            ),
          )}
        </div>
      )}

      {/* Prompted responses from the weak-topic algorithm: ready-to-send chips
          built from the learner's quiz/flashcard misses (freshest first). */}
      {missed.length > 0 && (
        <div
          style={styles.lessonAsk}
          role="group"
          aria-label="Practice a weak spot"
        >
          <span style={styles.lessonAskLabel}>🎯 Weak spots</span>
          {weakTopicPrompts(missed).map((p) => (
            <button
              key={p.label}
              type="button"
              style={styles.weakChip}
              disabled={busy || !!pendingKickoff}
              onClick={() => void send(p.prompt)}
              title={p.prompt}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}

      <div style={styles.composerActions}>
        <div
          style={styles.teachLevelGroup}
          role="group"
          aria-label="Teach-back difficulty"
        >
          <span style={styles.teachLevelLabel}>Level</span>
          {TEACH_LEVELS.map((lvl) => (
            <button
              key={lvl.id}
              type="button"
              onClick={() => setTeachLevel(lvl.id)}
              disabled={busy || !!pendingKickoff}
              title={lvl.hint}
              aria-pressed={teachLevel === lvl.id}
              style={{
                ...styles.teachLevelBtn,
                ...(teachLevel === lvl.id ? styles.teachLevelBtnActive : null),
              }}
            >
              {lvl.emoji} {lvl.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          style={styles.quickChip}
          disabled={busy || !!pendingKickoff}
          onClick={teachBackInChat}
          title={
            input.trim()
              ? `Teach back “${input.trim()}”`
              : "Teach a concept back to check your understanding"
          }
        >
          🧑‍🏫 Teach it back
        </button>
        <button
          type="button"
          style={styles.quickChip}
          disabled={busy || !!pendingKickoff}
          onClick={recordTeachBack}
          title={
            input.trim()
              ? `Record yourself teaching “${input.trim()}”`
              : "Record yourself teaching a concept back to camera"
          }
        >
          🎥 Record it
        </button>
        <button
          type="button"
          style={styles.quickChip}
          disabled={busy || !!pendingKickoff}
          onClick={studyTipInChat}
          title={
            input.trim()
              ? `Get a study tip for “${input.trim()}”`
              : "Get a quick, practical study tip you can use right now"
          }
        >
          💡 Study tip
        </button>
      </div>

      {(attachments.length > 0 || attaching) && (
        <div style={styles.attachStrip} aria-label="Attachments to send">
          {attachments.map((a, i) => (
            <div key={i} style={styles.attachChip} title={a.name}>
              {a.dataUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={a.dataUrl} alt="" style={styles.attachThumb} />
              ) : (
                <span style={styles.attachIcon} aria-hidden>
                  {a.kind === "video" ? "🎬" : a.kind === "image" ? "🖼️" : "📄"}
                </span>
              )}
              <span style={styles.attachName}>{a.name}</span>
              {a.kind === "video" && (
                <span style={styles.attachBadge} aria-hidden>▶</span>
              )}
              <button
                type="button"
                onClick={() => removeAttachment(i)}
                style={styles.attachRemove}
                aria-label={`Remove ${a.name}`}
              >
                ✕
              </button>
            </div>
          ))}
          {attaching && <span style={styles.attachName}>Preparing…</span>}
        </div>
      )}

      <div style={styles.composer}>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*,video/*,.pdf,.txt,.md,.csv,.tsv,.json,.rtf,.html,.htm,.xml,.doc,.docx,.ppt,.pptx,.xls,.xlsx"
          style={{ display: "none" }}
          onChange={(e) => {
            void addFiles(e.target.files);
            e.target.value = ""; // let the same file be picked again later
          }}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={busy || attaching || attachments.length >= MAX_ATTACHMENTS}
          style={styles.micBtn}
          aria-label="Attach a photo, file, or video"
          title={
            attachments.length >= MAX_ATTACHMENTS
              ? `You can attach up to ${MAX_ATTACHMENTS} items`
              : "Attach a photo, file, or video"
          }
        >
          📎
        </button>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData?.files ?? []);
            if (files.length) {
              e.preventDefault();
              void addFiles(files);
            }
          }}
          placeholder="Message Eliora…"
          rows={2}
          className="eliora-input"
          style={styles.input}
          aria-label="Message Eliora"
          spellCheck
          autoCapitalize="sentences"
        />
        {speechSupported && (
          <button
            type="button"
            onClick={() => {
              recognitionRef.current?.stop();
              stopSpeaking();
              setVoiceMode(true);
            }}
            disabled={busy}
            style={styles.micBtn}
            aria-label="Start a voice conversation with Eliora"
            title="Voice mode — talk out loud and Eliora answers out loud"
          >
            📞
          </button>
        )}
        {speechSupported && (
          <button
            onClick={toggleDictation}
            disabled={busy}
            style={{
              ...styles.micBtn,
              ...(listening ? styles.micBtnActive : {}),
            }}
            aria-label={listening ? "Stop dictation" : "Dictate your message"}
            title={listening ? "Stop dictation" : "Speak your message"}
          >
            {listening ? "⏹" : "🗣️"}
          </button>
        )}
        <button
          onClick={() => (busy ? stopReply() : send())}
          style={styles.sendBtn}
          aria-label={busy ? "Stop the reply" : "Send your message"}
        >
          {busy ? "⏹ Stop" : "Send"}
        </button>
      </div>
      {voiceMode && (
        <VoiceChat
          onSend={(text) => send(text)}
          onClose={() => setVoiceMode(false)}
        />
      )}
        </>
      )}
      </main>
      {/* Persistent focus-music player — keeps playing across every tab. */}
      <FocusMusicPlayer storageKey={MUSIC_KEY} />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    maxWidth: 720,
    margin: "0 auto",
    height: "100vh",
    display: "flex",
    flexDirection: "column",
    padding: "0 16px",
  },
  shell: { display: "flex", height: "100vh", width: "100%" },
  sideToggle: {
    position: "fixed",
    top: 10,
    left: 10,
    zIndex: 30,
    width: 40,
    height: 40,
    borderRadius: 10,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    background: "var(--surface)",
    fontSize: 20,
    cursor: "pointer",
  },
  sidebar: {
    width: 280,
    flexShrink: 0,
    height: "100vh",
    borderRightWidth: 1,
    borderRightStyle: "solid",
    borderRightColor: "var(--border)",
    background: "var(--surface)",
    display: "flex",
    flexDirection: "column",
    padding: "56px 12px 14px",
    gap: 6,
    boxSizing: "border-box",
  },
  sideBackdrop: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.32)",
    zIndex: 20,
  },
  sideBrand: {
    fontSize: 22,
    fontWeight: 700,
    color: "var(--accent)",
    padding: "2px 6px 6px",
  },
  sideNewChat: {
    textAlign: "left",
    padding: "10px 12px",
    borderRadius: 10,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    background: "var(--bg)",
    fontSize: 14,
    fontWeight: 600,
    color: "var(--assistant-text)",
    cursor: "pointer",
  },
  sideNav: { display: "flex", flexDirection: "column", gap: 2, marginTop: 6 },
  sideNavItem: {
    textAlign: "left",
    padding: "9px 12px",
    borderRadius: 8,
    border: "none",
    background: "transparent",
    fontSize: 14,
    color: "var(--assistant-text)",
    cursor: "pointer",
  },
  sideNavItemActive: { background: "var(--assistant-bubble)", fontWeight: 700 },
  sideChatsLabel: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    fontSize: 11,
    fontWeight: 700,
    color: "var(--muted)",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    padding: "12px 8px 4px",
  },
  sideFolderAdd: {
    border: "none",
    background: "transparent",
    color: "var(--muted)",
    fontSize: 13,
    cursor: "pointer",
    padding: 2,
  },
  folderHeader: {
    display: "flex",
    alignItems: "center",
    borderRadius: 8,
  },
  folderHeaderBtn: {
    flex: 1,
    display: "flex",
    alignItems: "center",
    gap: 6,
    textAlign: "left",
    padding: "7px 8px",
    border: "none",
    background: "transparent",
    fontSize: 13.5,
    fontWeight: 600,
    color: "var(--assistant-text)",
    cursor: "pointer",
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
  },
  folderCount: { color: "var(--muted)", fontWeight: 400, fontSize: 12 },
  folderMenu: {
    position: "absolute",
    top: "100%",
    right: 6,
    zIndex: 5,
    minWidth: 150,
    display: "flex",
    flexDirection: "column",
    background: "var(--surface)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    borderRadius: 10,
    boxShadow: "0 6px 18px rgba(0,0,0,0.16)",
    padding: 4,
  },
  folderMenuItem: {
    textAlign: "left",
    padding: "8px 10px",
    border: "none",
    background: "transparent",
    borderRadius: 6,
    fontSize: 13,
    color: "var(--assistant-text)",
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  sideChats: {
    flex: 1,
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: 2,
  },
  sideChat: { display: "flex", alignItems: "center", borderRadius: 8 },
  sideChatActive: { background: "var(--assistant-bubble)" },
  sideChatBtn: {
    flex: 1,
    textAlign: "left",
    padding: "8px 10px",
    border: "none",
    background: "transparent",
    fontSize: 13.5,
    color: "var(--assistant-text)",
    cursor: "pointer",
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
  },
  sideChatDel: {
    flexShrink: 0,
    width: 26,
    height: 28,
    border: "none",
    background: "transparent",
    color: "var(--muted)",
    fontSize: 15,
    cursor: "pointer",
  },
  sideChatEdit: {
    flex: 1,
    minWidth: 0,
    margin: "2px 4px",
    padding: "6px 8px",
    borderRadius: 6,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--accent)",
    background: "var(--surface)",
    color: "var(--assistant-text)",
    fontSize: 13.5,
  },
  sideFooter: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: "var(--border)",
    paddingTop: 8,
  },
  sideFootBtn: {
    width: 36,
    height: 36,
    borderRadius: 8,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    background: "var(--bg)",
    fontSize: 18,
    cursor: "pointer",
  },
  sideFootUser: {
    flex: 1,
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "8px 10px",
    borderRadius: 8,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    background: "var(--bg)",
    fontSize: 13,
    color: "var(--assistant-text)",
    cursor: "pointer",
  },
  mainCol: {
    flex: 1,
    minWidth: 0,
    height: "100vh",
    display: "flex",
    flexDirection: "column",
    padding: "58px clamp(20px, 4vw, 48px) 24px",
    boxSizing: "border-box",
    maxWidth: 960,
    margin: "0 auto",
    width: "100%",
  },
  homeHero: { padding: "4px 2px 8px" },
  heroRoomBanner: {
    position: "relative",
    height: 84,
    minHeight: 84,
    flexShrink: 0,
    borderRadius: 16,
    marginBottom: 12,
    overflow: "hidden",
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "0 18px",
    boxShadow: "var(--shadow-e1)",
  },
  heroRoomEmoji: { fontSize: 40 },
  heroRoomName: {
    fontSize: 14,
    fontWeight: 800,
    color: "rgba(255,255,255,0.95)",
    textShadow: "0 1px 3px rgba(0,0,0,0.35)",
    textTransform: "capitalize",
  },
  roomGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(4, 1fr)",
    gap: 8,
    marginTop: 8,
  },
  rewardWrap: { borderTop: "1px solid var(--border)" },
  rewardItem: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "9px 0",
  },
  rewardComposeBox: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    padding: "0 0 12px 36px",
  },
  rewardComposeInput: {
    width: "100%",
    minHeight: 60,
    resize: "vertical",
    padding: "9px 11px",
    borderRadius: 10,
    border: "1px solid var(--border)",
    background: "var(--surface)",
    color: "var(--assistant-text)",
    fontSize: 13.5,
    fontFamily: "inherit",
    lineHeight: 1.45,
    boxSizing: "border-box",
  },
  rewardClaimBtn: {
    alignSelf: "flex-start",
    padding: "7px 14px",
    borderRadius: 9,
    border: "none",
    background: "var(--accent)",
    color: "#fff",
    fontSize: 13,
    fontWeight: 700,
    cursor: "pointer",
  },
  rewardLog: {
    display: "flex",
    flexDirection: "column",
    gap: 3,
    padding: "0 0 10px 36px",
  },
  rewardLogItem: {
    fontSize: 12.5,
    color: "var(--muted)",
    lineHeight: 1.4,
  },
  rewardLogDot: { color: "var(--accent)", fontWeight: 700 },
  rewardEmoji: { fontSize: 22, flexShrink: 0, width: 26, textAlign: "center" },
  rewardTitle: {
    fontSize: 14,
    fontWeight: 600,
    color: "var(--assistant-text)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  rewardRedeemed: { fontSize: 12, fontWeight: 600, color: "var(--accent)" },
  rewardTrack: {
    marginTop: 5,
    height: 6,
    borderRadius: 6,
    background: "var(--assistant-bubble)",
    overflow: "hidden",
  },
  rewardFill: {
    height: "100%",
    background: "var(--accent)",
    transition: "width 200ms ease",
  },
  rewardCost: {
    flexShrink: 0,
    fontSize: 12.5,
    fontWeight: 700,
    color: "var(--muted)",
    minWidth: 46,
    textAlign: "right",
  },
  rewardRedeemBtn: {
    flexShrink: 0,
    padding: "6px 12px",
    borderRadius: 9,
    border: "none",
    background: "var(--accent)",
    color: "#fff",
    fontSize: 13,
    fontWeight: 700,
    cursor: "pointer",
  },
  rewardRedeemOff: {
    background: "var(--assistant-bubble)",
    color: "var(--muted)",
    cursor: "not-allowed",
  },
  rewardAddBox: {
    marginTop: 12,
    paddingTop: 12,
    borderTop: "1px solid var(--border)",
  },
  rewardEmojiRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: 4,
    marginBottom: 8,
  },
  rewardEmojiPick: {
    width: 32,
    height: 32,
    borderRadius: 8,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    background: "var(--surface)",
    fontSize: 17,
    cursor: "pointer",
    lineHeight: 1,
  },
  rewardEmojiPickOn: {
    borderColor: "var(--accent)",
    background: "var(--accent-soft)",
  },
  rewardAddRow: { display: "flex", gap: 8 },
  rewardCostInput: {
    width: 66,
    flexShrink: 0,
    padding: "9px 10px",
    borderRadius: 10,
    border: "1px solid var(--border)",
    background: "var(--surface)",
    color: "var(--assistant-text)",
    fontSize: 14,
  },
  rewardAddBtn: {
    flexShrink: 0,
    padding: "9px 14px",
    borderRadius: 10,
    border: "none",
    background: "var(--accent-soft)",
    color: "var(--accent)",
    fontSize: 14,
    fontWeight: 700,
    cursor: "pointer",
  },
  roomChip: {
    position: "relative",
    height: 74,
    borderRadius: 12,
    border: "none",
    cursor: "pointer",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
    padding: 4,
    overflow: "hidden",
  },
  roomChipEq: {
    outlineWidth: 3,
    boxShadow: "0 0 0 3px var(--accent)",
  },
  roomEmoji: { fontSize: 22 },
  roomName: {
    fontSize: 11,
    fontWeight: 700,
    color: "#fff",
    textShadow: "0 1px 2px rgba(0,0,0,0.4)",
  },
  roomStatus: {
    fontSize: 9.5,
    fontWeight: 700,
    color: "rgba(255,255,255,0.95)",
    textShadow: "0 1px 2px rgba(0,0,0,0.45)",
    background: "rgba(0,0,0,0.25)",
    padding: "1px 5px",
    borderRadius: 999,
  },
  progCard: {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-lg)",
    padding: "16px 18px",
    marginBottom: 16,
    boxShadow: "var(--shadow-e1)",
  },
  progTop: {
    display: "flex",
    gap: 12,
    justifyContent: "space-around",
    marginBottom: 12,
  },
  progStat: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 1,
  },
  progBig: { fontSize: 26, fontWeight: 800, color: "var(--accent)" },
  progLbl: { fontSize: 12, color: "var(--muted)", fontWeight: 600 },
  badgeSection: { marginBottom: 12 },
  badgeSectionHead: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  badgeSectionTitle: { fontSize: 13.5, fontWeight: 700, color: "var(--text)" },
  badgeSectionCount: { fontSize: 12, color: "var(--muted)" },
  badgeGrid: {
    display: "flex",
    flexWrap: "wrap",
    gap: 10,
    justifyContent: "center",
  },
  badgeItem: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 4,
    width: 66,
    background: "transparent",
    border: "none",
    padding: 2,
    cursor: "pointer",
  },
  badgeMedal: {
    position: "relative",
    width: 48,
    height: 48,
    borderRadius: 999,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 24,
    color: "#fff",
    border: "2px solid rgba(255,255,255,0.55)",
    boxShadow: "0 2px 6px rgba(0,0,0,0.18)",
  },
  badgeMedalLocked: {
    filter: "grayscale(0.85)",
    opacity: 0.4,
    boxShadow: "none",
  },
  badgeLockPip: {
    position: "absolute",
    right: -3,
    bottom: -3,
    fontSize: 12,
    lineHeight: 1,
    background: "var(--bg)",
    borderRadius: 999,
    padding: 1,
  },
  badgeItemLabel: {
    fontSize: 10.5,
    fontWeight: 600,
    lineHeight: 1.2,
    textAlign: "center",
    color: "var(--text)",
  },
  badgeModal: {
    position: "relative",
    background: "var(--bg)",
    borderRadius: 20,
    padding: "30px 24px 24px",
    width: "100%",
    maxWidth: 360,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 10,
    textAlign: "center",
    boxShadow: "var(--shadow-e1)",
  },
  badgeModalClose: {
    position: "absolute",
    top: 10,
    right: 14,
    background: "transparent",
    border: "none",
    fontSize: 26,
    lineHeight: 1,
    color: "var(--muted)",
    cursor: "pointer",
  },
  badgeModalMedal: {
    width: 104,
    height: 104,
    borderRadius: 999,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 52,
    color: "#fff",
    border: "3px solid rgba(255,255,255,0.6)",
    boxShadow: "0 8px 24px rgba(0,0,0,0.25)",
  },
  badgeModalTitle: {
    fontSize: 22,
    fontWeight: 800,
    color: "var(--text)",
    margin: 0,
  },
  badgeModalStatus: {
    fontSize: 12.5,
    fontWeight: 700,
    padding: "3px 12px",
    borderRadius: 999,
  },
  badgeModalBlurb: {
    fontSize: 14.5,
    lineHeight: 1.5,
    color: "var(--assistant-text)",
    margin: 0,
    maxWidth: 300,
  },
  badgeModalHint: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
    width: "100%",
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 12,
    padding: "10px 14px",
    fontSize: 13.5,
    color: "var(--text)",
    textAlign: "left",
  },
  badgeModalHintLabel: {
    fontSize: 11,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    color: "var(--muted)",
  },
  badgeModalReward: {
    fontSize: 13.5,
    fontWeight: 700,
    color: "var(--accent)",
  },
  badgeCelebrateKicker: {
    fontSize: 15,
    fontWeight: 800,
    color: "var(--accent)",
    letterSpacing: 0.3,
  },
  xpToast: {
    position: "sticky",
    top: 8,
    zIndex: 20,
    alignSelf: "center",
    margin: "0 auto 12px",
    width: "fit-content",
    padding: "8px 16px",
    borderRadius: 999,
    background: "var(--accent)",
    color: "#fff",
    fontSize: 14,
    fontWeight: 800,
    boxShadow: "var(--shadow-e1)",
  },
  progWeek: {
    display: "flex",
    justifyContent: "space-between",
    gap: 4,
    marginBottom: 12,
  },
  progDay: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 4,
    flex: 1,
  },
  progDayLbl: { fontSize: 11, color: "var(--muted)", fontWeight: 700 },
  progDot: {
    width: 30,
    height: 30,
    borderRadius: 999,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 15,
    background: "var(--assistant-bubble)",
    borderWidth: 2,
    borderStyle: "solid",
    borderColor: "transparent",
  },
  progDotActive: { background: "#fde7c9" },
  progDotToday: { borderColor: "var(--accent)" },
  progGoalRow: { display: "flex", alignItems: "center", gap: 10 },
  progTrack: {
    flex: 1,
    height: 10,
    borderRadius: 6,
    background: "var(--assistant-bubble)",
    overflow: "hidden",
  },
  progFill: {
    height: "100%",
    background: "var(--accent)",
    transition: "width 300ms ease",
  },
  progGoalLbl: {
    flexShrink: 0,
    fontSize: 12.5,
    fontWeight: 700,
    color: "var(--muted)",
  },
  progBarsHead: {
    fontSize: 12,
    fontWeight: 700,
    color: "var(--muted)",
    marginTop: 14,
    marginBottom: 6,
  },
  progBars: {
    display: "flex",
    alignItems: "flex-end",
    gap: 4,
    height: 48,
  },
  progBarCol: { flex: 1, height: "100%", display: "flex", alignItems: "flex-end" },
  progBarTrack: {
    width: "100%",
    height: "100%",
    display: "flex",
    alignItems: "flex-end",
    borderRadius: 4,
    background: "var(--assistant-bubble)",
    overflow: "hidden",
  },
  progBarFill: {
    width: "100%",
    background: "var(--accent)",
    borderRadius: 4,
    transition: "height 300ms ease",
  },
  progBarToday: {
    background:
      "repeating-linear-gradient(45deg,var(--accent),var(--accent) 4px,var(--accent-hover) 4px,var(--accent-hover) 8px)",
  },
  studyEmpty: {
    fontSize: 12.5,
    color: "var(--muted)",
    background: "var(--assistant-bubble)",
    borderRadius: 10,
    padding: "12px 14px",
    textAlign: "center" as const,
  },
  studyWeeks: {
    display: "flex",
    alignItems: "flex-end",
    justifyContent: "space-between",
    gap: 6,
    height: 96,
  },
  studyWeekCol: {
    flex: 1,
    height: "100%",
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 3,
  },
  studyWeekVal: {
    fontSize: 10.5,
    fontWeight: 700,
    color: "var(--accent)",
    minHeight: 13,
  },
  studyWeekTrack: {
    width: "100%",
    flex: 1,
    display: "flex",
    alignItems: "flex-end",
    borderRadius: 5,
    background: "var(--assistant-bubble)",
    overflow: "hidden",
  },
  studyWeekFill: {
    width: "100%",
    background: "var(--accent-soft)",
    borderRadius: 5,
    transition: "height 300ms ease",
  },
  studyWeekFillNow: {
    background: "var(--accent)",
  },
  studyWeekLbl: {
    fontSize: 10,
    fontWeight: 600,
    color: "var(--muted)",
    whiteSpace: "nowrap" as const,
  },
  studyWeekLblNow: {
    color: "var(--accent)",
    fontWeight: 800,
  },
  progGraph: {
    width: "100%",
    height: 70,
    display: "block",
    borderRadius: 8,
  },
  growthGain: {
    marginLeft: 8,
    fontSize: 11.5,
    fontWeight: 700,
    color: "var(--accent)",
    background: "var(--accent-soft)",
    borderRadius: 999,
    padding: "2px 8px",
  },
  growthWrap: { display: "flex", alignItems: "stretch", gap: 6 },
  growthYAxis: {
    display: "flex",
    flexDirection: "column",
    justifyContent: "space-between",
    height: 70,
    fontSize: 10,
    fontWeight: 600,
    color: "var(--muted)",
    textAlign: "right",
    minWidth: 26,
  },
  growthPlot: { position: "relative", flex: 1, height: 70 },
  growthDot: {
    position: "absolute",
    right: -4,
    width: 9,
    height: 9,
    borderRadius: "50%",
    background: "var(--accent)",
    border: "2px solid var(--surface)",
    transform: "translateY(-50%)",
    boxShadow: "0 0 0 1px var(--accent)",
  },
  growthEmpty: {
    position: "absolute",
    top: "50%",
    left: "50%",
    transform: "translate(-50%,-50%)",
    fontSize: 12,
    color: "var(--muted)",
    whiteSpace: "nowrap",
  },
  growthXAxis: {
    display: "flex",
    justifyContent: "space-between",
    fontSize: 10,
    fontWeight: 600,
    color: "var(--muted)",
    marginTop: 3,
    marginLeft: 32,
  },
  stepsBtnRow: {
    display: "flex",
    gap: 8,
    marginBottom: 8,
    flexWrap: "wrap",
  },
  quickPlanCard: {
    background: "var(--accent-soft)",
    border: "1px solid var(--border)",
    borderRadius: 14,
    padding: "12px 14px",
    marginBottom: 12,
  },
  quickPlanLabel: {
    display: "block",
    fontSize: 13,
    fontWeight: 700,
    color: "var(--accent)",
    marginBottom: 8,
  },
  quickPlanChips: {
    display: "flex",
    gap: 8,
    flexWrap: "wrap",
  },
  quickPlanChip: {
    padding: "7px 14px",
    borderRadius: 999,
    border: "1px solid var(--accent)",
    background: "var(--bg)",
    color: "var(--accent)",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  },
  careerHelpBox: {
    marginTop: 16,
    padding: "14px 16px",
    borderRadius: 14,
    background: "var(--accent-soft)",
    border: "1px dashed var(--border)",
  },
  careerHelpTitle: {
    display: "block",
    fontSize: 15,
    fontWeight: 700,
    color: "var(--text)",
    marginBottom: 4,
  },
  careerHelpText: {
    color: "var(--muted)",
    fontSize: 13,
    margin: "0 0 10px",
  },
  careerHelpBtn: {
    padding: "9px 16px",
    borderRadius: 10,
    border: "none",
    background: "var(--accent)",
    color: "#fff",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
  },
  mcHint: {
    color: "var(--muted)",
    fontSize: 13,
    margin: "0 0 10px",
  },
  mcGroup: {
    marginBottom: 12,
  },
  mcLabel: {
    display: "block",
    fontSize: 14,
    fontWeight: 600,
    color: "var(--text)",
    marginBottom: 6,
  },
  mcChips: {
    display: "flex",
    flexWrap: "wrap",
    gap: 7,
  },
  mcChip: {
    padding: "6px 12px",
    borderRadius: 999,
    border: "1px solid var(--border)",
    background: "var(--bg)",
    color: "var(--text)",
    fontSize: 13,
    fontWeight: 500,
    cursor: "pointer",
  },
  mcChipOn: {
    background: "var(--accent)",
    border: "1px solid var(--accent)",
    color: "#fff",
    fontWeight: 600,
  },
  careerIdeaList: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    marginTop: 12,
  },
  postSurveyBox: {
    marginTop: 16,
    paddingTop: 14,
    borderTop: "1px dashed var(--border)",
  },
  postSurveyTitle: {
    display: "block",
    fontSize: 14,
    fontWeight: 700,
    color: "var(--text)",
    marginBottom: 10,
  },
  careerIdeaHint: {
    fontSize: 12,
    fontWeight: 600,
    color: "var(--muted)",
  },
  careerIdeaCard: {
    display: "flex",
    flexDirection: "column",
    gap: 3,
    textAlign: "left",
    padding: "10px 12px",
    borderRadius: 12,
    border: "1px solid var(--border)",
    background: "var(--bg)",
    cursor: "pointer",
  },
  careerIdeaTitle: {
    fontSize: 14,
    fontWeight: 700,
    color: "var(--accent)",
  },
  careerIdeaWhy: {
    fontSize: 13,
    color: "var(--text)",
    lineHeight: 1.4,
  },
  careerIdeaPath: {
    fontSize: 12,
    color: "var(--muted)",
  },
  planProgTrack: {
    height: 14,
    borderRadius: 8,
    background: "var(--assistant-bubble)",
    overflow: "hidden",
    marginTop: 6,
  },
  planProgFill: {
    height: "100%",
    borderRadius: 8,
    background: "var(--accent)",
    transition: "width 300ms ease",
  },
  planProgMeta: {
    fontSize: 12.5,
    fontWeight: 700,
    color: "var(--muted)",
    marginTop: 6,
  },
  recapHeadline: {
    fontSize: 14,
    fontWeight: 600,
    color: "var(--assistant-text)",
    margin: "2px 0 10px",
    lineHeight: 1.4,
  },
  recapList: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    marginTop: 12,
  },
  recapItem: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 13,
    color: "var(--assistant-text)",
  },
  recapTag: {
    flexShrink: 0,
    fontSize: 11.5,
    fontWeight: 700,
    color: "var(--muted)",
    background: "var(--assistant-bubble)",
    borderRadius: 6,
    padding: "2px 8px",
  },
  recapTagWarn: {
    color: "#fff",
    background: "var(--danger, #e05252)",
  },
  recapStatRow: {
    display: "flex",
    gap: 8,
    marginTop: 4,
    marginBottom: 4,
  },
  recapStat: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 2,
    padding: "10px 4px",
    background: "var(--assistant-bubble)",
    borderRadius: 10,
  },
  recapStatBig: {
    fontSize: 20,
    fontWeight: 800,
    color: "var(--accent)",
  },
  recapStatLbl: {
    fontSize: 11,
    fontWeight: 600,
    color: "var(--muted)",
    textAlign: "center",
  },
  areaRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    marginBottom: 8,
  },
  areaLabel: {
    flexShrink: 0,
    width: 130,
    fontSize: 13,
    color: "var(--assistant-text)",
  },
  areaTrack: {
    flex: 1,
    height: 9,
    borderRadius: 6,
    background: "var(--assistant-bubble)",
    overflow: "hidden",
  },
  areaFill: {
    height: "100%",
    borderRadius: 6,
    background: "var(--accent)",
    transition: "width 300ms ease",
  },
  areaCount: {
    flexShrink: 0,
    minWidth: 40,
    textAlign: "right",
    fontSize: 12,
    fontWeight: 600,
    color: "var(--muted)",
  },
  homeHi: {
    margin: 0,
    fontSize: "var(--text-h1)",
    fontWeight: 800,
    letterSpacing: "-0.015em",
    color: "var(--accent)",
  },
  homeSub: {
    margin: "8px 0 0",
    color: "var(--muted)",
    fontSize: "var(--text-body-lg)",
  },
  homeActions: {
    display: "grid",
    gap: 16,
    margin: "8px 0 24px",
  },
  homeAction: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: 10,
    padding: 22,
    borderRadius: "var(--radius-lg)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    background: "var(--surface)",
    boxShadow: "var(--shadow-e1)",
    color: "var(--text)",
    cursor: "pointer",
    textAlign: "left",
    transition: "transform 0.15s ease, box-shadow 0.15s ease, border-color 0.15s ease",
  },
  homeActionIcon: {
    width: 44,
    height: 44,
    borderRadius: "var(--radius-md)",
    background: "var(--accent-soft)",
    display: "grid",
    placeItems: "center",
    fontSize: 22,
    flexShrink: 0,
  },
  homeActionTitle: {
    fontSize: "var(--text-h3)",
    fontWeight: 700,
    color: "var(--text)",
  },
  homeActionDesc: {
    fontSize: "0.875rem",
    color: "var(--muted)",
    lineHeight: 1.4,
  },
  // AI tutors shelf — a wrapping grid of small persona cards.
  tutorGrid: {
    display: "grid",
    // 132px keeps two tutors per row on a phone instead of one tall stack.
    gridTemplateColumns: "repeat(auto-fill, minmax(132px, 1fr))",
    gap: 10,
  },
  tutorCard: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: 4,
    padding: "12px 14px",
    borderRadius: "var(--radius-md)",
    borderWidth: 2,
    borderStyle: "solid",
    borderColor: "var(--border)",
    background: "var(--surface)",
    color: "var(--text)",
    cursor: "pointer",
    textAlign: "left",
    transition: "transform 0.15s ease, border-color 0.15s ease",
  },
  tutorCardActive: {
    borderColor: "var(--accent)",
    background: "var(--accent-soft)",
  },
  tutorAvatar: {
    width: 36,
    height: 36,
    borderRadius: "var(--radius-md)",
    background: "var(--accent-soft)",
    display: "grid",
    placeItems: "center",
    fontSize: 20,
    marginBottom: 2,
  },
  tutorName: { fontSize: 15, fontWeight: 800, color: "var(--text)" },
  tutorSubject: { fontSize: 12, fontWeight: 700, color: "var(--accent)" },
  tutorTagline: { fontSize: 12, color: "var(--muted)", lineHeight: 1.35 },
  tutorActions: {
    display: "flex",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 14,
  },
  tutorStartBtn: {
    background: "var(--accent)",
    color: "#fff",
    border: "none",
    borderRadius: 12,
    padding: "10px 16px",
    fontSize: 15,
    fontWeight: 700,
    cursor: "pointer",
  },
  tutorVoiceBtn: {
    background: "var(--surface)",
    color: "var(--text)",
    border: "1px solid var(--border)",
    borderRadius: 12,
    padding: "10px 14px",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
  },
  // "Teach from my textbook" — the uploaded-material shelf inside the card.
  tutorMaterial: {
    marginTop: 16,
    paddingTop: 14,
    borderTop: "1px solid var(--border)",
  },
  tutorMaterialHead: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  tutorMaterialTitle: { fontSize: 15, fontWeight: 800, color: "var(--text)" },
  materialRow: { marginBottom: 8, position: "relative" },
  materialRowMain: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    width: "100%",
    padding: "10px 34px 10px 12px",
    borderRadius: "var(--radius-md)",
    border: "1px solid var(--border)",
    background: "var(--surface)",
    color: "var(--text)",
    cursor: "pointer",
    fontSize: 14,
  },
  materialTitle: {
    display: "block",
    fontWeight: 700,
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
  },
  materialMeta: {
    display: "block",
    color: "var(--muted)",
    fontSize: 12,
    marginTop: 2,
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
  },
  materialRemove: {
    position: "absolute",
    top: 8,
    right: 8,
    border: "none",
    background: "transparent",
    color: "var(--muted)",
    fontSize: 18,
    lineHeight: 1,
    cursor: "pointer",
    padding: 4,
  },
  materialDetail: {
    padding: "8px 12px 4px",
    fontSize: 13,
    color: "var(--muted)",
  },
  materialTopicList: { margin: 0, paddingLeft: 20, lineHeight: 1.6 },
  materialReading: {
    padding: "10px 12px",
    borderRadius: "var(--radius-md)",
    background: "var(--accent-soft)",
    color: "var(--text)",
    fontSize: 13,
    marginBottom: 8,
  },
  materialError: {
    padding: "10px 12px",
    borderRadius: "var(--radius-md)",
    border: "1px solid var(--border)",
    color: "var(--muted)",
    fontSize: 13,
    marginBottom: 8,
  },
  materialTextarea: {
    width: "100%",
    minHeight: 120,
    padding: 12,
    borderRadius: "var(--radius-md)",
    border: "1px solid var(--border)",
    background: "var(--surface)",
    color: "var(--text)",
    fontFamily: "inherit",
    fontSize: 14,
    resize: "vertical",
  },
  formPage: {
    maxWidth: 560,
    margin: "0 auto",
    minHeight: "100vh",
    display: "flex",
    flexDirection: "column",
    gap: 14,
    padding: "32px 16px 48px",
  },
  formIntro: { margin: 0, color: "var(--muted)", fontSize: 16 },
  loginPage: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  loginCard: {
    maxWidth: 380,
    width: "100%",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    textAlign: "center",
    gap: 16,
    padding: "36px 28px",
    borderRadius: 18,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    background: "var(--surface)",
  },
  loginIntro: { margin: 0, color: "var(--muted)", fontSize: 15, lineHeight: 1.5 },
  loginInput: {
    width: "100%",
    boxSizing: "border-box",
    fontSize: 15,
    padding: "12px 14px",
    borderRadius: 12,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    background: "var(--surface)",
  },
  loginError: {
    margin: 0,
    width: "100%",
    color: "#b3261e",
    fontSize: 13.5,
    textAlign: "left",
  },
  loginSubmit: {
    width: "100%",
    padding: "12px 16px",
    borderRadius: 12,
    border: "none",
    background: "var(--accent)",
    color: "#fff",
    fontSize: 15,
    fontWeight: 600,
    cursor: "pointer",
  },
  loginToggle: { margin: 0, fontSize: 13.5, color: "var(--muted)" },
  loginToggleLink: {
    color: "var(--accent)",
    fontWeight: 600,
    cursor: "pointer",
    textDecoration: "underline",
  },
  loginDivider: {
    width: "100%",
    borderTop: "1px solid var(--border)",
    textAlign: "center",
    lineHeight: "0.1em",
    margin: "4px 0",
  },
  loginDividerText: {
    background: "var(--surface)",
    color: "var(--muted)",
    fontSize: 12.5,
    padding: "0 10px",
  },
  googleBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    width: "100%",
    padding: "12px 16px",
    borderRadius: 12,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    background: "#fff",
    color: "#1c2421",
    fontSize: 15,
    fontWeight: 600,
    cursor: "pointer",
  },
  googleG: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 22,
    height: 22,
    borderRadius: 11,
    background: "#4285F4",
    color: "#fff",
    fontWeight: 700,
    fontSize: 14,
  },
  avatar: { width: 18, height: 18, borderRadius: 9, marginRight: 2 },
  label: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    fontSize: 16,
    fontWeight: 600,
    color: "var(--assistant-text)",
  },
  formInput: {
    fontSize: 17,
    padding: "12px 14px",
    borderRadius: 12,
    border: "1px solid var(--border)",
    background: "var(--surface)",
    fontFamily: "inherit",
    fontWeight: 400,
  },
  choiceList: { display: "flex", flexDirection: "column", gap: 8 },
  choiceBtn: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    textAlign: "left",
    fontSize: 16,
    fontWeight: 400,
    fontFamily: "inherit",
    padding: "12px 14px",
    borderRadius: 12,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    background: "var(--surface)",
    color: "var(--assistant-text)",
    cursor: "pointer",
  },
  choiceBtnSelected: {
    borderColor: "var(--accent)",
    background: "rgba(47,111,79,0.08)",
    fontWeight: 600,
  },
  choiceRadio: {
    flexShrink: 0,
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1.5,
    borderStyle: "solid",
    borderColor: "var(--accent)",
    color: "var(--accent)",
    fontSize: 12,
    lineHeight: "15px",
    textAlign: "center",
  },
  choiceHint: { fontWeight: 400, fontSize: 13, color: "var(--muted)" },
  choiceCheckbox: {
    flexShrink: 0,
    width: 18,
    height: 18,
    borderRadius: 5,
    borderWidth: 1.5,
    borderStyle: "solid",
    borderColor: "var(--accent)",
    background: "var(--surface)",
    color: "#fff",
    fontSize: 12,
    lineHeight: "15px",
    textAlign: "center",
  },
  choiceCheckboxSelected: { background: "var(--accent)" },
  formTextarea: {
    fontSize: 17,
    padding: "12px 14px",
    borderRadius: 12,
    border: "1px solid var(--border)",
    background: "var(--surface)",
    fontFamily: "inherit",
    fontWeight: 400,
    resize: "vertical",
  },
  formActions: {
    display: "flex",
    gap: 10,
    justifyContent: "flex-end",
    marginTop: 8,
  },
  primaryBtn: {
    background: "var(--accent)",
    color: "#fff",
    border: "none",
    borderRadius: 14,
    padding: "14px 22px",
    fontSize: 17,
    fontWeight: 600,
    cursor: "pointer",
  },
  secondaryBtn: {
    background: "transparent",
    color: "var(--muted)",
    border: "1px solid var(--border)",
    borderRadius: 14,
    padding: "14px 22px",
    fontSize: 17,
    cursor: "pointer",
  },
  header: {
    padding: "20px 4px 12px",
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },
  ghostBtn: {
    background: "transparent",
    color: "var(--accent)",
    border: "1px solid var(--accent)",
    borderRadius: 12,
    padding: "8px 12px",
    fontSize: 14,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  title: { margin: 0, fontSize: 28, color: "var(--accent)" },
  subtitle: { margin: "4px 0 0", color: "var(--muted)", fontSize: 16 },
  // Profile card
  card: {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-lg)",
    padding: "18px 20px",
    marginBottom: 16,
    boxShadow: "var(--shadow-e1)",
  },
  cardHead: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    marginBottom: 6,
  },
  cardClass: {
    fontWeight: 700,
    fontSize: "clamp(16px, 1.4vw, 21px)",
    color: "var(--accent)",
  },
  cardName: { color: "var(--muted)", fontSize: 15 },
  linkBtn: {
    background: "transparent",
    border: "none",
    color: "var(--accent)",
    fontSize: 14,
    cursor: "pointer",
    padding: 0,
    textDecoration: "underline",
  },
  schedBuildRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    flexWrap: "wrap",
    marginBottom: 12,
    paddingBottom: 12,
    borderBottom: "1px solid var(--border)",
  },
  schedBuildLabel: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    fontSize: 13.5,
    color: "var(--assistant-text)",
  },
  schedHomeSelect: {
    fontSize: 14,
    padding: "6px 8px",
    borderRadius: 8,
    border: "1px solid var(--border)",
    background: "var(--surface)",
    color: "var(--text)",
    fontFamily: "inherit",
  },
  schedBuildBtn: {
    background: "var(--accent)",
    color: "#fff",
    border: "none",
    borderRadius: 10,
    padding: "8px 14px",
    fontSize: 14,
    fontWeight: 700,
    cursor: "pointer",
  },
  schedSetupBtn: {
    background: "var(--accent)",
    color: "#fff",
    border: "none",
    borderRadius: 10,
    padding: "9px 14px",
    fontSize: 14,
    fontWeight: 700,
    cursor: "pointer",
    marginBottom: 10,
    width: "100%",
  },
  schedSetupPanel: {
    display: "flex",
    flexDirection: "column",
    gap: 12,
    border: "1px solid var(--border)",
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
    background: "var(--surface)",
  },
  schedList: { display: "flex", flexDirection: "column", gap: 6 },
  schedRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    background: "var(--surface)",
    borderRadius: 10,
    padding: "6px 10px 6px 8px",
  },
  schedRowNow: {
    background: "var(--accent-soft)",
    boxShadow: "0 0 0 1px var(--accent)",
  },
  schedTime: {
    flexShrink: 0,
    width: 74,
    fontSize: 12.5,
    fontWeight: 700,
    color: "var(--muted)",
    display: "flex",
    flexDirection: "column",
    lineHeight: 1.15,
  },
  schedNowDot: {
    fontSize: 10,
    fontWeight: 800,
    color: "var(--accent)",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  schedKind: {
    flexShrink: 0,
    background: "transparent",
    border: "none",
    fontSize: 18,
    lineHeight: 1,
    cursor: "pointer",
    padding: 2,
    borderRadius: 6,
  },
  schedInput: {
    flex: 1,
    minWidth: 0,
    fontSize: 14.5,
    padding: "7px 8px",
    borderRadius: 8,
    border: "1px solid transparent",
    background: "transparent",
    color: "var(--text)",
    fontFamily: "inherit",
  },
  schedTimerStart: {
    flexShrink: 0,
    background: "transparent",
    border: "none",
    fontSize: 16,
    lineHeight: 1,
    cursor: "pointer",
    padding: 4,
    borderRadius: 6,
    opacity: 0.55,
    color: "var(--muted)",
  },
  schedTimer: {
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    gap: 4,
    background: "var(--accent-soft)",
    borderRadius: 999,
    padding: "2px 4px 2px 6px",
  },
  schedTimerBtn: {
    background: "transparent",
    border: "none",
    fontSize: 13,
    lineHeight: 1,
    cursor: "pointer",
    padding: "2px 3px",
    borderRadius: 6,
    color: "var(--accent)",
  },
  schedTimerTime: {
    fontSize: 13,
    fontWeight: 700,
    fontVariantNumeric: "tabular-nums",
    color: "var(--accent)",
    minWidth: 38,
    textAlign: "center" as const,
  },
  schedTimerDone: {
    color: "#2f6f4f",
  },
  schedTimerClear: {
    background: "transparent",
    border: "none",
    fontSize: 11,
    lineHeight: 1,
    cursor: "pointer",
    padding: "2px 3px",
    borderRadius: 6,
    color: "var(--muted)",
  },
  topicRow: { display: "flex", gap: 8 },
  topicInput: {
    flex: 1,
    minWidth: 0,
    fontSize: 15,
    padding: "10px 12px",
    borderRadius: 12,
    border: "1px solid var(--border)",
    background: "var(--surface)",
    color: "var(--text)",
    fontFamily: "inherit",
  },
  topicBtn: {
    flexShrink: 0,
    background: "var(--accent)",
    color: "#fff",
    border: "none",
    borderRadius: 12,
    padding: "0 16px",
    fontSize: 15,
    fontWeight: 700,
    cursor: "pointer",
  },
  topicChips: { display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 },
  topicChip: {
    background: "var(--accent-soft)",
    color: "var(--accent)",
    border: "1px solid var(--border)",
    borderRadius: 999,
    padding: "5px 12px",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  },
  cardRow: { fontSize: 14, color: "var(--assistant-text)", marginTop: 6 },
  cardLabel: { color: "var(--muted)" },
  folderRow: { display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 },
  folder: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    background: "#fbf6e9",
    border: "1px solid #e6d9b8",
    borderRadius: 10,
    padding: "6px 10px",
    fontSize: 14,
    color: "var(--assistant-text)",
  },
  folderRemove: {
    background: "transparent",
    border: "none",
    color: "var(--muted)",
    fontSize: 16,
    lineHeight: 1,
    cursor: "pointer",
    padding: 0,
  },
  // Plan panel
  plan: {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 14,
    padding: "12px 14px",
    marginBottom: 10,
    maxHeight: 240,
    overflowY: "auto",
  },
  planHead: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  planTitle: { fontWeight: 700, fontSize: 16, color: "var(--assistant-text)" },
  planCount: { fontSize: 14, color: "var(--muted)" },
  progressTrack: {
    height: 8,
    borderRadius: 6,
    background: "var(--assistant-bubble)",
    margin: "8px 0 10px",
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    background: "var(--accent)",
    transition: "width 200ms ease",
  },
  planList: { display: "flex", flexDirection: "column", gap: 4 },
  planRow: { display: "flex", alignItems: "flex-start", gap: 2 },
  planRowAction: {
    flexShrink: 0,
    background: "transparent",
    border: "none",
    color: "var(--muted)",
    fontSize: 15,
    lineHeight: 1,
    cursor: "pointer",
    padding: "6px 6px",
    borderRadius: 6,
  },
  planEditRow: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 10,
    padding: "10px 12px",
    margin: "2px 0",
  },
  planEditInput: {
    fontSize: 15,
    padding: "8px 10px",
    borderRadius: 8,
    border: "1px solid var(--border)",
    background: "var(--bg)",
    color: "var(--text)",
    fontFamily: "inherit",
    width: "100%",
    boxSizing: "border-box",
  },
  planEditControls: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
  },
  planEditCheckpoint: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    fontSize: 13,
    color: "var(--assistant-text)",
    cursor: "pointer",
  },
  planEditCancel: {
    background: "transparent",
    border: "1px solid var(--border)",
    color: "var(--muted)",
    borderRadius: 8,
    padding: "6px 14px",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
  },
  planEditSave: {
    background: "var(--accent)",
    border: "none",
    color: "#fff",
    borderRadius: 8,
    padding: "6px 16px",
    fontSize: 14,
    fontWeight: 700,
    cursor: "pointer",
  },
  checkpointBadge: {
    display: "inline-block",
    fontSize: 11,
    fontWeight: 700,
    color: "#b8742a",
    background: "#f6e9da",
    borderRadius: 6,
    padding: "1px 6px",
    marginRight: 6,
    verticalAlign: "middle",
  },
  planItem: {
    display: "flex",
    alignItems: "flex-start",
    gap: 10,
    background: "transparent",
    border: "none",
    textAlign: "left",
    cursor: "pointer",
    padding: "6px 4px",
    fontSize: 15,
    fontFamily: "inherit",
  },
  checkbox: {
    flexShrink: 0,
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    borderStyle: "solid",
    borderColor: "var(--accent)",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 14,
    lineHeight: 1,
  },
  // Summarizer modal
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(28,36,33,0.45)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
    zIndex: 50,
  },
  modal: {
    background: "var(--bg)",
    borderRadius: 18,
    padding: 20,
    width: "100%",
    maxWidth: 560,
    maxHeight: "90dvh",
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },
  modalHead: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  modalTitle: { margin: 0, fontSize: 22, color: "var(--accent)" },
  tabs: { display: "flex", gap: 6 },
  tab: {
    flex: 1,
    background: "var(--surface)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    borderRadius: 10,
    padding: "8px 10px",
    fontSize: 15,
    cursor: "pointer",
    color: "var(--muted)",
  },
  tabActive: {
    background: "var(--accent)",
    color: "#fff",
    borderColor: "var(--accent)",
  },
  modalTextarea: {
    fontSize: 16,
    padding: "12px 14px",
    borderRadius: 12,
    border: "1px solid var(--border)",
    background: "var(--surface)",
    fontFamily: "inherit",
    resize: "vertical",
  },
  result: {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 12,
    padding: 14,
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },
  resultText: {
    whiteSpace: "pre-wrap",
    fontSize: 16,
    lineHeight: 1.6,
    color: "var(--assistant-text)",
  },
  resultMd: { fontSize: 16, lineHeight: 1.6, color: "var(--assistant-text)" },
  qaBox: {
    borderTop: "1px solid var(--border)",
    paddingTop: 12,
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  qaHead: { fontSize: 14, fontWeight: 700, color: "var(--accent)" },
  qaUser: {
    alignSelf: "flex-end",
    maxWidth: "85%",
    background: "var(--user-bubble)",
    color: "var(--user-text)",
    padding: "8px 12px",
    borderRadius: 12,
    fontSize: 15,
  },
  qaBot: {
    alignSelf: "flex-start",
    maxWidth: "95%",
    background: "var(--assistant-bubble)",
    color: "var(--assistant-text)",
    padding: "8px 12px",
    borderRadius: 12,
    fontSize: 15,
  },
  qaInputRow: { display: "flex", gap: 8, alignItems: "center" },
  mdH2: {
    fontSize: 18,
    fontWeight: 800,
    color: "var(--accent)",
    margin: "14px 0 4px",
  },
  mdH3: {
    fontSize: 15.5,
    fontWeight: 700,
    color: "var(--assistant-text)",
    margin: "10px 0 2px",
  },
  mdP: { margin: "4px 0" },
  // Highlighted key idea (==like this== in the AI notes) — a soft marker-pen
  // wash so the most important takeaways pop when scanning.
  mdMark: {
    background: "var(--highlight, rgba(255, 213, 79, 0.38))",
    color: "inherit",
    padding: "0 3px",
    borderRadius: 4,
    fontWeight: 600,
    boxDecorationBreak: "clone",
    WebkitBoxDecorationBreak: "clone",
  },
  mdBullet: {
    display: "flex",
    gap: 8,
    margin: "3px 0",
    alignItems: "flex-start",
  },
  mdBulletMark: {
    flexShrink: 0,
    color: "var(--accent)",
    fontWeight: 700,
    minWidth: 14,
  },
  outputLabel: { fontSize: 14, color: "var(--muted)", marginTop: 4 },
  outputRow: { display: "flex", flexWrap: "wrap", gap: 6 },
  outChip: {
    background: "var(--surface)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    borderRadius: 999,
    padding: "7px 12px",
    fontSize: 14,
    cursor: "pointer",
    color: "var(--muted)",
  },
  outChipActive: {
    background: "var(--accent)",
    color: "#fff",
    borderColor: "var(--accent)",
  },
  // Focus timer
  timerDisplay: {
    fontSize: 72,
    fontWeight: 700,
    textAlign: "center",
    color: "var(--accent)",
    fontVariantNumeric: "tabular-nums",
    margin: "8px 0",
  },
  timerDone: {
    textAlign: "center",
    fontSize: 17,
    color: "var(--assistant-text)",
    margin: 0,
  },
  // Focus garden
  coins: { fontSize: 16, fontWeight: 700, color: "var(--accent)" },
  scene: {
    position: "relative",
    overflow: "hidden",
    borderRadius: 16,
    border: "1px solid var(--border)",
    minHeight: 160,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
  },
  sceneContent: {
    position: "relative",
    zIndex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 6,
    padding: 16,
  },
  sceneFlower: {
    fontSize: 64,
    lineHeight: 1,
    filter: "drop-shadow(0 2px 3px rgba(0,0,0,0.18))",
  },
  sceneNote: {
    fontSize: 14,
    color: "#1c2421",
    textAlign: "center",
    background: "rgba(255,255,255,0.78)",
    borderRadius: 12,
    padding: "5px 12px",
  },
  gardenWrap: {
    display: "flex",
    flexWrap: "wrap",
    gap: 2,
    justifyContent: "center",
    fontSize: 22,
  },
  gardenFlower: { fontSize: 22 },
  locTitleRow: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: 8,
    marginTop: 4,
  },
  locList: { display: "flex", flexDirection: "column", gap: 2 },
  locRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "8px 4px",
  },
  locEmoji: { fontSize: 22, flexShrink: 0 },
  locName: { fontSize: 15, fontWeight: 600, color: "var(--assistant-text)" },
  locCount: { fontSize: 13, color: "var(--muted)" },
  locCurrent: { fontSize: 13, fontWeight: 700, color: "var(--accent)" },
  smallGhost: {
    background: "transparent",
    border: "1px solid var(--accent)",
    color: "var(--accent)",
    borderRadius: 10,
    padding: "6px 10px",
    fontSize: 13,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  levelChip: {
    background: "var(--accent)",
    color: "#fff",
    borderRadius: 999,
    padding: "2px 10px",
    fontSize: 13,
    fontWeight: 700,
  },
  customRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    justifyContent: "center",
    marginTop: 10,
  },
  customLabel: { fontSize: 14, color: "var(--muted)" },
  customInput: {
    width: 70,
    fontSize: 15,
    padding: "8px 10px",
    borderRadius: 10,
    border: "1px solid var(--border)",
    background: "var(--surface)",
    fontFamily: "inherit",
  },
  achToast: {
    background: "var(--accent)",
    color: "#fff",
    borderRadius: 12,
    padding: "10px 14px",
    fontSize: 15,
    cursor: "pointer",
  },
  fbCard: {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-lg)",
    boxShadow: "var(--shadow-e2)",
    padding: 18,
    marginBottom: 12,
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  fbTitle: {
    fontSize: "var(--text-h3)",
    fontWeight: 700,
    color: "var(--accent)",
  },
  fbSub: { fontSize: "1rem", color: "var(--text)", marginTop: -2 },
  fbInput: {
    width: "100%",
    minWidth: 0,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border-strong)",
    borderRadius: "var(--radius-md)",
    padding: "10px 14px",
    fontSize: "1rem",
    background: "var(--surface)",
    color: "var(--text)",
    fontFamily: "inherit",
  },
  fbMoodRow: { display: "flex", gap: 8, flexWrap: "wrap" },
  fbMoodBtn: {
    flex: 1,
    minWidth: 92,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 4,
    padding: "12px 8px",
    borderRadius: "var(--radius-md)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    background: "var(--accent-soft)",
    color: "var(--text)",
    fontSize: 15,
    fontWeight: 600,
    cursor: "pointer",
  },
  fbSkip: {
    alignSelf: "flex-start",
    background: "transparent",
    border: "none",
    color: "var(--muted)",
    fontSize: 14,
    cursor: "pointer",
    padding: 0,
  },
  prizeBanner: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    background: "linear-gradient(135deg, #f6c453, #e89b3c)",
    color: "#3a2a06",
    borderRadius: 14,
    padding: "12px 14px",
    cursor: "pointer",
    boxShadow: "0 2px 10px rgba(0,0,0,0.12)",
  },
  prizeDismiss: {
    fontSize: 12,
    opacity: 0.7,
    border: "1px solid rgba(58,42,6,0.4)",
    borderRadius: 8,
    padding: "2px 6px",
  },
  achGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
    gap: 6,
  },
  achItem: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 12,
    padding: "8px 10px",
  },
  achEmoji: { fontSize: 22, flexShrink: 0 },
  achName: { display: "block", fontSize: 14, fontWeight: 600, color: "var(--assistant-text)" },
  // Accessibility toggles
  toggleRow: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 12,
    padding: "12px 14px",
    cursor: "pointer",
    width: "100%",
  },
  switch: {
    flexShrink: 0,
    width: 44,
    height: 24,
    borderRadius: 12,
    position: "relative",
    transition: "background 150ms",
    display: "inline-block",
  },
  knob: {
    position: "absolute",
    top: 2,
    left: 2,
    width: 20,
    height: 20,
    borderRadius: "50%",
    background: "#fff",
    transition: "transform 150ms",
    boxShadow: "0 1px 2px rgba(0,0,0,0.3)",
  },
  toggleLabel: {
    display: "block",
    fontSize: 16,
    fontWeight: 600,
    color: "var(--assistant-text)",
  },
  toggleDesc: { display: "block", fontSize: 13, color: "var(--muted)", marginTop: 2 },
  fontRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    padding: "10px 0",
    borderBottom: "1px solid var(--border)",
  },
  fontStepper: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    flexShrink: 0,
  },
  fontStepBtn: {
    width: 38,
    height: 38,
    borderRadius: 10,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--accent)",
    background: "var(--surface)",
    color: "var(--accent)",
    fontSize: 15,
    fontWeight: 700,
    cursor: "pointer",
  },
  fontValue: {
    minWidth: 46,
    textAlign: "center",
    fontSize: 15,
    fontWeight: 600,
    color: "var(--assistant-text)",
  },
  themeSeg: {
    display: "flex",
    gap: 4,
    flexShrink: 0,
    padding: 4,
    borderRadius: 12,
    border: "1px solid var(--border)",
    background: "var(--surface)",
  },
  themeSegBtn: {
    border: "none",
    borderRadius: 9,
    padding: "8px 14px",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
  },
  themeGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(3, 1fr)",
    gap: 8,
    marginTop: 8,
  },
  themeChip: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 3,
    padding: "10px 6px",
    borderRadius: 12,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    background: "var(--surface)",
    color: "var(--assistant-text)",
    fontSize: 12.5,
    fontWeight: 600,
    cursor: "pointer",
  },
  themeChipActive: {
    borderColor: "var(--accent)",
    background: "var(--accent-soft)",
    color: "var(--accent)",
  },
  speakBtn: {
    background: "transparent",
    border: "1px solid var(--border)",
    borderRadius: 10,
    padding: "4px 10px",
    fontSize: 13,
    color: "var(--accent)",
    cursor: "pointer",
    marginTop: 2,
  },
  // Calendar
  cal: {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 14,
    padding: "12px 14px",
    marginBottom: 10,
  },
  calForm: { display: "flex", flexDirection: "column", gap: 8, margin: "10px 0" },
  calInput: {
    fontSize: 15,
    padding: "10px 12px",
    borderRadius: 10,
    border: "1px solid var(--border)",
    background: "var(--surface)",
    fontFamily: "inherit",
  },
  calAddBtn: {
    background: "var(--accent)",
    color: "#fff",
    border: "none",
    borderRadius: 10,
    padding: "10px 14px",
    fontSize: 15,
    fontWeight: 600,
    cursor: "pointer",
    alignSelf: "flex-start",
  },
  calEmpty: { margin: "8px 0 0", fontSize: 14, color: "var(--muted)" },
  calGridWrap: { margin: "12px 0 4px" },
  calNav: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  calNavBtn: {
    background: "var(--surface)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    borderRadius: 8,
    width: 32,
    height: 32,
    fontSize: 18,
    cursor: "pointer",
    color: "var(--accent)",
    lineHeight: 1,
  },
  calMonthLabel: { fontSize: 15, fontWeight: 700, color: "var(--assistant-text)" },
  calWeekRow: {
    display: "grid",
    gridTemplateColumns: "repeat(7, 1fr)",
    gap: 4,
    marginBottom: 4,
  },
  calWeekday: {
    textAlign: "center",
    fontSize: 11,
    fontWeight: 600,
    color: "var(--muted)",
  },
  calGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(7, 1fr)",
    gap: 4,
  },
  calCellEmpty: { height: 44 },
  calCell: {
    position: "relative",
    height: 44,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
    background: "var(--surface)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    borderRadius: 8,
    fontSize: 13,
    color: "var(--assistant-text)",
    cursor: "pointer",
    padding: 0,
  },
  calCellToday: {
    borderColor: "var(--accent)",
    borderWidth: 2,
    fontWeight: 700,
    color: "var(--accent)",
  },
  calDots: { display: "flex", gap: 2, height: 5 },
  calDot: { width: 5, height: 5, borderRadius: 3 },
  schedBox: {
    marginTop: 14,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: "var(--border)",
  },
  schedTitle: {
    fontSize: 14,
    fontWeight: 700,
    color: "var(--accent)",
    marginBottom: 6,
  },
  schedDay: { marginBottom: 10 },
  schedDayHead: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    marginBottom: 3,
  },
  schedDate: { fontSize: 13, fontWeight: 700, color: "var(--assistant-text)" },
  schedTotal: {
    fontSize: 12,
    fontWeight: 700,
    color: "var(--accent)",
    background: "var(--accent-soft)",
    padding: "2px 8px",
    borderRadius: 999,
  },
  schedItem: {
    display: "flex",
    alignItems: "flex-start",
    gap: 8,
    fontSize: 13.5,
    color: "var(--assistant-text)",
    padding: "3px 0 3px 4px",
  },
  schedTick: {
    flexShrink: 0,
    width: 6,
    height: 6,
    borderRadius: 3,
    marginTop: 6,
  },
  calLegend: {
    display: "flex",
    gap: 14,
    marginTop: 8,
    justifyContent: "center",
  },
  calLegendItem: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    fontSize: 12,
    color: "var(--muted)",
  },
  calRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "6px 2px",
    fontSize: 14,
  },
  calChip: {
    flexShrink: 0,
    fontSize: 11,
    fontWeight: 700,
    color: "#fff",
    borderRadius: 6,
    padding: "2px 7px",
    textTransform: "capitalize",
  },
  calDate: { flexShrink: 0, fontWeight: 600, color: "var(--assistant-text)", width: 56 },
  calTitle: {
    flex: 1,
    color: "var(--assistant-text)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  calCountdown: { flexShrink: 0, fontSize: 13, color: "var(--muted)" },
  calRemove: {
    flexShrink: 0,
    background: "transparent",
    border: "none",
    color: "var(--muted)",
    fontSize: 20,
    lineHeight: 1,
    cursor: "pointer",
    padding: "0 4px",
  },
  calStepBtn: {
    marginTop: 6,
    marginBottom: 4,
    padding: "5px 12px",
    borderRadius: 8,
    border: "none",
    background: "var(--accent-soft)",
    color: "var(--accent)",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  },
  tabBar: {
    display: "flex",
    gap: 6,
    padding: "4px 0 10px",
  },
  viewTab: {
    flex: 1,
    background: "var(--surface)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    borderRadius: 12,
    padding: "9px 3px",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    color: "var(--muted)",
    whiteSpace: "nowrap",
  },
  tabPanel: {
    flex: 1,
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: 12,
    paddingBottom: 16,
  },
  practiceStage: {
    position: "relative",
    width: "100%",
    aspectRatio: "16 / 10",
    minHeight: 640,
    maxHeight: "88vh",
    background: "#000",
    borderRadius: 18,
    overflow: "hidden",
    border: "1px solid var(--border)",
  },
  practiceVideo: {
    width: "100%",
    height: "100%",
    objectFit: "cover",
    borderRadius: 16,
    background: "#000",
    transform: "scaleX(-1)",
  },
  practiceAudioBox: {
    width: "100%",
    height: "100%",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    background: "var(--surface)",
  },
  practiceAudioIcon: { fontSize: 80 },
  practiceRecDot: {
    position: "absolute",
    top: 16,
    left: 16,
    display: "flex",
    alignItems: "center",
    gap: 10,
    background: "rgba(0,0,0,0.55)",
    color: "#fff",
    fontSize: 17,
    fontWeight: 700,
    padding: "8px 16px",
    borderRadius: 999,
  },
  practiceRecPulse: {
    width: 10,
    height: 10,
    borderRadius: "50%",
    background: "#ff4d4f",
    animation: "pulse 1s ease-in-out infinite",
  },
  practiceTeleprompter: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: "45%",
    overflowY: "auto",
    padding: "14px 18px",
    background: "linear-gradient(transparent, rgba(0,0,0,0.75))",
    color: "#fff",
    fontSize: 18,
    lineHeight: 1.5,
    whiteSpace: "pre-wrap",
  },
  practiceToggle: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 15,
    color: "var(--muted)",
    cursor: "pointer",
  },
  practiceControls: {
    display: "flex",
    flexWrap: "wrap",
    gap: 10,
    alignItems: "center",
  },
  practiceStopBtn: {
    background: "#ff4d4f",
    color: "#fff",
    border: "none",
    borderRadius: 14,
    padding: "14px 22px",
    fontSize: 17,
    fontWeight: 600,
    cursor: "pointer",
  },
  practiceTakeRow: { display: "flex", flexWrap: "wrap", gap: 8 },
  practiceTakeChip: {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 999,
    padding: "8px 14px",
    fontSize: 14,
    cursor: "pointer",
    color: "var(--text)",
  },
  practiceTakeChipActive: {
    background: "var(--accent)",
    color: "#fff",
    border: "1px solid var(--accent)",
  },
  planStrip: {
    background: "var(--surface)",
    border: "1px solid var(--accent)",
    borderRadius: 14,
    padding: "10px 14px",
    marginBottom: 8,
  },
  planStripHead: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 6,
  },
  planStripLabel: { fontSize: 14, fontWeight: 700, color: "var(--accent)" },
  planStripNext: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    width: "100%",
    textAlign: "left",
    background: "transparent",
    border: "none",
    cursor: "pointer",
    fontSize: 16,
    color: "var(--assistant-text)",
    padding: 0,
  },
  planStripNextLabel: { color: "var(--muted)", fontWeight: 600 },
  planStripCheck: {
    flexShrink: 0,
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    borderStyle: "solid",
    borderColor: "var(--accent)",
    display: "inline-block",
  },
  planStripDone: { fontSize: 15, color: "var(--assistant-text)" },
  // ----- Mistake tracker (Home dashboard strip) -----
  mtStrip: {
    background: "var(--surface)",
    border: "1px solid var(--accent)",
    borderRadius: 14,
    padding: "10px 14px",
    marginBottom: 8,
  },
  mtEmptyBtn: {
    width: "100%",
    textAlign: "left",
    background: "transparent",
    border: "none",
    cursor: "pointer",
    fontSize: 14,
    fontWeight: 600,
    color: "var(--accent)",
    padding: 0,
  },
  mtHead: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 6,
  },
  mtLabel: { fontSize: 14, fontWeight: 700, color: "var(--accent)" },
  mtTop: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    width: "100%",
    textAlign: "left",
    background: "transparent",
    border: "none",
    cursor: "pointer",
    fontSize: 16,
    color: "var(--assistant-text)",
    padding: 0,
  },
  mtCount: {
    flexShrink: 0,
    fontSize: 12,
    fontWeight: 700,
    color: "#c0392b",
    background: "#fbeae8",
    borderRadius: 8,
    padding: "2px 8px",
    whiteSpace: "nowrap",
  },
  mtList: { marginTop: 4 },
  mtItem: {
    padding: "10px 12px",
    borderRadius: 12,
    border: "1px solid var(--border)",
    background: "var(--bg)",
    marginBottom: 8,
  },
  mtItemTop: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  mtItemTitle: {
    fontSize: 14.5,
    fontWeight: 600,
    color: "var(--assistant-text)",
  },
  mtItemMeta: {
    marginTop: 4,
    fontSize: 13,
    color: "var(--muted)",
    lineHeight: 1.5,
  },
  mtChip: {
    display: "inline-block",
    padding: "1px 8px",
    borderRadius: 999,
    background: "var(--assistant-bubble)",
    color: "var(--assistant-text)",
    fontSize: 11.5,
    fontWeight: 600,
    marginRight: 6,
  },
  mtWhy: { fontStyle: "italic" },
  mtFix: { marginTop: 3, color: "var(--accent)", fontWeight: 600 },
  mtBtnRow: { display: "flex", gap: 6, marginTop: 8 },
  mtReviewBtn: {
    flex: 1,
    padding: "6px 10px",
    borderRadius: 8,
    border: "none",
    background: "var(--accent)",
    color: "#fff",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  },
  mtGotBtn: {
    flexShrink: 0,
    padding: "6px 10px",
    borderRadius: 8,
    border: "1px solid var(--accent)",
    background: "transparent",
    color: "var(--accent)",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  },
  mtRemoveBtn: {
    flexShrink: 0,
    width: 28,
    borderRadius: 8,
    border: "1px solid var(--border)",
    background: "transparent",
    color: "var(--muted)",
    fontSize: 13,
    cursor: "pointer",
  },
  mtAddRow: { display: "flex", gap: 6, marginTop: 4 },
  mtInput: {
    flex: 1,
    minWidth: 0,
    padding: "8px 10px",
    borderRadius: 8,
    border: "1px solid var(--border)",
    background: "var(--surface)",
    color: "var(--assistant-text)",
    fontSize: 13.5,
  },
  mtInputSm: {
    width: 92,
    flexShrink: 0,
    padding: "8px 10px",
    borderRadius: 8,
    border: "1px solid var(--border)",
    background: "var(--surface)",
    color: "var(--assistant-text)",
    fontSize: 13.5,
  },
  mtAddBtn: {
    flexShrink: 0,
    padding: "8px 14px",
    borderRadius: 8,
    border: "none",
    background: "var(--accent)",
    color: "#fff",
    fontSize: 13.5,
    fontWeight: 600,
    cursor: "pointer",
  },
  mtResolvedBox: { marginTop: 4 },
  mtResolvedToggle: {
    background: "transparent",
    border: "none",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 600,
    color: "var(--muted)",
    padding: "4px 0",
  },
  mtResolvedItem: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 13.5,
    color: "var(--muted)",
    padding: "4px 0",
  },
  chatTabs: {
    display: "flex",
    gap: 6,
    overflowX: "auto",
    padding: "2px 0 8px",
    alignItems: "center",
  },
  chatTab: {
    flexShrink: 0,
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    maxWidth: 160,
    background: "var(--surface)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    borderRadius: 999,
    padding: "6px 12px",
    fontSize: 13,
    cursor: "pointer",
    color: "var(--muted)",
  },
  chatTabActive: {
    background: "var(--assistant-bubble)",
    color: "var(--assistant-text)",
    borderColor: "var(--accent)",
  },
  chatTabLabel: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  chatTabClose: {
    fontSize: 15,
    lineHeight: 1,
    color: "var(--muted)",
    padding: "0 2px",
  },
  chatTabNew: {
    flexShrink: 0,
    background: "var(--accent)",
    color: "#fff",
    border: "none",
    borderRadius: 999,
    width: 30,
    height: 30,
    fontSize: 18,
    cursor: "pointer",
  },
  viewTabActive: {
    background: "var(--accent)",
    color: "#fff",
    borderColor: "var(--accent)",
  },
  studyScroll: {
    flex: 1,
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    paddingBottom: 16,
  },
  scroll: {
    flex: 1,
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: 12,
    padding: "8px 0",
  },
  row: { display: "flex", gap: 8 },
  videoGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
    gap: 10,
    maxWidth: "85%",
    marginTop: 2,
  },
  videoCard: {
    display: "block",
    textDecoration: "none",
    color: "inherit",
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 12,
    overflow: "hidden",
  },
  videoThumb: {
    width: "100%",
    aspectRatio: "16 / 9",
    objectFit: "cover",
    display: "block",
  },
  videoMeta: { padding: "8px 10px" },
  videoTitle: {
    fontSize: 14,
    fontWeight: 600,
    lineHeight: 1.3,
    color: "var(--assistant-text)",
    overflow: "hidden",
    display: "-webkit-box",
    WebkitLineClamp: 2,
    WebkitBoxOrient: "vertical",
  } as React.CSSProperties,
  videoChannel: { display: "block", fontSize: 12, color: "var(--muted)", marginTop: 4 },
  socialWrap: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
    gap: 10,
    maxWidth: "85%",
    marginTop: 2,
  },
  socialCard: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: 6,
    textDecoration: "none",
    color: "inherit",
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 12,
    padding: "10px 12px",
  } as React.CSSProperties,
  socialBadge: {
    fontSize: 11,
    fontWeight: 700,
    color: "#fff",
    padding: "3px 8px",
    borderRadius: 999,
  },
  socialTitle: {
    fontSize: 14,
    fontWeight: 600,
    lineHeight: 1.3,
    color: "var(--assistant-text)",
  },
  socialNote: { fontSize: 12, color: "var(--muted)", lineHeight: 1.35 },
  socialOpen: { fontSize: 12, fontWeight: 600, color: "var(--accent, #2f6f4f)" },
  // Anonymized peer-example cards ("how other students tackled this")
  exampleWrap: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    maxWidth: "85%",
    marginTop: 2,
  } as React.CSSProperties,
  exampleHeader: {
    fontSize: 13,
    fontWeight: 700,
    color: "var(--muted)",
  } as React.CSSProperties,
  exampleCard: {
    display: "flex",
    flexDirection: "column",
    gap: 5,
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderLeft: "3px solid var(--accent, #2f6f4f)",
    borderRadius: 12,
    padding: "10px 12px",
  } as React.CSSProperties,
  exampleTopRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
  } as React.CSSProperties,
  exampleBadge: {
    fontSize: 11,
    fontWeight: 700,
    color: "#fff",
    background: "var(--accent, #2f6f4f)",
    padding: "2px 8px",
    borderRadius: 999,
  } as React.CSSProperties,
  exampleSubject: {
    fontSize: 11,
    fontWeight: 600,
    color: "var(--muted)",
  } as React.CSSProperties,
  exampleTopic: {
    fontSize: 14,
    fontWeight: 600,
    color: "var(--assistant-text)",
    lineHeight: 1.3,
  } as React.CSSProperties,
  exampleProblem: {
    fontSize: 13,
    color: "var(--muted)",
    lineHeight: 1.4,
  } as React.CSSProperties,
  exampleApproach: {
    fontSize: 13,
    color: "var(--assistant-text)",
    lineHeight: 1.4,
  } as React.CSSProperties,
  // Video feed tab
  feedGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
    gap: 14,
    marginTop: 12,
  },
  feedCard: {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 14,
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
  },
  feedThumbBtn: {
    position: "relative",
    display: "block",
    width: "100%",
    padding: 0,
    border: "none",
    background: "none",
    cursor: "pointer",
  },
  feedPlayBadge: {
    position: "absolute",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 34,
    color: "#fff",
    textShadow: "0 2px 10px rgba(0,0,0,0.6)",
  },
  feedPlayer: {
    width: "100%",
    aspectRatio: "16 / 9",
    border: "none",
    display: "block",
  },
  feedCardFoot: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    marginTop: 6,
  },
  feedTopicTag: {
    fontSize: 11,
    fontWeight: 600,
    color: "var(--muted)",
    background: "var(--chip, rgba(0,0,0,0.06))",
    border: "1px solid var(--border)",
    borderRadius: 999,
    padding: "2px 8px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  feedYtLink: {
    fontSize: 12,
    color: "var(--muted)",
    textDecoration: "none",
    whiteSpace: "nowrap",
  },
  feedSearchRow: { display: "flex", gap: 8, marginTop: 10 },
  feedSearchInput: {
    flex: 1,
    minWidth: 0,
    padding: "8px 12px",
    borderRadius: 10,
    border: "1px solid var(--border)",
    background: "var(--surface)",
    color: "inherit",
    fontSize: 14,
  },
  feedSearchBtn: {
    padding: "8px 14px",
    borderRadius: 10,
    border: "1px solid var(--border)",
    background: "var(--accent, #6c5ce7)",
    color: "#fff",
    fontWeight: 600,
    fontSize: 14,
    cursor: "pointer",
  },
  feedRefresh: {
    padding: "6px 12px",
    borderRadius: 10,
    border: "1px solid var(--border)",
    background: "var(--surface)",
    color: "inherit",
    fontSize: 13,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  feedChips: {
    display: "flex",
    flexWrap: "wrap",
    gap: 6,
    marginTop: 10,
  },
  feedChip: {
    padding: "5px 12px",
    borderRadius: 999,
    border: "1px solid var(--border)",
    background: "var(--surface)",
    color: "inherit",
    fontSize: 13,
    cursor: "pointer",
  },
  feedChipActive: {
    background: "var(--accent, #6c5ce7)",
    border: "1px solid var(--accent, #6c5ce7)",
    color: "#fff",
    fontWeight: 600,
  },
  feedEmpty: {
    marginTop: 12,
    fontSize: 14,
    color: "var(--muted)",
  },
  bubble: {
    maxWidth: "min(86%, 680px)",
    padding: "14px 18px",
    borderRadius: "var(--radius-xl)",
    fontSize: "var(--text-body-lg)",
    lineHeight: 1.6,
    boxShadow: "var(--shadow-e1)",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
  // Study tools (flashcards + quiz)
  toolBox: {
    maxWidth: "85%",
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 14,
    padding: 14,
    marginTop: 2,
  },
  toolHead: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  toolTitle: { fontWeight: 700, fontSize: 16, color: "var(--assistant-text)" },
  flashcard: {
    width: "100%",
    minHeight: 120,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    background: "var(--assistant-bubble)",
    border: "1px solid var(--border)",
    borderRadius: 12,
    padding: 16,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  flashcardLabel: {
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    color: "var(--muted)",
  },
  flashcardText: {
    fontSize: 19,
    fontWeight: 600,
    color: "var(--assistant-text)",
    textAlign: "center",
  },
  flashcardHint: { fontSize: 12, color: "var(--muted)" },
  flashNav: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    marginTop: 10,
  },
  flashShareRow: {
    display: "flex",
    justifyContent: "center",
    marginTop: 10,
  },
  shareModalActions: {
    display: "flex",
    gap: 10,
    justifyContent: "center",
    marginTop: 6,
    flexWrap: "wrap",
  },
  // --- Persistent focus-music mini-player (fixed, bottom-right) -------------
  musicPlayer: {
    position: "fixed",
    right: 16,
    bottom: 16,
    zIndex: 60,
    width: "min(360px, calc(100vw - 32px))",
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 16,
    boxShadow: "0 8px 30px rgba(0,0,0,0.18)",
    overflow: "hidden",
  },
  musicFab: {
    position: "fixed",
    right: 16,
    bottom: 16,
    zIndex: 60,
    width: 48,
    height: 48,
    borderRadius: 999,
    border: "1px solid var(--border)",
    background: "var(--surface)",
    boxShadow: "0 6px 20px rgba(0,0,0,0.18)",
    fontSize: 22,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  musicHeader: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 10px",
    borderBottom: "1px solid var(--border)",
  },
  musicTitleBtn: {
    flex: 1,
    display: "flex",
    alignItems: "center",
    gap: 8,
    background: "transparent",
    border: "none",
    cursor: "pointer",
    color: "var(--text)",
    fontSize: 14,
    fontWeight: 700,
    padding: 0,
    minWidth: 0,
  },
  musicTitleText: {
    flex: 1,
    textAlign: "left",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  musicClose: {
    background: "transparent",
    border: "none",
    color: "var(--muted)",
    fontSize: 20,
    lineHeight: 1,
    cursor: "pointer",
    padding: "0 4px",
  },
  musicBody: { padding: 10, display: "flex", flexDirection: "column", gap: 8 },
  musicConnectRow: { display: "flex", gap: 6 },
  musicInput: {
    flex: 1,
    minWidth: 0,
    border: "1px solid var(--border)",
    borderRadius: 10,
    padding: "8px 10px",
    fontSize: 13,
    background: "var(--bg)",
    color: "var(--text)",
  },
  musicAddBtn: {
    border: "none",
    borderRadius: 10,
    padding: "8px 12px",
    background: "var(--accent)",
    color: "#fff",
    fontWeight: 700,
    fontSize: 13,
    cursor: "pointer",
    flexShrink: 0,
  },
  musicHint: { display: "flex", gap: 6, flexWrap: "wrap" },
  musicHintChip: { fontSize: 11, color: "var(--muted)" },
  musicError: {
    fontSize: 12,
    color: "#b3261e",
    background: "rgba(179,38,30,0.08)",
    borderRadius: 8,
    padding: "6px 8px",
  },
  musicTabs: { display: "flex", gap: 6, flexWrap: "wrap" },
  musicTabWrap: { display: "inline-flex", alignItems: "center" },
  musicTab: {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    maxWidth: 150,
    border: "1px solid var(--border)",
    borderRadius: 999,
    padding: "4px 8px",
    background: "var(--bg)",
    color: "var(--text)",
    fontSize: 12,
    cursor: "pointer",
  },
  musicTabActive: {
    background: "var(--accent-soft)",
    border: "1px solid var(--accent)",
    color: "var(--accent)",
    fontWeight: 700,
  },
  musicTabLabel: {
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  musicTabDel: {
    background: "transparent",
    border: "none",
    color: "var(--muted)",
    cursor: "pointer",
    fontSize: 14,
    lineHeight: 1,
    padding: "0 2px",
    marginLeft: 2,
  },
  musicEmbedWrap: { display: "flex", flexDirection: "column", gap: 6 },
  musicEmbed: {
    width: "100%",
    border: "none",
    borderRadius: 12,
    display: "block",
  },
  musicOpenLink: {
    fontSize: 11,
    color: "var(--muted)",
    textDecoration: "none",
    alignSelf: "flex-end",
  },
  musicEmpty: { fontSize: 13, color: "var(--muted)", margin: "4px 0" },
  quizQ: { fontWeight: 600, fontSize: 16, marginBottom: 6, color: "var(--assistant-text)" },
  quizOpt: {
    display: "block",
    width: "100%",
    textAlign: "left",
    border: "1px solid var(--border)",
    borderRadius: 10,
    padding: "10px 12px",
    marginBottom: 6,
    fontSize: 15,
    cursor: "pointer",
    fontFamily: "inherit",
    color: "var(--assistant-text)",
  },
  quizExplain: { fontSize: 14, color: "var(--muted)", marginTop: 4 },
  quizDone: {
    fontSize: 15,
    color: "var(--assistant-text)",
    marginTop: 8,
    fontWeight: 600,
  },
  // Daily assignments
  assignAddRow: { display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" },
  assignInput: {
    flex: 1,
    minWidth: 0,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    borderRadius: 10,
    padding: "10px 12px",
    fontSize: 15,
    background: "var(--surface)",
    color: "var(--assistant-text)",
  },
  assignAddBtn: {
    background: "var(--accent)",
    color: "#fff",
    border: "none",
    borderRadius: 10,
    padding: "0 16px",
    fontSize: 15,
    fontWeight: 600,
    cursor: "pointer",
  },
  assignMetaRow: {
    display: "flex",
    gap: 8,
    marginTop: 8,
    marginBottom: 4,
    flexWrap: "wrap",
  },
  assignSelect: {
    flex: 1,
    minWidth: "140px",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    borderRadius: 10,
    padding: "8px 10px",
    fontSize: 14,
    background: "var(--surface)",
    color: "var(--assistant-text)",
  },
  assignEmpty: { color: "var(--muted)", fontSize: 14, margin: "10px 0 2px" },
  subjectsCount: { fontSize: 14, color: "var(--muted)" },
  monthNavBtn: {
    width: 30,
    height: 30,
    borderRadius: 8,
    border: "1px solid var(--border)",
    background: "var(--bg)",
    color: "var(--text)",
    fontSize: 18,
    lineHeight: 1,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  monthNavBtnOff: {
    opacity: 0.4,
    cursor: "default",
  },
  assignItem: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "10px 0",
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: "var(--border)",
  },
  assignCheck: {
    flexShrink: 0,
    width: 24,
    height: 24,
    borderRadius: 7,
    borderWidth: 1.5,
    borderStyle: "solid",
    borderColor: "var(--accent)",
    background: "var(--surface)",
    color: "#fff",
    fontSize: 14,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  assignCheckDone: { background: "var(--accent)" },
  assignTitle: { fontSize: 15, color: "var(--assistant-text)" },
  assignTitleDone: {
    fontSize: 15,
    color: "var(--muted)",
    textDecoration: "line-through",
  },
  assignMeta: { fontSize: 12.5, color: "var(--muted)", marginTop: 2 },
  assignDeadline: {
    fontSize: 12.5,
    fontWeight: 600,
    color: "var(--muted)",
    marginTop: 3,
  },
  assignDeadlineUrgent: { color: "var(--accent)" },
  assignDeadlineOverdue: { color: "var(--danger, #e05252)" },
  assignRemove: {
    flexShrink: 0,
    background: "transparent",
    border: "none",
    color: "var(--muted)",
    fontSize: 20,
    lineHeight: 1,
    cursor: "pointer",
  },
  concernAdd: {
    marginTop: 5,
    background: "transparent",
    border: "none",
    padding: 0,
    color: "var(--muted)",
    fontSize: 12.5,
    cursor: "pointer",
  },
  concernRow: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    marginTop: 5,
  },
  concernIcon: { fontSize: 13, flexShrink: 0 },
  concernInput: {
    flex: 1,
    minWidth: 0,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    borderRadius: 8,
    padding: "3px 8px",
    fontSize: 12.5,
    background: "var(--surface)",
    color: "var(--assistant-text)",
  },
  // SMART goals
  goalField: { display: "block", marginTop: 10 },
  goalFieldLabel: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 13.5,
    fontWeight: 600,
    color: "var(--assistant-text)",
    marginBottom: 5,
  },
  goalLetter: {
    flexShrink: 0,
    width: 20,
    height: 20,
    borderRadius: 6,
    background: "var(--accent)",
    color: "#fff",
    fontSize: 12,
    fontWeight: 700,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
  },
  goalHint: { display: "block", fontSize: 12, color: "var(--muted)", marginTop: 3 },
  goalItem: {
    padding: "11px 13px",
    borderRadius: 12,
    border: "1px solid var(--border)",
    background: "var(--surface)",
    boxShadow: "var(--shadow-e1)",
    marginBottom: 8,
  },
  goalTop: { display: "flex", alignItems: "flex-start", gap: 8 },
  goalTitle: { fontSize: 14, fontWeight: 600, color: "var(--assistant-text)" },
  goalDue: {
    flexShrink: 0,
    fontSize: 12,
    fontWeight: 600,
    color: "var(--accent)",
    background: "var(--assistant-bubble)",
    borderRadius: 8,
    padding: "2px 8px",
    whiteSpace: "nowrap",
  },
  goalDueOver: { color: "#c0392b", background: "#fbeae8" },
  goalProgressRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginTop: 10,
    marginLeft: 34,
  },
  goalStep: {
    flexShrink: 0,
    width: 26,
    height: 26,
    borderRadius: 7,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    background: "var(--surface)",
    color: "var(--assistant-text)",
    fontSize: 16,
    lineHeight: 1,
    cursor: "pointer",
  },
  goalTrack: {
    flex: 1,
    height: 8,
    borderRadius: 6,
    background: "var(--assistant-bubble)",
    overflow: "hidden",
  },
  goalFill: {
    height: "100%",
    background: "var(--accent)",
    transition: "width 200ms ease",
  },
  goalCount: {
    flexShrink: 0,
    fontSize: 12.5,
    color: "var(--muted)",
    minWidth: 38,
    textAlign: "right",
  },
  goalBtnRow: { display: "flex", gap: 8, marginTop: 12 },
  goalNewBtn: {
    flex: 1,
    padding: "10px 12px",
    borderRadius: 10,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: "var(--accent)",
    background: "transparent",
    color: "var(--accent)",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
  },
  goalSuggestBtn: {
    flex: 1,
    padding: "10px 12px",
    borderRadius: 10,
    border: "none",
    background: "var(--accent-soft)",
    color: "var(--accent)",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
  },
  sugBox: {
    marginTop: 12,
    padding: "10px 14px 12px",
    borderRadius: 12,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    background: "var(--surface)",
  },
  sugHead: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    marginBottom: 4,
  },
  sugTitle: { fontSize: 14, fontWeight: 700, color: "var(--accent)" },
  sugItem: {
    display: "flex",
    alignItems: "flex-start",
    gap: 8,
    padding: "9px 0",
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: "var(--border)",
  },
  sugText: { fontSize: 14.5, color: "var(--assistant-text)" },
  sugMeta: { fontSize: 12, color: "var(--muted)", marginTop: 2 },
  sugChange: {
    flexShrink: 0,
    alignSelf: "center",
    padding: "3px 10px",
    borderRadius: 999,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    background: "transparent",
    color: "var(--muted)",
    fontSize: 12.5,
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  goalAchStrip: {
    marginTop: 10,
    marginBottom: 4,
    padding: "12px 12px 10px",
    borderRadius: 12,
    background: "var(--accent-soft)",
    border: "1px solid var(--border)",
  },
  goalAchHead: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    marginBottom: 10,
  },
  goalAchTitle: { fontSize: 13, fontWeight: 800, color: "var(--accent)" },
  goalAchRow: {
    display: "flex",
    gap: 10,
    overflowX: "auto",
    paddingBottom: 2,
  },
  goalAchItem: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 4,
    width: 62,
    flexShrink: 0,
  },
  goalAchMedal: {
    width: 40,
    height: 40,
    borderRadius: 999,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 20,
    color: "#fff",
    border: "2px solid rgba(255,255,255,0.55)",
    boxShadow: "0 2px 6px rgba(0,0,0,0.18)",
  },
  goalAchLabel: {
    fontSize: 10,
    fontWeight: 700,
    lineHeight: 1.15,
    textAlign: "center",
    color: "var(--assistant-text)",
  },
  goalGroup: { marginTop: 16 },
  goalGroupHeadRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    marginBottom: 8,
  },
  goalGroupCount: {
    flexShrink: 0,
    fontSize: 12,
    fontWeight: 700,
    color: "var(--muted)",
    background: "var(--assistant-bubble)",
    borderRadius: 999,
    padding: "2px 9px",
    minWidth: 22,
    textAlign: "center",
  },
  goalGroupCountOn: { color: "#fff", background: "var(--accent)" },
  goalAchievedToggle: {
    width: "100%",
    textAlign: "left",
    marginTop: 12,
    padding: "8px 4px",
    background: "transparent",
    border: "none",
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: "var(--border)",
    color: "var(--muted)",
    fontSize: 13,
    fontWeight: 700,
    cursor: "pointer",
  },
  goalGroupHead: {
    display: "inline-block",
    fontSize: 12,
    fontWeight: 800,
    color: "var(--accent)",
    textTransform: "uppercase",
    letterSpacing: 0.4,
    background: "var(--assistant-bubble)",
    padding: "4px 11px",
    borderRadius: 999,
  },
  // Short-term group: a big highlighted card so the "do now" goals stand out.
  goalGroupHighlight: {
    marginTop: 6,
    marginBottom: 10,
    padding: "8px 12px 10px",
    borderRadius: 12,
    background: "var(--accent-soft)",
    borderWidth: 1.5,
    borderStyle: "solid",
    borderColor: "var(--accent)",
  },
  goalGroupHeadHighlight: {
    display: "inline-block",
    fontSize: 12.5,
    fontWeight: 800,
    letterSpacing: 0.3,
    textTransform: "uppercase",
    color: "#fff",
    background: "var(--accent)",
    padding: "4px 11px",
    borderRadius: 999,
  },
  horizonRow: { display: "flex", gap: 6 },
  horizonBtn: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 1,
    padding: "7px 6px",
    borderRadius: 9,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    background: "var(--surface)",
    color: "var(--assistant-text)",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  },
  horizonBtnActive: {
    borderColor: "var(--accent)",
    background: "var(--accent-soft)",
    color: "var(--accent)",
  },
  horizonHint: { fontSize: 10.5, fontWeight: 400, color: "var(--muted)" },
  horizonDesc: {
    display: "block",
    fontSize: 12,
    color: "var(--muted)",
    marginTop: 6,
    lineHeight: 1.4,
  },
  horizonExample: {
    display: "block",
    fontSize: 12,
    fontStyle: "italic",
    color: "var(--muted)",
    marginTop: 3,
    lineHeight: 1.4,
  },
  goalBreakBtn: {
    marginTop: 6,
    marginLeft: 32,
    padding: "3px 10px",
    borderRadius: 8,
    border: "none",
    background: "var(--accent-soft)",
    color: "var(--accent)",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
  },
  // The reward "prize" tied to a goal — a small picker on active goals and a
  // won-treat line on achieved ones.
  goalPrizeRow: {
    marginTop: 6,
    marginLeft: 32,
    display: "flex",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
  },
  goalPrizeLabel: { fontSize: 12.5, fontWeight: 700, color: "var(--muted)" },
  goalPrizeSelect: {
    padding: "3px 8px",
    borderRadius: 8,
    border: "1px solid var(--border)",
    background: "var(--surface)",
    color: "var(--text)",
    fontSize: 12.5,
    fontFamily: "inherit",
    cursor: "pointer",
    maxWidth: 220,
  },
  goalPrizeHint: { fontSize: 12, color: "var(--muted)", fontStyle: "italic" },
  goalPrizeEarned: {
    marginTop: 6,
    marginLeft: 32,
    fontSize: 12.5,
    fontWeight: 700,
    color: "var(--accent)",
  },
  rewardGoalTag: {
    marginTop: 2,
    fontSize: 12,
    fontWeight: 600,
    color: "var(--accent)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  goalTasks: { marginTop: 8, marginLeft: 32, display: "flex", flexDirection: "column", gap: 2 },
  goalTasksHead: {
    fontSize: 12,
    fontWeight: 700,
    color: "var(--muted)",
    textTransform: "uppercase",
    letterSpacing: 0.3,
    marginBottom: 4,
  },
  goalTaskRow: { display: "flex", alignItems: "flex-start", gap: 6 },
  goalTaskToggle: {
    display: "flex",
    alignItems: "flex-start",
    gap: 8,
    background: "transparent",
    border: "none",
    textAlign: "left",
    cursor: "pointer",
    padding: "4px 0",
    fontSize: 14.5,
    fontFamily: "inherit",
  },
  goalTaskHelp: {
    flexShrink: 0,
    alignSelf: "center",
    padding: "3px 10px",
    borderRadius: 999,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--accent)",
    background: "transparent",
    color: "var(--accent)",
    fontSize: 12.5,
    fontWeight: 600,
    cursor: "pointer",
  },
  // Study tools (in the Study tab)
  studyToolsGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 8,
    marginTop: 8,
  },
  studyToolBtn: {
    background: "var(--surface)",
    border: "1px solid var(--accent)",
    color: "var(--accent)",
    borderRadius: 12,
    padding: "12px 10px",
    fontSize: 15,
    fontWeight: 600,
    cursor: "pointer",
  },
  notifBadge: {
    position: "absolute",
    top: -5,
    right: -5,
    minWidth: 17,
    height: 17,
    padding: "0 4px",
    borderRadius: 9,
    background: "#d9534f",
    color: "#fff",
    fontSize: 11,
    fontWeight: 700,
    lineHeight: "17px",
    textAlign: "center",
    pointerEvents: "none",
  },
  topNotifWrap: {
    position: "fixed",
    top: 14,
    right: 18,
    zIndex: 45,
  },
  topNotifBtn: {
    position: "relative",
    width: 40,
    height: 40,
    borderRadius: 12,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    background: "var(--bg)",
    boxShadow: "0 2px 8px rgba(0,0,0,0.10)",
    fontSize: 18,
    lineHeight: "38px",
    cursor: "pointer",
  },
  topNotifPanel: {
    position: "absolute",
    top: 48,
    right: 0,
    width: 300,
    maxHeight: 360,
    overflowY: "auto",
    padding: "10px 12px",
    borderRadius: 12,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    background: "var(--bg)",
    boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
    zIndex: 46,
  },
  notifPanel: {
    position: "absolute",
    bottom: 44,
    left: 0,
    width: 300,
    maxHeight: 360,
    overflowY: "auto",
    padding: "10px 12px",
    borderRadius: 12,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    background: "var(--bg)",
    boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
    zIndex: 40,
  },
  notifHead: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    justifyContent: "space-between",
    paddingBottom: 6,
  },
  notifClose: {
    border: "none",
    background: "transparent",
    color: "var(--muted)",
    fontSize: 18,
    lineHeight: 1,
    cursor: "pointer",
  },
  notifEmpty: {
    margin: "8px 0 4px",
    color: "var(--muted)",
    fontSize: 14,
  },
  reminderRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    width: "100%",
    padding: "8px 4px",
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: "var(--border)",
  },
  reminderCheck: {
    flexShrink: 0,
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    borderStyle: "solid",
    borderColor: "var(--accent)",
    background: "var(--surface)",
    cursor: "pointer",
  },
  reminderText: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    width: "100%",
    padding: "10px 8px",
    borderRadius: "var(--radius-md)",
    background: "transparent",
    border: "none",
    fontSize: "1rem",
    color: "var(--text)",
    cursor: "pointer",
  },
  planRebuildBtn: {
    alignSelf: "flex-start",
    background: "var(--surface)",
    border: "1px solid var(--accent)",
    color: "var(--accent)",
    borderRadius: 10,
    padding: "8px 12px",
    fontSize: 13.5,
    fontWeight: 600,
    cursor: "pointer",
  },
  addClassRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    padding: "4px 4px 4px 2px",
  },
  addClassLabel: { fontSize: 13.5, color: "var(--muted)" },
  addClassPlus: {
    flexShrink: 0,
    width: 34,
    height: 34,
    borderRadius: 17,
    background: "var(--accent)",
    color: "#fff",
    border: "none",
    fontSize: 22,
    lineHeight: 1,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  classSurveyLabel: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    fontSize: 13.5,
    fontWeight: 600,
    color: "var(--assistant-text)",
    marginTop: 10,
  },
  classSurveyActions: {
    display: "flex",
    gap: 8,
    justifyContent: "flex-end",
    marginTop: 14,
  },
  classSurveyCancel: {
    background: "transparent",
    border: "1px solid var(--border)",
    color: "var(--muted)",
    borderRadius: 10,
    padding: "0 16px",
    fontSize: 15,
    fontWeight: 600,
    cursor: "pointer",
  },
  composerActions: {
    display: "flex",
    flexWrap: "wrap",
    gap: 6,
    padding: "8px 0 0",
  },
  lessonAsk: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 6,
    padding: "10px 0 0",
  },
  lessonAskLabel: {
    fontSize: 11,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: 0.4,
    color: "var(--muted)",
    paddingRight: 2,
  },
  quickChip: {
    padding: "5px 12px",
    borderRadius: 999,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    background: "var(--surface)",
    color: "var(--assistant-text)",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  },
  weakChip: {
    padding: "5px 12px",
    borderRadius: 999,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--accent)",
    background: "var(--bg-accent-soft, rgba(111,207,151,0.12))",
    color: "var(--accent)",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  },
  teachLevelGroup: {
    display: "inline-flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 4,
    padding: 3,
    borderRadius: 16,
    border: "1px solid var(--border)",
    background: "var(--surface)",
  },
  teachLevelLabel: {
    fontSize: 11,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: 0.4,
    color: "var(--muted)",
    padding: "0 6px",
  },
  teachLevelBtn: {
    padding: "3px 10px",
    borderRadius: 999,
    border: "none",
    background: "transparent",
    color: "var(--muted)",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
  },
  teachLevelBtnActive: {
    background: "var(--accent)",
    color: "#fff",
  },
  composer: {
    display: "flex",
    gap: 8,
    padding: "14px 0 18px",
    marginTop: 4,
    borderTop: "1px solid var(--border)",
    alignItems: "flex-end",
  },
  input: {
    flex: 1,
    minWidth: 0,
    resize: "none",
    fontSize: "var(--text-body-lg)",
    lineHeight: 1.5,
    padding: "12px 16px",
    borderRadius: "var(--radius-md)",
    border: "1px solid var(--border-strong)",
    background: "var(--surface)",
    color: "var(--text)",
    fontFamily: "inherit",
  },
  sendBtn: {
    background: "var(--accent)",
    color: "var(--primary-foreground)",
    border: "none",
    borderRadius: "var(--radius-md)",
    padding: "13px 22px",
    fontSize: "1rem",
    fontWeight: 600,
    cursor: "pointer",
    minWidth: 72,
    boxShadow: "var(--shadow-e1)",
  },
  micBtn: {
    background: "var(--surface)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border-strong)",
    borderRadius: "var(--radius-md)",
    padding: "12px 16px",
    fontSize: 18,
    cursor: "pointer",
    lineHeight: 1,
  },
  micBtnActive: {
    background: "#fdecea",
    borderColor: "#e5534b",
  },
  // Voice mode — the full-screen "talking with Eliora" overlay.
  voiceOverlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(20,28,24,0.72)",
    backdropFilter: "blur(3px)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
    zIndex: 60,
  },
  voiceCard: {
    background: "var(--bg)",
    borderRadius: 22,
    padding: "18px 20px 20px",
    width: "100%",
    maxWidth: 440,
    maxHeight: "90dvh",
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 12,
    boxShadow: "var(--shadow-e3)",
    textAlign: "center",
  },
  voiceHead: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    width: "100%",
  },
  voiceTitle: { fontSize: 16, fontWeight: 600, color: "var(--accent)" },
  voiceOrb: {
    width: 116,
    height: 116,
    borderRadius: "50%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 46,
    background: "var(--surface)",
    borderWidth: 2,
    borderStyle: "solid",
    borderColor: "var(--accent)",
    marginTop: 6,
  },
  voiceStatus: { fontSize: 17, fontWeight: 600, color: "var(--text)" },
  voiceHeard: {
    margin: 0,
    fontSize: 15,
    lineHeight: 1.45,
    color: "var(--muted)",
    minHeight: 44,
  },
  voiceReply: {
    margin: 0,
    fontSize: 15,
    lineHeight: 1.5,
    color: "var(--text)",
    background: "var(--surface)",
    borderRadius: 14,
    padding: "10px 12px",
    maxHeight: 180,
    overflowY: "auto",
    textAlign: "left",
    width: "100%",
  },
  voiceError: {
    margin: 0,
    fontSize: 15,
    lineHeight: 1.5,
    color: "var(--text)",
  },
  voiceControls: {
    display: "flex",
    flexWrap: "wrap",
    gap: 8,
    justifyContent: "center",
    width: "100%",
  },
  voiceHint: { margin: 0, fontSize: 12.5, color: "var(--muted)" },
  // Chat attachments (composer staging strip + in-bubble thumbnails)
  attachStrip: {
    display: "flex",
    flexWrap: "wrap",
    gap: 8,
    alignItems: "center",
    padding: "8px 0 0",
    marginBottom: 2,
  },
  attachChip: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    maxWidth: 220,
    padding: "4px 6px 4px 4px",
    borderRadius: 10,
    border: "1px solid var(--border-strong)",
    background: "var(--surface)",
    position: "relative",
  },
  attachThumb: {
    width: 32,
    height: 32,
    borderRadius: 6,
    objectFit: "cover",
    display: "block",
  },
  attachIcon: {
    width: 32,
    height: 32,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 18,
  },
  attachName: {
    fontSize: 12,
    color: "var(--muted)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    maxWidth: 130,
  },
  attachBadge: {
    fontSize: 9,
    color: "var(--muted)",
  },
  attachRemove: {
    border: "none",
    background: "transparent",
    color: "var(--muted)",
    cursor: "pointer",
    fontSize: 12,
    lineHeight: 1,
    padding: 2,
  },
  msgAttach: {
    position: "relative",
    display: "inline-flex",
    alignItems: "center",
  },
  msgAttachImg: {
    maxWidth: 200,
    maxHeight: 200,
    borderRadius: 10,
    objectFit: "cover",
    display: "block",
  },
  msgAttachFile: {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    padding: "6px 10px",
    borderRadius: 10,
    background: "rgba(0,0,0,0.06)",
    fontSize: 13,
  },
  msgAttachPlay: {
    position: "absolute",
    top: "50%",
    left: "50%",
    transform: "translate(-50%,-50%)",
    color: "#fff",
    fontSize: 22,
    textShadow: "0 1px 4px rgba(0,0,0,0.6)",
    pointerEvents: "none",
  },
  // Teach-back video recorder
  recCloseBtn: {
    background: "transparent",
    border: "none",
    fontSize: 20,
    lineHeight: 1,
    cursor: "pointer",
    color: "var(--muted)",
    padding: 4,
  },
  recSub: {
    margin: 0,
    fontSize: 14,
    lineHeight: 1.5,
    color: "var(--muted)",
  },
  recStage: {
    position: "relative",
    width: "100%",
    aspectRatio: "4 / 3",
    background: "#000",
    borderRadius: 14,
    overflow: "hidden",
  },
  recVideo: {
    width: "100%",
    height: "100%",
    objectFit: "cover",
    // Mirror the live feed so it feels like a mirror; playback stays natural.
    transform: "scaleX(-1)",
  },
  recBadge: {
    position: "absolute",
    top: 10,
    left: 10,
    background: "rgba(229,83,75,0.92)",
    color: "#fff",
    fontSize: 13,
    fontWeight: 700,
    padding: "4px 10px",
    borderRadius: 999,
    letterSpacing: 0.3,
  },
  recTranscript: {
    width: "100%",
    resize: "vertical",
    fontSize: 15,
    lineHeight: 1.5,
    padding: "10px 12px",
    borderRadius: "var(--radius-md)",
    border: "1px solid var(--border-strong)",
    background: "var(--surface)",
    color: "var(--text)",
    fontFamily: "inherit",
  },
  recHint: {
    margin: 0,
    fontSize: 13,
    color: "var(--muted)",
  },
  recError: {
    background: "#fdecea",
    color: "#a3372f",
    borderRadius: 12,
    padding: "12px 14px",
    fontSize: 14,
    lineHeight: 1.5,
  },
  recControls: {
    display: "flex",
    gap: 8,
    justifyContent: "flex-end",
    flexWrap: "wrap",
  },
  recPrimary: {
    background: "var(--accent)",
    color: "var(--primary-foreground)",
    border: "none",
    borderRadius: "var(--radius-md)",
    padding: "11px 20px",
    fontSize: 15,
    fontWeight: 700,
    cursor: "pointer",
    boxShadow: "var(--shadow-e1)",
  },
  recSecondary: {
    background: "var(--surface)",
    color: "var(--assistant-text)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border-strong)",
    borderRadius: "var(--radius-md)",
    padding: "11px 18px",
    fontSize: 15,
    fontWeight: 600,
    cursor: "pointer",
  },
  recStop: {
    background: "#e5534b",
    color: "#fff",
    border: "none",
    borderRadius: "var(--radius-md)",
    padding: "11px 22px",
    fontSize: 15,
    fontWeight: 700,
    cursor: "pointer",
  },
  // 4-year roadmap
  fypDestRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
    margin: "4px 0 12px",
  },
  fypDestLabel: { fontSize: 13, fontWeight: 700, color: "var(--muted)" },
  fypDest: {
    background: "var(--accent-soft)",
    color: "var(--accent)",
    border: "none",
    borderRadius: 999,
    padding: "5px 12px",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
  },
  fypProgressMeta: {
    fontSize: 12.5,
    color: "var(--muted)",
    marginTop: 6,
    marginBottom: 4,
  },
  fypYear: {
    marginTop: 14,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: "var(--border)",
  },
  fypYearHead: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    marginBottom: 4,
  },
  fypYearLabel: {
    fontSize: 15.5,
    fontWeight: 700,
    color: "var(--assistant-text)",
  },
  fypSectionLabel: {
    fontSize: 12,
    fontWeight: 700,
    color: "var(--muted)",
    textTransform: "uppercase",
    letterSpacing: 0.3,
    margin: "10px 0 4px",
  },
  fypViewToggle: {
    display: "flex",
    gap: 6,
    marginTop: 16,
    marginBottom: 10,
  },
  fypViewBtn: {
    padding: "6px 14px",
    borderRadius: 999,
    border: "1px solid var(--border)",
    background: "var(--bg)",
    color: "var(--text)",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  },
  fypViewBtnOn: {
    background: "var(--accent)",
    border: "1px solid var(--accent)",
    color: "#fff",
  },
  fypGridScroll: {
    overflowX: "auto",
    paddingBottom: 8,
    margin: "0 -2px",
  },
  fypGrid: {
    display: "flex",
    alignItems: "stretch",
    border: "1px solid var(--border)",
    borderRadius: 16,
    overflow: "hidden",
    minWidth: "min-content",
    boxShadow: "0 2px 10px rgba(0,0,0,0.05)",
  },
  fypGridCol: {
    flex: "1 0 340px",
    minWidth: 340,
    borderLeft: "1px solid var(--border)",
    display: "flex",
    flexDirection: "column",
  },
  fypGridHead: {
    background: "var(--accent-soft)",
    padding: "18px 20px",
    borderBottom: "2px solid var(--border)",
  },
  fypGridYear: {
    fontSize: 22,
    fontWeight: 800,
    color: "var(--assistant-text)",
    letterSpacing: -0.2,
  },
  fypGridSub: {
    fontSize: 14,
    color: "var(--muted)",
    marginTop: 5,
    fontWeight: 500,
  },
  fypGridGpa: {
    color: "var(--accent)",
    fontWeight: 700,
  },
  reflSection: {
    marginTop: 20,
    paddingTop: 16,
    borderTop: "1px solid var(--border)",
  },
  reflBox: {
    marginTop: 10,
    padding: "12px 14px",
    borderRadius: 12,
    background: "var(--accent-soft)",
    border: "1px solid var(--border)",
  },
  reflOpenBtn: {
    padding: "9px 16px",
    borderRadius: 10,
    border: "none",
    background: "var(--accent)",
    color: "#fff",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
  },
  reflTitle: {
    fontSize: 15,
    fontWeight: 700,
    color: "var(--text)",
    marginBottom: 10,
  },
  reflSaved: {
    marginTop: 10,
    padding: "12px 14px",
    borderRadius: 12,
    background: "var(--surface)",
    border: "1px solid var(--accent)",
  },
  reflSummaryBox: {
    marginTop: 10,
    marginBottom: 4,
    padding: "12px 14px",
    borderRadius: 12,
    background: "var(--accent-soft)",
    border: "2px solid var(--accent)",
  },
  reflSummaryHead: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    marginBottom: 8,
  },
  reflSavedHead: {
    fontSize: 14,
    fontWeight: 700,
    color: "var(--accent)",
    marginBottom: 6,
  },
  reflSavedGpa: {
    color: "var(--muted)",
    fontWeight: 600,
  },
  reflSavedMsg: {
    fontSize: 14,
    lineHeight: 1.5,
    color: "var(--text)",
    margin: "0 0 8px",
  },
  reflFocusList: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },
  reflFocusItem: {
    fontSize: 13.5,
    color: "var(--text)",
    fontWeight: 500,
  },
  fypGridSection: {
    fontSize: 13,
    fontWeight: 800,
    color: "var(--accent)",
    textTransform: "uppercase",
    letterSpacing: 0.8,
    padding: "14px 20px 6px",
    background: "var(--assistant-bubble)",
    borderTop: "1px solid var(--border)",
  },
  fypGridCell: {
    padding: "14px 20px",
    borderTop: "1px solid var(--border)",
  },
  fypGridCheck: {
    display: "flex",
    alignItems: "flex-start",
    gap: 11,
    width: "100%",
    background: "none",
    border: "none",
    padding: 0,
    textAlign: "left",
    cursor: "pointer",
    fontSize: 17,
    lineHeight: 1.4,
  },
  fypGridMeta: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 8,
    marginLeft: 30,
  },
  fypGridSelect: {
    padding: "3px 7px",
    borderRadius: 7,
    border: "1px solid var(--border)",
    background: "var(--bg)",
    color: "var(--text)",
    fontSize: 13,
  },
  fypGridFlag: {
    marginRight: 4,
  },
  fypGridFlagBtn: {
    padding: "3px 8px",
    borderRadius: 7,
    border: "1px solid var(--border)",
    background: "var(--bg)",
    fontSize: 13,
    cursor: "pointer",
    opacity: 0.5,
  },
  fypGridRemove: {
    border: "none",
    background: "none",
    color: "var(--muted)",
    fontSize: 20,
    lineHeight: 1,
    cursor: "pointer",
    padding: "0 3px",
  },
  fypGridAdd: {
    padding: "9px 16px 12px",
    borderTop: "1px solid var(--border)",
  },
  fypGridInput: {
    width: "100%",
    padding: "8px 11px",
    borderRadius: 8,
    border: "1px solid var(--border)",
    background: "var(--bg)",
    color: "var(--text)",
    fontSize: 14.5,
  },
  fypRow: { display: "flex", alignItems: "flex-start", gap: 6 },
  fypAddRow: { display: "flex", gap: 8, marginTop: 8 },
  fypNote: { color: "var(--muted)", fontWeight: 400, fontSize: 13 },
  fypCheckpointBadge: {
    display: "inline-block",
    marginRight: 6,
    padding: "1px 7px",
    borderRadius: 999,
    background: "#f3e2cf",
    color: "#b8742a",
    fontSize: 11,
    fontWeight: 700,
  },
  fypFlagBtn: {
    flexShrink: 0,
    alignSelf: "center",
    padding: "2px 6px",
    borderRadius: 999,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    background: "transparent",
    fontSize: 12,
    cursor: "pointer",
    opacity: 0.5,
  },
  fypFlagBtnActive: {
    opacity: 1,
    borderColor: "#b8742a",
    background: "#f3e2cf",
  },
  fypAddPlan: {
    flexShrink: 0,
    alignSelf: "center",
    padding: "3px 10px",
    borderRadius: 999,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--accent)",
    background: "transparent",
    color: "var(--accent)",
    fontSize: 12.5,
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  fypInPlan: {
    flexShrink: 0,
    alignSelf: "center",
    padding: "3px 8px",
    fontSize: 12.5,
    fontWeight: 600,
    color: "var(--muted)",
    whiteSpace: "nowrap",
  },
  fypResBtn: {
    flexShrink: 0,
    alignSelf: "center",
    padding: "3px 10px",
    borderRadius: 999,
    border: "none",
    background: "var(--accent-soft)",
    color: "var(--accent)",
    fontSize: 12.5,
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  fypAdviseBtn: {
    width: "100%",
    marginTop: 6,
    marginBottom: 4,
    padding: "9px 12px",
    borderRadius: 10,
    border: "none",
    background: "var(--accent)",
    color: "#fff",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
  },
  fypCr: { color: "var(--muted)", fontWeight: 400, fontSize: 12.5 },
  fypCourseSelect: {
    flexShrink: 0,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    borderRadius: 8,
    padding: "3px 4px",
    fontSize: 12,
    background: "var(--surface)",
    color: "var(--assistant-text)",
    maxWidth: 92,
  },
  // Plan-tab section nav
  planSectionNav: {
    display: "flex",
    flexWrap: "wrap",
    gap: 6,
    marginBottom: 14,
  },
  planSectionBtn: {
    padding: "7px 12px",
    borderRadius: 999,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    background: "var(--surface)",
    color: "var(--assistant-text)",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  },
  planSectionBtnActive: {
    background: "var(--accent)",
    borderColor: "var(--accent)",
    color: "#fff",
  },
  // Time management
  timeWorkload: {
    margin: "6px 0 8px",
    padding: "8px 12px",
    borderRadius: 10,
    background: "var(--accent-soft)",
    color: "var(--accent)",
    fontSize: 13.5,
    fontWeight: 600,
  },
  taskBudget: {
    margin: "2px 0 10px",
    padding: "8px 12px",
    borderRadius: 10,
    background: "var(--accent-soft)",
    color: "var(--accent)",
    fontSize: 13.5,
    fontWeight: 600,
  },
  // Motivational nudge shown above the day's task list; copy shifts with progress.
  taskCheer: {
    margin: "2px 0 10px",
    padding: "9px 12px",
    borderRadius: 10,
    background: "var(--accent-soft)",
    color: "var(--accent)",
    fontSize: 13.5,
    fontWeight: 600,
    lineHeight: 1.35,
  },
  timeRow: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    marginTop: 4,
    flexWrap: "wrap",
  },
  timeInput: {
    width: 56,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    borderRadius: 8,
    padding: "3px 6px",
    fontSize: 12.5,
    background: "var(--surface)",
    color: "var(--assistant-text)",
  },
  timeDate: {
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    borderRadius: 8,
    padding: "3px 6px",
    fontSize: 12.5,
    background: "var(--surface)",
    color: "var(--assistant-text)",
  },
  timeLabel: { fontSize: 12, color: "var(--muted)" },
  // Split-by-priority control row above the task list.
  budgetSplit: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    flexWrap: "wrap",
    margin: "0 0 10px",
  },
  budgetSplitLabel: { fontSize: 12.5, color: "var(--muted)" },
  budgetSplitBtn: {
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--accent)",
    borderRadius: 999,
    padding: "4px 12px",
    fontSize: 12.5,
    fontWeight: 700,
    cursor: "pointer",
    background: "var(--accent-soft)",
    color: "var(--accent)",
  },
  // Priority badge + title on one line; badge is a tap-to-cycle button.
  taskTitleRow: { display: "flex", alignItems: "center", gap: 8 },
  prioBadge: {
    flex: "0 0 auto",
    borderWidth: 0,
    borderRadius: 999,
    padding: "2px 9px",
    fontSize: 11,
    fontWeight: 800,
    letterSpacing: 0.3,
    textTransform: "uppercase",
    cursor: "pointer",
    lineHeight: 1.4,
  },
  prio_high: { background: "#fde2e1", color: "#c0392b" },
  prio_med: { background: "#fdeecb", color: "#b8860b" },
  prio_low: { background: "#e2eef3", color: "#3a6d86" },
  // "Review your work?" banner
  reviewBanner: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    flexWrap: "wrap",
    padding: "12px 16px",
    borderRadius: 12,
    background: "var(--accent-soft)",
    border: "1px solid var(--accent)",
    marginBottom: 14,
    fontSize: 14.5,
    color: "var(--assistant-text)",
  },
  reviewYes: {
    flexShrink: 0,
    padding: "7px 14px",
    borderRadius: 999,
    border: "none",
    background: "var(--accent)",
    color: "#fff",
    fontSize: 13.5,
    fontWeight: 700,
    cursor: "pointer",
  },
  reviewNo: {
    flexShrink: 0,
    padding: "7px 12px",
    borderRadius: 999,
    border: "none",
    background: "transparent",
    color: "var(--muted)",
    fontSize: 13.5,
    fontWeight: 600,
    cursor: "pointer",
  },
  // Assignment-feedback result
  afbResult: {
    marginTop: 14,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: "var(--border)",
  },
  afbScore: {
    display: "inline-block",
    padding: "5px 14px",
    borderRadius: 999,
    background: "var(--accent)",
    color: "#fff",
    fontSize: 16,
    fontWeight: 800,
  },
  afbOverall: {
    margin: "10px 0 4px",
    fontSize: 15,
    color: "var(--assistant-text)",
    lineHeight: 1.5,
  },
  afbSecHead: {
    fontSize: 12.5,
    fontWeight: 800,
    color: "var(--accent)",
    textTransform: "uppercase",
    letterSpacing: 0.3,
    margin: "12px 0 4px",
  },
  afbLi: {
    fontSize: 14.5,
    color: "var(--assistant-text)",
    lineHeight: 1.5,
    marginBottom: 3,
  },
  afbImproveRow: {
    display: "flex",
    alignItems: "flex-start",
    gap: 8,
    marginBottom: 3,
  },
  afbTrackBtn: {
    flexShrink: 0,
    marginTop: 1,
    padding: "3px 10px",
    borderRadius: 999,
    border: "1px solid var(--accent)",
    background: "transparent",
    color: "var(--accent)",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  notesCopyBtn: {
    float: "right",
    marginTop: -3,
    padding: "3px 10px",
    borderRadius: 999,
    border: "1px solid var(--accent)",
    background: "transparent",
    color: "var(--accent)",
    fontSize: 11.5,
    fontWeight: 600,
    textTransform: "none",
    letterSpacing: 0,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  afbStats: {
    display: "flex",
    flexWrap: "wrap",
    gap: 8,
    margin: "8px 0 2px",
  },
  afbStat: {
    padding: "5px 10px",
    borderRadius: 8,
    background: "var(--assistant-bubble)",
    color: "var(--assistant-text)",
    fontSize: 12.5,
  },
  afbIssue: {
    display: "flex",
    gap: 8,
    alignItems: "flex-start",
    fontSize: 14,
    color: "var(--assistant-text)",
    lineHeight: 1.5,
    marginBottom: 5,
  },
  afbIssueTag: {
    flexShrink: 0,
    padding: "1px 8px",
    borderRadius: 999,
    background: "var(--accent-soft)",
    color: "var(--accent)",
    fontSize: 11,
    fontWeight: 700,
    textTransform: "capitalize",
    marginTop: 2,
  },
  afbIssueText: { color: "var(--muted)", fontStyle: "italic" },
  afbNext: {
    marginTop: 12,
    padding: "10px 12px",
    borderRadius: 10,
    background: "var(--accent-soft)",
    color: "var(--accent)",
    fontSize: 14,
    fontWeight: 600,
  },
  fypJoins: {
    marginTop: 12,
    marginBottom: 4,
    padding: "12px 14px",
    borderRadius: 12,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    background: "var(--surface)",
  },
  fypAlignBox: {
    marginTop: 12,
    marginBottom: 4,
    padding: "12px 14px",
    borderRadius: 12,
    border: "1px solid var(--border)",
    background: "var(--accent-soft)",
  },
  fypAlignList: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
    marginTop: 10,
  },
  fypAlignOverall: {
    fontSize: 14,
    fontStyle: "italic",
    color: "var(--text)",
    lineHeight: 1.5,
    margin: "0 0 2px",
  },
  fypAlignRow: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
    paddingBottom: 8,
    borderBottom: "1px solid var(--border)",
  },
  fypAlignInterest: {
    fontSize: 14,
    fontWeight: 700,
    color: "var(--accent)",
  },
  fypAlignArrow: {
    fontSize: 13.5,
    color: "var(--text)",
    lineHeight: 1.5,
  },
  fypJoinsHead: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  fypJoinsSub: { fontSize: 12.5, color: "var(--muted)", margin: "2px 0 6px" },
  fypJoinRow: {
    display: "flex",
    alignItems: "flex-start",
    gap: 10,
    padding: "9px 0",
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: "var(--border)",
  },
  fypJoinTitle: {
    fontSize: 14.5,
    fontWeight: 600,
    color: "var(--assistant-text)",
  },
  fypJoinYear: { fontSize: 12, color: "var(--accent)", marginTop: 2 },
  fypTextarea: {
    width: "100%",
    minHeight: 72,
    marginTop: 6,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    borderRadius: 10,
    padding: "10px 12px",
    fontSize: 14,
    fontFamily: "inherit",
    background: "var(--surface)",
    color: "var(--assistant-text)",
    resize: "vertical",
    boxSizing: "border-box",
  },
  fypFileInput: {
    display: "block",
    marginTop: 6,
    fontSize: 13,
    color: "var(--assistant-text)",
  },
  fypFileInputHidden: {
    position: "absolute",
    width: 1,
    height: 1,
    padding: 0,
    margin: -1,
    overflow: "hidden",
    clip: "rect(0 0 0 0)",
    whiteSpace: "nowrap",
    border: 0,
  },
  fypUploadRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    flexWrap: "wrap",
    marginTop: 12,
  },
  fypUploadBtn: {
    display: "inline-flex",
    alignItems: "center",
    gap: 7,
    padding: "10px 16px",
    background: "var(--surface)",
    border: "1px solid var(--accent)",
    borderRadius: 12,
    fontSize: 14,
    fontWeight: 600,
    color: "var(--accent)",
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  fypGradeUpload: {
    display: "block",
    marginTop: 12,
    paddingTop: 12,
    borderTop: "1px solid var(--border)",
  },
  fypGradeUploadHead: {
    fontSize: 13.5,
    fontWeight: 700,
    color: "var(--accent)",
  },
  fypGradeUploadHint: {
    fontWeight: 400,
    color: "var(--muted)",
  },
  fypDocList: { display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 },
  fypDocChip: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "4px 6px 4px 10px",
    borderRadius: 999,
    background: "var(--accent-soft)",
    color: "var(--accent)",
    fontSize: 12.5,
    fontWeight: 600,
  },
  fypDocRemove: {
    background: "transparent",
    border: "none",
    color: "var(--accent)",
    fontSize: 16,
    lineHeight: 1,
    cursor: "pointer",
    padding: "0 2px",
  },
  fypCredits: {
    marginTop: 12,
    marginBottom: 4,
    padding: "12px 14px",
    borderRadius: 12,
    background: "var(--accent-soft)",
  },
  fypCreditsHead: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  fypCreditsTitle: { fontSize: 14, fontWeight: 700, color: "var(--accent)" },
  fypCreditsBig: { margin: "6px 0 8px", display: "flex", alignItems: "baseline" },
  fypCreditsEarned: {
    fontSize: 28,
    fontWeight: 800,
    color: "var(--accent)",
    lineHeight: 1,
  },
  fypCreditsOf: { fontSize: 15, color: "var(--muted)", fontWeight: 600 },
  fypStatus: {
    marginTop: 8,
    padding: "6px 10px",
    borderRadius: 8,
    fontSize: 12.5,
    fontWeight: 600,
    lineHeight: 1.35,
  },
  fypStatusOk: { background: "var(--surface)", color: "var(--accent)" },
  fypStatusWarn: { background: "#fbf0e2", color: "#a25a12" },
  fypGpaRow: {
    marginTop: 10,
    display: "flex",
    gap: 8,
  },
  fypGpaItem: {
    flex: 1,
    padding: "8px 10px",
    borderRadius: 10,
    background: "var(--surface)",
    fontSize: 12.5,
    color: "var(--muted)",
    fontWeight: 600,
  },
  fypGpaNum: {
    fontSize: 20,
    fontWeight: 800,
    color: "var(--accent)",
    marginRight: 4,
  },
  fypGpaSub: { color: "var(--muted)", fontWeight: 500 },
  fypProjBox: {
    marginTop: 12,
    paddingTop: 12,
    borderTop: "1px solid var(--border)",
  },
  fypProjHead: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    flexWrap: "wrap",
  },
  fypProjTitle: { fontSize: 13.5, fontWeight: 700, color: "var(--text)" },
  fypProjAssume: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    fontSize: 12.5,
    color: "var(--muted)",
  },
  fypProjSelect: {
    fontSize: 12.5,
    padding: "3px 6px",
    borderRadius: 7,
    border: "1px solid var(--border)",
    background: "var(--surface)",
    color: "var(--text)",
    fontFamily: "inherit",
  },
  fypProjGoalRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    marginTop: 10,
    fontSize: 13,
    color: "var(--assistant-text)",
  },
  fypProjGoalInput: {
    width: 84,
    fontSize: 14,
    padding: "6px 8px",
    borderRadius: 8,
    border: "1px solid var(--border)",
    background: "var(--surface)",
    color: "var(--text)",
    fontFamily: "inherit",
  },
  fypReqLegend: {
    fontSize: 11,
    color: "var(--muted)",
    fontWeight: 500,
    marginBottom: 2,
  },
  fypReqList: {
    marginTop: 10,
    display: "flex",
    flexDirection: "column",
    gap: 7,
  },
  fypReqRow: { display: "flex", alignItems: "center", gap: 8 },
  fypReqSubject: {
    flexShrink: 0,
    width: 120,
    fontSize: 13,
    color: "var(--assistant-text)",
  },
  fypReqBarTrack: {
    position: "relative",
    flex: 1,
    height: 7,
    borderRadius: 6,
    background: "var(--surface)",
    overflow: "hidden",
  },
  fypReqBarFill: { height: "100%", transition: "width 200ms ease" },
  fypReqCount: {
    flexShrink: 0,
    minWidth: 56,
    textAlign: "right",
    fontSize: 12.5,
    fontWeight: 600,
    color: "var(--muted)",
  },
  fypReqInput: {
    flexShrink: 0,
    width: 60,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    borderRadius: 8,
    padding: "6px 8px",
    fontSize: 13,
    background: "var(--surface)",
    color: "var(--assistant-text)",
  },
};
