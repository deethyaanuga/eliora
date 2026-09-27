import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  Vibration,
  View,
} from "react-native";
import { fetch as expoFetch } from "expo/fetch";
import { StatusBar } from "expo-status-bar";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system";
import * as Speech from "expo-speech";
import { API_BASE_URL } from "./api";
import {
  CHECK_IN_CHAT_PROMPT,
  DEFAULT_CHECKIN_TIME,
  Notifications,
  loadCheckInPrefs,
  saveCheckInPrefs,
  syncCheckInRegistration,
  type CheckInPrefs,
} from "./notifications";

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
// Non-video study resources Eliora recommends (sites, books, practice sets…).
// `searched` marks a card whose url is a web search rather than the resource
// itself — the chat route builds one whenever the model had no URL it was sure
// of, so we label the card honestly instead of promising the real page.
type ResourceKind = "site" | "book" | "practice" | "article" | "course" | "tool";
type ResourceRec = {
  kind: ResourceKind;
  title: string;
  note?: string;
  url: string;
  searched?: boolean;
};
const RESOURCE_META: Record<
  ResourceKind,
  { label: string; emoji: string; color: string }
> = {
  site: { label: "Website", emoji: "🌐", color: "#2f6fd0" },
  book: { label: "Book", emoji: "📕", color: "#b0472f" },
  practice: { label: "Practice", emoji: "📝", color: "#1f8a5f" },
  article: { label: "Article", emoji: "📄", color: "#5a5f6b" },
  course: { label: "Course", emoji: "🎓", color: "#7b4bd0" },
  tool: { label: "Tool", emoji: "🧰", color: "#c07a1f" },
};
// A flashcard's learning format (mirrors FlashcardStyle in @eliora/shared).
type FlashcardStyle = "basic" | "reversed" | "qa" | "cloze" | "example";
type Flashcard = {
  front: string;
  back: string;
  style?: FlashcardStyle;
  hint?: string;
  topic?: string;
};
// A card once it lives in a saved deck (mirrors DeckCard in @eliora/shared):
// it has an identity, and we know who wrote it. Eliora only DRAFTS a deck —
// the learner is expected to correct it, so an AI card they've fixed stops
// counting as hers.
type DeckCard = Flashcard & {
  id: string;
  source: "ai" | "you";
  edited?: boolean;
  starred?: boolean;
};
// A saved deck (mirrors FlashcardDeck in @eliora/shared). Named apart from the
// <FlashcardDeck> viewer component below.
type SavedDeck = {
  id: string;
  title: string;
  cards: DeckCard[];
  createdAt: number;
  updatedAt: number;
  style?: FlashcardStyle;
  difficulty?: QuizDifficulty;
  fromMaterial?: string;
  known?: string[];
  learning?: string[];
};
// UI labels per style: what to call each side of the card, plus a picker label.
const FLASHCARD_STYLES: {
  key: FlashcardStyle;
  label: string;
  emoji: string;
  front: string;
  back: string;
}[] = [
  { key: "basic", label: "Term → Definition", emoji: "🃏", front: "TERM", back: "ANSWER" },
  { key: "reversed", label: "Definition → Term", emoji: "🔄", front: "DEFINITION", back: "TERM" },
  { key: "qa", label: "Question & Answer", emoji: "❓", front: "QUESTION", back: "ANSWER" },
  { key: "cloze", label: "Fill in the blank", emoji: "✏️", front: "FILL IN THE BLANK", back: "ANSWER" },
  { key: "example", label: "Concept → Example", emoji: "💡", front: "CONCEPT", back: "EXAMPLE" },
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
type Message = {
  role: "user" | "assistant";
  content: string;
  videos?: Video[];
  socials?: SocialRec[];
  resources?: ResourceRec[];
  flashcards?: Flashcard[];
  quiz?: QuizQuestion[];
};
type Chat = {
  id: string;
  title: string;
  messages: Message[];
  named?: boolean; // true once the user renames it (stops auto-titling)
  folderId?: string; // which chat folder it belongs to (if any)
};
type ChatFolder = { id: string; name: string };

let chatCounter = 0;
function newChatId(): string {
  chatCounter += 1;
  return `c${Date.now().toString(36)}-${chatCounter}`;
}
function chatTitle(msgs: Message[]): string {
  const u = msgs.find((m) => m.role === "user");
  if (u) {
    const t = u.content.trim().replace(/\s+/g, " ");
    return t.length > 20 ? t.slice(0, 20) + "…" : t || "New chat";
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
type EventKind =
  | "exam"
  | "final"
  | "quiz"
  | "assignment"
  | "project"
  | "other";
type StudyEvent = { id: string; title: string; date: string; kind?: EventKind };
// One step of an assignment's "break it down" checklist (mirrors TaskStep in
// @eliora/shared — mobile doesn't bundle the shared package, so it keeps a copy).
type TaskStep = {
  title: string;
  estMin: number;
  detail?: string;
  done: boolean;
  due?: string;
};
type Assignment = {
  id: string;
  title: string;
  subject?: string;
  due?: string;
  concern?: string; // what the learner is worried about / stuck on
  done: boolean;
  steps?: TaskStep[]; // "Break it down" checklist — the steps this actually takes
};
// A SMART goal the learner sets (Specific, Measurable, Achievable, Relevant,
// Time-bound). Only `specific` is required; `target`/`current` drive a progress bar.
// `due` is the day the step is meant to happen (YYYY-MM-DD, set on the web
// side); `detail` is the notes line under it. Both are kept here so a goal that
// round-trips through the phone doesn't come back stripped of them.
type GoalTask = {
  title: string;
  done: boolean;
  due?: string;
  detail?: string;
};
type SmartGoal = {
  id: string;
  specific: string;
  measurable?: string;
  achievable?: string;
  relevant?: string;
  timeBound?: string; // YYYY-MM-DD
  subject?: string;
  target?: number;
  current?: number;
  statement?: string; // AI-composed one-sentence version of the answers
  tasks?: GoalTask[]; // checklist of steps to achieve the goal
  done: boolean;
};

const STORAGE_KEY = "eliora-chat"; // legacy single conversation (migrated)
const CHATS_KEY = "eliora-chats";
const ACTIVE_KEY = "eliora-active-chat";
const CHAT_FOLDERS_KEY = "eliora-chat-folders";
const PROFILE_KEY = "eliora-profile";
const PLAN_KEY = "eliora-plan";
const EVENTS_KEY = "eliora-events";
const MISSED_KEY = "eliora-missed";
const SUBJECTS_KEY = "eliora-subjects";
const ASSIGNMENTS_KEY = "eliora-assignments";
const GOALS_KEY = "eliora-goals";
const REM_DISMISSED_KEY = "eliora-rem-dismissed";
const SCHEDULE_KEY = "eliora-schedule"; // today's day plan (reset each new day)
const HOMETIME_KEY = "eliora-hometime"; // hour (24h) the learner gets home
const DECKS_KEY = "eliora-decks"; // saved flashcard decks

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
// Grade / year is a number, so it's a pick-one instead of free text.
const GRADE_YEAR_OPTIONS = ["Grade 9", "Grade 10", "Grade 11", "Grade 12"];
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

// Sent when the learner taps the "Study tip" study tool. Asks for ONE quick,
// proven technique tied to what they're working on. Mirrors studyTipPrompt in
// @eliora/shared (mobile doesn't bundle the shared package, so it keeps a copy).
function studyTipPrompt(topic?: string): string {
  const t = topic?.trim();
  return t
    ? `Give me ONE quick, practical study tip for working on "${t}" right now — ` +
        `a proven technique I can use this minute, matched to how I learn and ` +
        `what I struggle with. Keep it to a sentence or two.`
    : "Give me ONE quick, practical study tip I can use right now — a proven " +
        "technique matched to how I learn and what I struggle with. Keep it to a " +
        "sentence or two.";
}

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
  assignment: "#6b6280",
  project: "#7a5c9e",
  other: "#6b6280",
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

// A daily 9am–9pm time-block schedule. `blocks` maps an hour (9…20) to what the
// learner plans to do then; stamped with the date so it starts fresh each day.
type ScheduleKind = "study" | "break" | "class" | "other";
type ScheduleBlock = { text: string; kind: ScheduleKind };
type DaySchedule = { date: string; blocks: Record<number, ScheduleBlock> };
const SCHEDULE_HOURS = [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
const SCHEDULE_KINDS: {
  key: ScheduleKind;
  emoji: string;
  label: string;
  color: string;
}[] = [
  { key: "study", emoji: "📚", label: "Study", color: "#7b4bd0" },
  { key: "break", emoji: "☕", label: "Break", color: "#d98a2b" },
  { key: "class", emoji: "🏫", label: "Class", color: "#3a6ea5" },
  { key: "other", emoji: "📝", label: "Other", color: "#8a8a8a" },
];
const scheduleKind = (k: ScheduleKind) =>
  SCHEDULE_KINDS.find((x) => x.key === k) ?? SCHEDULE_KINDS[0];
// Default length for a per-task focus countdown (a Pomodoro sprint).
const TIMER_DEFAULT_MIN = 25;
// Local YYYY-MM-DD for today (not UTC — a day plan is a local-day thing).
function todayISO(): string {
  const d = new Date();
  const p = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
// Give an ordered list of steps a day each, spread evenly over the run-up to a
// deadline (mirrors paceStepDates in the web app). Undefined for every step
// when there's no deadline to work back from, or it's already passed.
function paceStepDates(
  count: number,
  targetISO?: string,
): (string | undefined)[] {
  const out: (string | undefined)[] = Array.from({ length: count });
  const today = todayISO();
  if (!count || !targetISO || !/^\d{4}-\d{2}-\d{2}$/.test(targetISO))
    return out;
  if (targetISO <= today) return out;
  const dayOf = (iso: string) => new Date(`${iso}T00:00:00`);
  const isoOf = (d: Date) => {
    const p = (n: number) => n.toString().padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  const span = Math.round(
    (dayOf(targetISO).getTime() - dayOf(today).getTime()) / 86_400_000,
  );
  const last = span > count ? span - 1 : span;
  for (let i = 0; i < count; i++) {
    const offset = Math.max(1, Math.round(((i + 1) * last) / count));
    const d = dayOf(today);
    d.setDate(d.getDate() + offset);
    out[i] = isoOf(d);
  }
  return out;
}
// "9:00 AM", "1:00 PM" … for an hour in 24h form.
function hourLabel(h: number): string {
  const period = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:00 ${period}`;
}
// "25:00" / "4:09" — seconds → mm:ss for a countdown display.
function fmtTimer(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function renderContent(text: string) {
  // Match Markdown links [label](url) OR bare http(s) URLs.
  const re = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s]+)/g;
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  const linkEl = (href: string, label: string, k: number) => (
    <Text key={k} style={styles.link} onPress={() => Linking.openURL(href)}>
      {label}
    </Text>
  );
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    if (m[1]) {
      nodes.push(linkEl(m[2], m[1], key++));
    } else {
      let url = m[3];
      const trail = url.match(/[).,;:!?\]]+$/);
      let tail = "";
      if (trail) {
        tail = trail[0];
        url = url.slice(0, url.length - tail.length);
      }
      nodes.push(linkEl(url, url, key++));
      if (tail) nodes.push(tail);
    }
    last = re.lastIndex;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

// Eliora writes in markdown — headings, bullets, numbered steps, **bold**. Run
// through renderContent alone those come out as literal #s and asterisks, so
// lay the lines out as real blocks instead. Same subset the web app renders.
function renderMessageBody(text: string) {
  const blocks: React.ReactNode[] = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) {
      // Skip a leading blank so the bubble doesn't open with dead space.
      if (blocks.length) blocks.push(<View key={i} style={{ height: 6 }} />);
      return;
    }
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      blocks.push(
        <Text
          key={i}
          style={[
            m[1].length <= 2 ? styles.mdH2 : styles.mdH3,
            blocks.length === 0 && { marginTop: 0 },
          ]}
        >
          {renderInlineBold(m[2])}
        </Text>,
      );
    } else if ((m = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/))) {
      const mark = m[2] === "-" || m[2] === "*" ? "•" : m[2];
      blocks.push(
        <View
          key={i}
          style={[styles.mdBullet, { marginLeft: Math.min(m[1].length, 6) * 4 }]}
        >
          <Text style={styles.mdBulletMark}>{mark}</Text>
          <Text style={[styles.assistantText, { flex: 1 }]}>
            {renderInlineBold(m[3])}
          </Text>
        </View>,
      );
    } else {
      blocks.push(
        <Text key={i} style={[styles.assistantText, styles.mdP]}>
          {renderInlineBold(line)}
        </Text>,
      );
    }
  });
  return <View>{blocks}</View>;
}

// **bold** and ==highlight== inside one line, with links still tappable.
function renderInlineBold(text: string) {
  const out: React.ReactNode[] = [];
  text.split(/(\*\*[^*]+\*\*|==[^=]+==)/g).forEach((part, i) => {
    if (!part) return;
    let m: RegExpMatchArray | null;
    if ((m = part.match(/^\*\*([^*]+)\*\*$/)))
      out.push(
        <Text key={i} style={styles.mdBold}>
          {renderContent(m[1])}
        </Text>,
      );
    else if ((m = part.match(/^==([^=]+)==$/)))
      out.push(
        <Text key={i} style={styles.mdMark}>
          {renderContent(m[1])}
        </Text>,
      );
    else out.push(<Text key={i}>{renderContent(part)}</Text>);
  });
  return out;
}

function VideoCards({ videos }: { videos: Video[] }) {
  return (
    <View style={styles.videoWrap}>
      {videos.map((v) => (
        <TouchableOpacity
          key={v.videoId}
          style={styles.videoCard}
          onPress={() => Linking.openURL(v.url)}
          accessibilityLabel={`Open video: ${v.title}`}
        >
          <Image
            source={{ uri: `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg` }}
            style={styles.videoThumb}
          />
          <View style={styles.videoMeta}>
            <Text style={styles.videoTitle} numberOfLines={2}>
              {v.title}
            </Text>
            <Text style={styles.videoChannel} numberOfLines={1}>
              {v.channel}
            </Text>
          </View>
        </TouchableOpacity>
      ))}
    </View>
  );
}

// Short-form recs (TikTok / YouTube Shorts / Instagram Reels). Each card opens
// a search on that platform rather than playing a specific clip.
function SocialCards({ socials }: { socials: SocialRec[] }) {
  return (
    <View style={styles.socialWrap}>
      {socials.map((s, i) => {
        const meta = SOCIAL_META[s.platform] ?? SOCIAL_META.youtube;
        return (
          <TouchableOpacity
            key={`${s.platform}-${i}`}
            style={styles.socialCard}
            onPress={() => Linking.openURL(s.url)}
            accessibilityLabel={`Open ${meta.label} search: ${s.title}`}
          >
            <View style={[styles.socialBadge, { backgroundColor: meta.color }]}>
              <Text style={styles.socialBadgeText}>
                {meta.emoji} {meta.label}
              </Text>
            </View>
            <Text style={styles.socialTitle} numberOfLines={2}>
              {s.title}
            </Text>
            {!!s.note && (
              <Text style={styles.socialNote} numberOfLines={2}>
                {s.note}
              </Text>
            )}
            <Text style={styles.socialOpen}>Open on {meta.label} →</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

// Study resources that aren't video — sites, books, practice sets, articles.
// Rendered from the chat stream's {type:"resources"} event.
function ResourceCards({ resources }: { resources: ResourceRec[] }) {
  return (
    <View style={styles.resourceWrap}>
      <Text style={styles.resourceHeader}>📚 Resources for this</Text>
      {resources.map((r, i) => {
        const meta = RESOURCE_META[r.kind] ?? RESOURCE_META.site;
        return (
          <TouchableOpacity
            key={`${r.kind}-${i}`}
            style={styles.resourceCard}
            onPress={() => Linking.openURL(r.url)}
            accessibilityLabel={`Open ${meta.label}: ${r.title}`}
          >
            <View style={styles.resourceTopRow}>
              <View
                style={[styles.resourceBadge, { backgroundColor: meta.color }]}
              >
                <Text style={styles.resourceBadgeText}>
                  {meta.emoji} {meta.label}
                </Text>
              </View>
              <Text style={styles.resourceTitle} numberOfLines={2}>
                {r.title}
              </Text>
            </View>
            {!!r.note && (
              <Text style={styles.resourceNote} numberOfLines={3}>
                {r.note}
              </Text>
            )}
            <Text style={styles.resourceOpen}>
              {r.searched ? "Search for it →" : "Open →"}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
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
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <Text style={styles.cardClass} numberOfLines={1}>
          {profile.klass}
          {profile.name?.trim() ? `  ·  ${profile.name.trim()}` : ""}
        </Text>
        <View style={{ flexDirection: "row", gap: 14 }}>
          {rows.length > 0 && (
            <Text style={styles.linkBtn} onPress={() => setOpen((o) => !o)}>
              {open ? "Hide" : "Details"}
            </Text>
          )}
          <Text style={styles.linkBtn} onPress={onEdit}>
            Edit
          </Text>
        </View>
      </View>
      {open &&
        rows.map(([label, val]) => (
          <Text key={label} style={styles.cardRow}>
            <Text style={styles.cardLabel}>{label}: </Text>
            {val}
          </Text>
        ))}
    </View>
  );
}

// A per-assignment "what are you worried about?" note. Holds its own draft and
// commits on blur so Eliora sees the concern in her context and coaches around it.
function ConcernField({
  value,
  onCommit,
}: {
  value?: string;
  onCommit: (concern: string) => void;
}) {
  const [draft, setDraft] = useState(value ?? "");
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setDraft(value ?? "");
  }, [value, editing]);

  if (!editing && !value) {
    return (
      <TouchableOpacity onPress={() => setEditing(true)}>
        <Text style={styles.concernAdd}>💭 Add a concern</Text>
      </TouchableOpacity>
    );
  }
  return (
    <View style={styles.concernRow}>
      <Text style={styles.concernIcon}>💭</Text>
      <TextInput
        style={styles.concernInput}
        value={draft}
        onChangeText={setDraft}
        onFocus={() => setEditing(true)}
        onBlur={() => {
          setEditing(false);
          if ((draft.trim() || "") !== (value ?? "")) onCommit(draft);
        }}
        placeholder="What's worrying you about this?"
        placeholderTextColor="#9b93b3"
        returnKeyType="done"
      />
    </View>
  );
}

// The day as it reads on a step's date chip — "Today"/"Tomorrow" rather than
// making you work out what the 24th is. Matches the web side.
function chipDay(iso: string, today: string) {
  if (iso === today) return "Today";
  const d = new Date(`${iso}T00:00:00`);
  const t = new Date(`${today}T00:00:00`);
  const days = Math.round((d.getTime() - t.getTime()) / 86400000);
  if (days === 1) return "Tomorrow";
  if (days === -1) return "Yesterday";
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(d.getFullYear() === t.getFullYear() ? {} : { year: "numeric" }),
  });
}

// One step in a goal's checklist, drawn the way Google Tasks draws a task:
// round tick box, title, grey details line, then the day as a chip. The day
// itself is set on the web side — there's no native date picker in this app —
// so here it's shown, not edited.
function ChecklistRow({
  task,
  onToggle,
  onSetDetail,
  onHelp,
}: {
  task: GoalTask;
  onToggle: () => void;
  onSetDetail: (detail: string) => void;
  onHelp: () => void;
}) {
  const today = todayISO();
  const [draft, setDraft] = useState(task.detail ?? "");
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setDraft(task.detail ?? "");
  }, [task.detail, editing]);
  const overdue = !task.done && !!task.due && task.due < today;
  return (
    <View style={styles.gtRow}>
      <TouchableOpacity
        style={[styles.gtCheck, task.done && styles.gtCheckDone]}
        onPress={onToggle}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: task.done }}
      >
        {task.done && <Text style={styles.gtCheckMark}>✓</Text>}
      </TouchableOpacity>
      <View style={styles.gtBody}>
        <View style={styles.gtTitleLine}>
          <Text style={[styles.gtTitle, task.done && styles.gtTitleDone]}>
            {task.title}
          </Text>
          {!task.done && (
            <TouchableOpacity style={styles.goalTaskHelp} onPress={onHelp}>
              <Text style={styles.goalTaskHelpText}>Help</Text>
            </TouchableOpacity>
          )}
        </View>
        {editing || task.detail ? (
          <TextInput
            style={styles.gtDetailInput}
            value={draft}
            onChangeText={setDraft}
            onFocus={() => setEditing(true)}
            onBlur={() => {
              setEditing(false);
              if (draft.trim() !== (task.detail ?? "")) onSetDetail(draft);
            }}
            placeholder="Details"
            placeholderTextColor="#9b93b3"
            multiline
          />
        ) : (
          <TouchableOpacity onPress={() => setEditing(true)}>
            <Text style={[styles.gtDetail, styles.gtDetailEmpty]}>
              Add details
            </Text>
          </TouchableOpacity>
        )}
        {!!task.due && (
          <View style={styles.gtChips}>
            <View style={[styles.gtChip, overdue && styles.gtChipOverdue]}>
              <Text
                style={[styles.gtChipText, overdue && styles.gtChipTextOverdue]}
              >
                ▤ {chipDay(task.due, today)}
              </Text>
            </View>
          </View>
        )}
      </View>
    </View>
  );
}

// One row of an assignment's "break it down" checklist.
function StepRow({ step, onToggle }: { step: TaskStep; onToggle: () => void }) {
  const today = todayISO();
  const [showDetail, setShowDetail] = useState(false);
  const overdue = !step.done && !!step.due && step.due < today;
  const fmtMin = (m: number) =>
    m >= 60 ? `${Math.round((m / 60) * 10) / 10} hr` : `${m} min`;
  return (
    <View style={styles.gtRow}>
      <TouchableOpacity
        style={[styles.gtCheck, step.done && styles.gtCheckDone]}
        onPress={onToggle}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: step.done }}
      >
        {step.done && <Text style={styles.gtCheckMark}>✓</Text>}
      </TouchableOpacity>
      <View style={styles.gtBody}>
        <View style={styles.gtTitleLine}>
          <Text style={[styles.gtTitle, step.done && styles.gtTitleDone]}>
            {step.title}
          </Text>
          <Text style={styles.stepMin}>{fmtMin(step.estMin)}</Text>
        </View>
        {step.detail &&
          (showDetail ? (
            <Text style={styles.gtDetail}>{step.detail}</Text>
          ) : (
            <TouchableOpacity onPress={() => setShowDetail(true)}>
              <Text style={[styles.gtDetail, styles.gtDetailEmpty]}>
                what this means
              </Text>
            </TouchableOpacity>
          ))}
        {!!step.due && (
          <View style={styles.gtChips}>
            <View style={[styles.gtChip, overdue && styles.gtChipOverdue]}>
              <Text
                style={[styles.gtChipText, overdue && styles.gtChipTextOverdue]}
              >
                ▤ {chipDay(step.due, today)}
              </Text>
            </View>
          </View>
        )}
      </View>
    </View>
  );
}

function AssignmentsPanel({
  assignments,
  subjects,
  onAdd,
  onToggle,
  onSetConcern,
  onRemove,
  onBreakDown,
  onToggleStep,
  onClearSteps,
  breakingAssignmentId,
}: {
  assignments: Assignment[];
  subjects: string[];
  onAdd: (a: { title: string; subject?: string; due?: string }) => void;
  onToggle: (id: string) => void;
  onSetConcern: (id: string, concern: string) => void;
  onRemove: (id: string) => void;
  onBreakDown: (a: Assignment) => void;
  onToggleStep: (id: string, index: number) => void;
  onClearSteps: (id: string) => void;
  breakingAssignmentId: string | null;
}) {
  const [title, setTitle] = useState("");
  const [subject, setSubject] = useState("");
  const open = assignments.filter((a) => !a.done).length;
  const sorted = [...assignments].sort(
    (a, b) => Number(a.done) - Number(b.done),
  );

  function add() {
    if (!title.trim()) return;
    onAdd({ title, subject: subject || undefined });
    setTitle("");
  }

  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <Text style={styles.cardClass}>📌 Today's assignments</Text>
        <Text style={styles.subjectsCount}>{open} to do</Text>
      </View>
      <View style={styles.assignAddRow}>
        <TextInput
          style={styles.assignInput}
          value={title}
          onChangeText={setTitle}
          placeholder="Add an assignment…"
          placeholderTextColor="#9b93b3"
          onSubmitEditing={add}
          returnKeyType="done"
        />
        <TouchableOpacity style={styles.assignAddBtn} onPress={add}>
          <Text style={styles.assignAddBtnText}>Add</Text>
        </TouchableOpacity>
      </View>
      <TextInput
        style={[styles.assignInput, { marginTop: 8 }]}
        value={subject}
        onChangeText={setSubject}
        placeholder="Subject (optional)"
        placeholderTextColor="#9b93b3"
      />
      {subjects.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ marginTop: 8 }}
        >
          <View style={styles.assignSubjRow}>
            {subjects.map((s) => (
              <TouchableOpacity
                key={s}
                style={[
                  styles.assignSubjChip,
                  subject === s && styles.assignSubjChipActive,
                ]}
                onPress={() => setSubject(s)}
              >
                <Text
                  style={[
                    styles.assignSubjChipText,
                    subject === s && styles.assignSubjChipTextActive,
                  ]}
                >
                  {s}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </ScrollView>
      )}
      {sorted.length === 0 ? (
        <Text style={styles.assignEmpty}>
          Nothing here yet. Add what's due and I'll help you knock it out.
        </Text>
      ) : (
        sorted.map((a) => (
          <View key={a.id} style={styles.assignItem}>
            <TouchableOpacity
              style={[styles.assignCheck, a.done && styles.assignCheckDone]}
              onPress={() => onToggle(a.id)}
            >
              {a.done && <Text style={styles.assignCheckMark}>✓</Text>}
            </TouchableOpacity>
            <View style={{ flex: 1 }}>
              <Text style={a.done ? styles.assignTitleDone : styles.assignTitle}>
                {a.title}
              </Text>
              {(a.subject || a.due) && (
                <Text style={styles.assignMeta}>
                  {a.subject}
                  {a.subject && a.due ? " · " : ""}
                  {a.due ? `due ${a.due}` : ""}
                </Text>
              )}
              {!a.done && (
                <ConcernField
                  value={a.concern}
                  onCommit={(c) => onSetConcern(a.id, c)}
                />
              )}
              {a.steps && a.steps.length > 0 && (
                <View style={styles.goalTasks}>
                  <Text style={styles.goalTasksHead}>
                    STEPS · {a.steps.filter((s) => s.done).length}/
                    {a.steps.length}
                  </Text>
                  {a.steps.map((s, i) => (
                    <StepRow
                      key={i}
                      step={s}
                      onToggle={() => onToggleStep(a.id, i)}
                    />
                  ))}
                </View>
              )}
              {!a.done && (
                <View style={styles.goalBreakRow}>
                  <TouchableOpacity
                    style={[styles.goalBreakBtn, { marginTop: 0, marginLeft: 0 }]}
                    onPress={() => onBreakDown(a)}
                    disabled={breakingAssignmentId === a.id}
                  >
                    <Text style={styles.goalBreakBtnText}>
                      {breakingAssignmentId === a.id
                        ? "Breaking it down…"
                        : a.steps && a.steps.length
                          ? "↻ Redo steps"
                          : "✂️ Break it down"}
                    </Text>
                  </TouchableOpacity>
                  {a.steps && a.steps.length > 0 && (
                    <TouchableOpacity onPress={() => onClearSteps(a.id)}>
                      <Text style={styles.goalBreakClear}>Clear</Text>
                    </TouchableOpacity>
                  )}
                </View>
              )}
            </View>
            <TouchableOpacity onPress={() => onRemove(a.id)}>
              <Text style={styles.assignRemove}>×</Text>
            </TouchableOpacity>
          </View>
        ))
      )}
    </View>
  );
}

// A guided SMART-goal builder (Specific, Measurable, Achievable, Relevant,
// Time-bound). Only the goal itself is required.
function GoalBuilder({
  profile,
  onSave,
  onCancel,
}: {
  profile: LearnerProfile | null;
  onSave: (g: Omit<SmartGoal, "id" | "done">) => void;
  onCancel: () => void;
}) {
  const [specific, setSpecific] = useState("");
  const [measurable, setMeasurable] = useState("");
  const [achievable, setAchievable] = useState("");
  const [relevant, setRelevant] = useState("");
  const [timeBound, setTimeBound] = useState("");
  const [subject, setSubject] = useState("");
  const [target, setTarget] = useState("");
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
      timeBound: /^\d{4}-\d{2}-\d{2}$/.test(timeBound.trim())
        ? timeBound.trim()
        : undefined,
      subject: subject || undefined,
      target: Number.isFinite(t) && t > 0 ? t : undefined,
    };
    // Ask the AI to turn the survey answers into one polished goal sentence.
    setSaving(true);
    let statement: string | undefined;
    try {
      const res = await fetch(`${API_BASE_URL}/api/goal`, {
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
    value: string,
    setValue: (s: string) => void,
    placeholder: string,
    numeric?: boolean,
  ) => (
    <View style={styles.goalField}>
      <View style={styles.goalFieldLabel}>
        <Text style={styles.goalLetter}>{letter}</Text>
        <Text style={styles.goalFieldLabelText}>{label}</Text>
      </View>
      <TextInput
        style={styles.assignInput}
        value={value}
        onChangeText={setValue}
        placeholder={placeholder}
        placeholderTextColor="#9b93b3"
        keyboardType={numeric ? "number-pad" : "default"}
      />
    </View>
  );
  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <Text style={styles.cardClass}>🌟 New SMART goal</Text>
      </View>
      {field(
        "S",
        "Specific — what do you want to achieve? *",
        specific,
        setSpecific,
        "e.g. Get a B+ on the Unit 4 test",
      )}
      {field(
        "M",
        "Measurable — how will you know?",
        measurable,
        setMeasurable,
        "e.g. Score 85%+ on the practice test",
      )}
      {field(
        "A",
        "Achievable — a realistic first step?",
        achievable,
        setAchievable,
        "e.g. Study 25 min a day",
      )}
      {field(
        "R",
        "Relevant — why does it matter?",
        relevant,
        setRelevant,
        "e.g. I want college credit",
      )}
      {field(
        "T",
        "Time-bound — by when? (YYYY-MM-DD)",
        timeBound,
        setTimeBound,
        "e.g. 2026-06-30",
      )}
      {field(
        "#",
        "Target number (optional)",
        target,
        setTarget,
        "e.g. 5",
        true,
      )}
      <View style={styles.classSurveyActions}>
        <TouchableOpacity style={styles.classSurveyCancel} onPress={onCancel}>
          <Text style={styles.classSurveyCancelText}>Cancel</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.assignAddBtn, !canSave && { opacity: 0.5 }]}
          disabled={!canSave}
          onPress={save}
        >
          <Text style={styles.assignAddBtnText}>
            {saving ? "Polishing…" : "Save goal"}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// The learner's SMART goals — each with progress, deadline, and the SMART
// breakdown.
function GoalsPanel({
  goals,
  profile,
  onAdd,
  onStep,
  onToggle,
  onRemove,
  onBreakDown,
  onToggleTask,
  onSetTaskDetail,
  onHelpTask,
  breakingGoalId,
}: {
  goals: SmartGoal[];
  profile: LearnerProfile | null;
  onAdd: (g: Omit<SmartGoal, "id" | "done">) => void;
  onStep: (id: string, delta: number) => void;
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
  onBreakDown: (g: SmartGoal) => void;
  onToggleTask: (goalId: string, index: number) => void;
  onSetTaskDetail: (goalId: string, index: number, detail: string) => void;
  onHelpTask: (goal: SmartGoal, taskTitle: string) => void;
  breakingGoalId: string | null;
}) {
  const [building, setBuilding] = useState(false);
  const active = goals.filter((g) => !g.done).length;
  const sorted = [...goals].sort((a, b) => Number(a.done) - Number(b.done));
  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <Text style={styles.cardClass}>🌟 Goals</Text>
        {goals.length > 0 && (
          <Text style={styles.subjectsCount}>{active} active</Text>
        )}
      </View>
      {sorted.length === 0 && !building && (
        <Text style={styles.assignEmpty}>
          Set a goal to aim for. Make it SMART: Specific, Measurable, Achievable,
          Relevant, Time-bound.
        </Text>
      )}
      {sorted.map((g) => {
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
        const over = g.timeBound && !g.done && daysUntil(g.timeBound) < 0;
        return (
          <View key={g.id} style={styles.goalItem}>
            <View style={styles.goalTop}>
              <TouchableOpacity
                style={[styles.assignCheck, g.done && styles.assignCheckDone]}
                onPress={() => onToggle(g.id)}
              >
                {g.done && <Text style={styles.assignCheckMark}>✓</Text>}
              </TouchableOpacity>
              <View style={{ flex: 1 }}>
                <Text
                  style={g.done ? styles.assignTitleDone : styles.goalTitle}
                >
                  {g.statement?.trim() || g.specific}
                </Text>
                {/* The AI sentence already weaves in measure/why/step, so only
                    show the breakdown when there's no statement. */}
                {!g.statement?.trim() && !!meta && (
                  <Text style={styles.assignMeta}>{meta}</Text>
                )}
                {!g.statement?.trim() && !!g.achievable && (
                  <Text style={styles.assignMeta}>Step: {g.achievable}</Text>
                )}
                {!!g.statement?.trim() && !!g.subject && (
                  <Text style={styles.assignMeta}>{g.subject}</Text>
                )}
              </View>
              {!!g.timeBound && (
                <Text style={[styles.goalDue, over && styles.goalDueOver]}>
                  {countdown(g.timeBound)}
                </Text>
              )}
              <TouchableOpacity onPress={() => onRemove(g.id)}>
                <Text style={styles.assignRemove}>×</Text>
              </TouchableOpacity>
            </View>
            {pct != null && (
              <View style={styles.goalProgressRow}>
                <TouchableOpacity
                  style={styles.goalStep}
                  onPress={() => onStep(g.id, -1)}
                >
                  <Text style={styles.goalStepText}>−</Text>
                </TouchableOpacity>
                <View style={styles.goalTrack}>
                  <View style={[styles.goalFill, { width: `${pct}%` }]} />
                </View>
                <TouchableOpacity
                  style={styles.goalStep}
                  onPress={() => onStep(g.id, 1)}
                >
                  <Text style={styles.goalStepText}>+</Text>
                </TouchableOpacity>
                <Text style={styles.goalCount}>
                  {g.current ?? 0}/{g.target}
                </Text>
              </View>
            )}
            {g.tasks && g.tasks.length > 0 && (
              <View style={styles.goalTasks}>
                <Text style={styles.goalTasksHead}>
                  STEPS TO GET THERE · {g.tasks.filter((t) => t.done).length}/
                  {g.tasks.length}
                </Text>
                {g.tasks.map((t, i) => (
                  <ChecklistRow
                    key={i}
                    task={t}
                    onToggle={() => onToggleTask(g.id, i)}
                    onSetDetail={(d) => onSetTaskDetail(g.id, i, d)}
                    onHelp={() => onHelpTask(g, t.title)}
                  />
                ))}
              </View>
            )}
            {!g.done && (
              <TouchableOpacity
                style={styles.goalBreakBtn}
                onPress={() => onBreakDown(g)}
                disabled={breakingGoalId === g.id}
              >
                <Text style={styles.goalBreakBtnText}>
                  {breakingGoalId === g.id
                    ? "Breaking into steps…"
                    : g.tasks && g.tasks.length
                      ? "↻ Redo steps"
                      : "🪜 Break into steps"}
                </Text>
              </TouchableOpacity>
            )}
          </View>
        );
      })}
      {building ? (
        <GoalBuilder
          profile={profile}
          onCancel={() => setBuilding(false)}
          onSave={(g) => {
            onAdd(g);
            setBuilding(false);
          }}
        />
      ) : (
        <TouchableOpacity
          style={styles.goalNewBtn}
          onPress={() => setBuilding(true)}
        >
          <Text style={styles.goalNewBtnText}>＋ New goal</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

function ClassSurvey({
  onSubmit,
  onCancel,
}: {
  onSubmit: (d: { klass: string; struggles: string; goal: string }) => void;
  onCancel: () => void;
}) {
  const [klass, setKlass] = useState("");
  const [struggles, setStruggles] = useState("");
  const [goal, setGoal] = useState("");
  const canSubmit = klass.trim().length > 0;
  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <Text style={styles.cardClass}>➕ Add a class you need help with</Text>
      </View>
      <Text style={styles.classSurveyLabel}>Which class? *</Text>
      <TextInput
        style={styles.assignInput}
        value={klass}
        onChangeText={setKlass}
        placeholder="e.g. Chemistry, Algebra 2, Spanish 3"
        placeholderTextColor="#9b93b3"
      />
      <Text style={styles.classSurveyLabel}>
        What do you struggle with in this class?
      </Text>
      <TextInput
        style={styles.assignInput}
        value={struggles}
        onChangeText={setStruggles}
        placeholder="e.g. balancing equations, word problems"
        placeholderTextColor="#9b93b3"
      />
      <Text style={styles.classSurveyLabel}>What do you want to get done?</Text>
      <TextInput
        style={styles.assignInput}
        value={goal}
        onChangeText={setGoal}
        placeholder="e.g. pass the unit test Friday"
        placeholderTextColor="#9b93b3"
      />
      <View style={styles.classSurveyActions}>
        <TouchableOpacity style={styles.classSurveyCancel} onPress={onCancel}>
          <Text style={styles.classSurveyCancelText}>Cancel</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.assignAddBtn, !canSubmit && { opacity: 0.5 }]}
          disabled={!canSubmit}
          onPress={() => onSubmit({ klass, struggles, goal })}
        >
          <Text style={styles.assignAddBtnText}>Add &amp; build plan</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

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
    <View style={styles.planStrip}>
      <View style={styles.planStripHead}>
        <Text style={styles.planStripLabel}>
          📋 Your plan · {done}/{plan.length}
        </Text>
        <Text style={styles.linkBtn} onPress={onOpen}>
          View
        </Text>
      </View>
      {next ? (
        <TouchableOpacity style={styles.planStripNext} onPress={onToggleNext}>
          <View style={styles.planStripCheck} />
          <Text style={styles.planStripNextText}>
            <Text style={styles.planStripNextLabel}>Next step: </Text>
            {next.checkpoint ? "🚩 " : ""}
            {next.title}
          </Text>
        </TouchableOpacity>
      ) : (
        <Text style={styles.planStripDone}>
          🎉 Plan complete — ask me for the next stage!
        </Text>
      )}
    </View>
  );
}

// A Duolingo-style winding "snake path" of the study plan. Milestones become
// nodes on an alternating path connected by segments that fill green as you
// progress; the first unfinished step is the highlighted "current" node and
// checkpoints fly a flag. Tapping a node toggles that step (same as the list).
// No SVG dependency — the path segments are thin rotated Views.
function PlanPathMap({
  plan,
  onToggle,
}: {
  plan: Milestone[];
  onToggle: (i: number) => void;
}) {
  const [w, setW] = useState(0);
  const n = plan.length;
  const rowH = 92;
  const topPad = 44;
  const botPad = 86;
  const nodeSize = 46;
  const height = topPad + Math.max(0, n - 1) * rowH + botPad;
  const done = plan.filter((m) => m.done).length;
  const pct = n ? Math.round((done / n) * 100) : 0;
  const currentIdx = plan.findIndex((m) => !m.done);

  // Node centres (plus a trailing "finish" point) once we know the width.
  const amp = w > 0 ? Math.max(20, w / 2 - nodeSize) : 0;
  const cx = (i: number) => w / 2 + amp * Math.sin(i * 0.85 + 0.4);
  const pts = [] as { x: number; y: number }[];
  for (let i = 0; i < n; i++) pts.push({ x: cx(i), y: topPad + i * rowH });
  pts.push({ x: cx(n), y: topPad + Math.max(0, n - 1) * rowH + 60 });
  // How many points are "walked" (green): through the current node, or all done.
  const walked = currentIdx === -1 ? n + 1 : currentIdx + 1;

  return (
    <View style={styles.card}>
      <View style={styles.planHead}>
        <Text style={styles.planTitle}>Your path</Text>
        <Text style={styles.planCount}>
          {done}/{n} · {pct}%
        </Text>
      </View>
      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, { width: `${pct}%` }]} />
      </View>
      <View
        style={{ width: "100%", height, marginTop: 8, position: "relative" }}
        onLayout={(e) => setW(e.nativeEvent.layout.width)}
      >
        {w > 0 && (
          <>
            {/* Connector segments between consecutive points. */}
            {pts.slice(0, -1).map((a, i) => {
              const b = pts[i + 1];
              const dx = b.x - a.x;
              const dy = b.y - a.y;
              const len = Math.sqrt(dx * dx + dy * dy);
              const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
              const walkedSeg = i + 1 < walked;
              return (
                <View
                  key={`seg${i}`}
                  style={{
                    position: "absolute",
                    left: (a.x + b.x) / 2 - len / 2,
                    top: (a.y + b.y) / 2 - 2,
                    width: len,
                    height: 4,
                    borderRadius: 2,
                    backgroundColor: walkedSeg ? "#7b4bd0" : "#e2e6e0",
                    transform: [{ rotate: `${angle}deg` }],
                  }}
                />
              );
            })}
            {/* Milestone nodes. */}
            {plan.map((m, i) => {
              const p = pts[i];
              const isDone = m.done;
              const isCurrent = i === currentIdx;
              const cp = m.checkpoint;
              const size = isCurrent ? 56 : nodeSize;
              const bg = isDone
                ? cp
                  ? "#b8742a"
                  : "#7b4bd0"
                : isCurrent
                  ? "#fff"
                  : cp
                    ? "#f3e7d7"
                    : "#f3ebfd";
              const borderColor = cp ? "#b8742a" : "#7b4bd0";
              const borderW = isCurrent ? 3 : isDone ? 0 : 2;
              const fg = isDone
                ? "#fff"
                : isCurrent
                  ? cp
                    ? "#b8742a"
                    : "#7b4bd0"
                  : "#6b6280";
              return (
                <View key={`node${i}`}>
                  {isCurrent && (
                    <View
                      style={{
                        position: "absolute",
                        left: p.x - 46,
                        top: p.y - size / 2 - 24,
                        width: 92,
                        alignItems: "center",
                      }}
                    >
                      <Text style={styles.pathHerePill}>▶ You're here</Text>
                    </View>
                  )}
                  <TouchableOpacity
                    onPress={() => onToggle(i)}
                    activeOpacity={0.7}
                    style={{
                      position: "absolute",
                      left: p.x - size / 2,
                      top: p.y - size / 2,
                      width: size,
                      height: size,
                      borderRadius: size / 2,
                      backgroundColor: bg,
                      borderWidth: borderW,
                      borderColor,
                      alignItems: "center",
                      justifyContent: "center",
                      ...(isDone
                        ? {
                            shadowColor: "#000",
                            shadowOpacity: 0.12,
                            shadowRadius: 4,
                            shadowOffset: { width: 0, height: 2 },
                            elevation: 2,
                          }
                        : {}),
                    }}
                  >
                    <Text
                      style={{
                        color: fg,
                        fontWeight: "800",
                        fontSize: cp && !isDone ? 20 : 18,
                      }}
                    >
                      {isDone ? "✓" : cp ? "🚩" : String(i + 1)}
                    </Text>
                  </TouchableOpacity>
                  <Text
                    numberOfLines={2}
                    style={{
                      position: "absolute",
                      left: p.x - 70,
                      top: p.y + size / 2 + 4,
                      width: 140,
                      textAlign: "center",
                      fontSize: 12,
                      lineHeight: 15,
                      fontWeight: isCurrent ? "700" : "500",
                      color: isDone ? "#6b6280" : "#2a2350",
                    }}
                  >
                    {m.title}
                  </Text>
                </View>
              );
            })}
            {/* Finish trophy. */}
            <View
              style={{
                position: "absolute",
                left: pts[n].x - 27,
                top: pts[n].y - 27,
                width: 54,
                height: 54,
                borderRadius: 27,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: pct === 100 ? "#f3ebfd" : "#fdf4f2",
                borderWidth: 2,
                borderStyle: pct === 100 ? "solid" : "dashed",
                borderColor: pct === 100 ? "#7b4bd0" : "#efe4f0",
              }}
            >
              <Text style={{ fontSize: 24 }}>🏆</Text>
            </View>
            <Text
              style={{
                position: "absolute",
                left: pts[n].x - 60,
                top: pts[n].y + 30,
                width: 120,
                textAlign: "center",
                fontSize: 12,
                fontWeight: "700",
                color: pct === 100 ? "#7b4bd0" : "#6b6280",
              }}
            >
              {pct === 100 ? "Plan complete!" : "Finish"}
            </Text>
          </>
        )}
      </View>
    </View>
  );
}

// Path / List view switch for the study plan. Path is the default; the list
// keeps the add/remove controls.
function PlanBoard({
  plan,
  onToggle,
  onAdd,
  onRemove,
}: {
  plan: Milestone[];
  onToggle: (i: number) => void;
  onAdd?: (title: string) => void;
  onRemove?: (i: number) => void;
}) {
  const [view, setView] = useState<"path" | "list">("path");
  return (
    <View>
      <View style={styles.pathToggleRow}>
        <TouchableOpacity
          style={[styles.pathToggleBtn, view === "path" && styles.pathToggleBtnActive]}
          onPress={() => setView("path")}
        >
          <Text style={[styles.pathToggleText, view === "path" && styles.pathToggleTextActive]}>
            🗺️ Path
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.pathToggleBtn, view === "list" && styles.pathToggleBtnActive]}
          onPress={() => setView("list")}
        >
          <Text style={[styles.pathToggleText, view === "list" && styles.pathToggleTextActive]}>
            📋 List
          </Text>
        </TouchableOpacity>
      </View>
      {view === "path" ? (
        <PlanPathMap plan={plan} onToggle={onToggle} />
      ) : (
        <PlanPanel plan={plan} onToggle={onToggle} onAdd={onAdd} onRemove={onRemove} />
      )}
    </View>
  );
}

function PlanPanel({
  plan,
  onToggle,
  onAdd,
  onRemove,
}: {
  plan: Milestone[];
  onToggle: (i: number) => void;
  onAdd?: (title: string) => void;
  onRemove?: (i: number) => void;
}) {
  const [step, setStep] = useState("");
  const done = plan.filter((m) => m.done).length;
  const pct = plan.length ? Math.round((done / plan.length) * 100) : 0;
  function addStep() {
    if (!step.trim() || !onAdd) return;
    onAdd(step);
    setStep("");
  }
  return (
    <View style={styles.plan}>
      <View style={styles.planHead}>
        <Text style={styles.planTitle}>Your plan</Text>
        <Text style={styles.planCount}>
          {done}/{plan.length} done
        </Text>
      </View>
      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, { width: `${pct}%` }]} />
      </View>
      {plan.map((m, i) => (
        <View key={i} style={styles.planRow}>
          <TouchableOpacity
            style={[styles.planItem, { flex: 1 }]}
            onPress={() => onToggle(i)}
          >
            <View
              style={[
                styles.checkbox,
                m.checkpoint && styles.checkboxCheckpoint,
                m.done && (m.checkpoint ? styles.checkboxOnCheckpoint : styles.checkboxOn),
              ]}
            >
              {m.done && <Text style={styles.checkmark}>✓</Text>}
            </View>
            <Text style={[styles.planItemText, m.done && styles.planItemDone]}>
              {m.checkpoint && (
                <Text style={styles.checkpointBadge}>🚩 CHECKPOINT  </Text>
              )}
              {m.title}
              {m.detail ? ` — ${m.detail}` : ""}
            </Text>
          </TouchableOpacity>
          {m.added && onRemove && (
            <TouchableOpacity
              style={{ paddingHorizontal: 8, paddingVertical: 6 }}
              onPress={() => onRemove(i)}
            >
              <Text style={styles.folderRemove}>✕</Text>
            </TouchableOpacity>
          )}
        </View>
      ))}
      {onAdd && (
        <View style={[styles.assignAddRow, { marginTop: 8 }]}>
          <TextInput
            style={styles.assignInput}
            value={step}
            onChangeText={setStep}
            placeholder="Add your own step…"
            placeholderTextColor="#9b93b3"
            onSubmitEditing={addStep}
            returnKeyType="done"
          />
          <TouchableOpacity style={styles.assignAddBtn} onPress={addStep}>
            <Text style={styles.assignAddBtnText}>Add</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

function MonthGrid({
  events,
  assignments = [],
  onPickDate,
}: {
  events: StudyEvent[];
  assignments?: Assignment[];
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
  const dotsByDate: Record<string, string[]> = {};
  for (const e of events)
    (dotsByDate[e.date] ||= []).push(KIND_COLOR[e.kind ?? "other"]);
  for (const a of assignments)
    if (a.due) (dotsByDate[a.due] ||= []).push("#7b4bd0");
  const cells: (number | null)[] = [];
  for (let i = 0; i < startWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  const shift = (delta: number) => {
    const dt = new Date(view.y, view.m + delta, 1);
    setView({ y: dt.getFullYear(), m: dt.getMonth() });
  };

  return (
    <View style={styles.calGridWrap}>
      <View style={styles.calNav}>
        <TouchableOpacity style={styles.calNavBtn} onPress={() => shift(-1)}>
          <Text style={styles.calNavBtnText}>‹</Text>
        </TouchableOpacity>
        <Text style={styles.calMonthLabel}>{monthLabel}</Text>
        <TouchableOpacity style={styles.calNavBtn} onPress={() => shift(1)}>
          <Text style={styles.calNavBtnText}>›</Text>
        </TouchableOpacity>
      </View>
      <View style={styles.calWeekRow}>
        {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
          <Text key={i} style={styles.calWeekday}>
            {d}
          </Text>
        ))}
      </View>
      <View style={styles.calGrid}>
        {cells.map((d, i) => {
          if (d === null) return <View key={`e${i}`} style={styles.calCell} />;
          const iso = isoFor(d);
          const dots = dotsByDate[iso] || [];
          const isToday = iso === todayIso;
          return (
            <View key={iso} style={styles.calCell}>
              <TouchableOpacity
                style={[styles.calBox, isToday && styles.calBoxToday]}
                onPress={() => onPickDate(iso)}
              >
                <Text
                  style={[styles.calBoxNum, isToday && styles.calBoxNumToday]}
                >
                  {d}
                </Text>
                <View style={styles.calDots}>
                  {dots.slice(0, 3).map((color, j) => (
                    <View
                      key={j}
                      style={[styles.calDot, { backgroundColor: color }]}
                    />
                  ))}
                </View>
              </TouchableOpacity>
            </View>
          );
        })}
      </View>
    </View>
  );
}

// Urgency colour for a countdown — hotter the closer the deadline is.
function urgencyColor(days: number): string {
  if (days <= 1) return "#c0392b";
  if (days <= 3) return "#b8742a";
  if (days <= 7) return "#2f6f8f";
  return "#3f7d5a";
}
function countdownBig(days: number): string {
  if (days < 0) return `${-days}d overdue`;
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  return `${days} days`;
}

const KIND_EMOJI: Record<string, string> = {
  exam: "📝",
  final: "🎓",
  quiz: "❓",
  assignment: "📌",
  project: "📊",
  other: "📅",
};
const KIND_LABEL: Record<string, string> = {
  exam: "Exam",
  final: "Final",
  quiz: "Quiz",
  assignment: "Assignment",
  project: "Project",
  other: "Event",
};

// A single glanceable countdown to the learner's biggest upcoming deadlines,
// merged live from calendar events, assignments with a due date, and SMART goals
// with a target date. Soonest first, with the very next one highlighted big.
function DeadlineCountdown({
  events,
  assignments = [],
  goals = [],
}: {
  events: StudyEvent[];
  assignments?: Assignment[];
  goals?: SmartGoal[];
}) {
  type Item = {
    id: string;
    title: string;
    days: number;
    emoji: string;
    tag: string;
  };
  const items: Item[] = [];
  for (const e of events)
    items.push({
      id: `e:${e.id}`,
      title: e.title,
      days: daysUntil(e.date),
      emoji: KIND_EMOJI[e.kind ?? "other"] ?? "📅",
      tag: KIND_LABEL[e.kind ?? "other"] ?? "Event",
    });
  for (const a of assignments)
    if (!a.done && a.due)
      items.push({
        id: `a:${a.id}`,
        title: a.title,
        days: daysUntil(a.due),
        emoji: "📌",
        tag: a.subject ? a.subject : "Assignment",
      });
  for (const g of goals)
    if (!g.done && g.timeBound)
      items.push({
        id: `g:${g.id}`,
        title: g.statement || g.specific,
        days: daysUntil(g.timeBound),
        emoji: "🎯",
        tag: "Goal",
      });
  const upcoming = items
    .filter((it) => it.days >= -7)
    .sort((a, b) => a.days - b.days)
    .slice(0, 5);
  if (!upcoming.length) return null;
  const next = upcoming[0];
  const rest = upcoming.slice(1);

  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <Text style={styles.cardClass}>⏳ Countdown</Text>
      </View>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          borderWidth: 1,
          borderColor: urgencyColor(next.days),
          borderLeftWidth: 5,
          borderRadius: 12,
          padding: 12,
          marginTop: 8,
        }}
      >
        <View style={{ alignItems: "center", minWidth: 66 }}>
          <Text
            style={{
              fontSize: 24,
              fontWeight: "800",
              color: urgencyColor(next.days),
            }}
          >
            {next.days > 1 ? String(next.days) : next.emoji}
          </Text>
          <Text
            style={{
              fontSize: 11,
              fontWeight: "600",
              color: urgencyColor(next.days),
              marginTop: 2,
            }}
          >
            {next.days > 1 ? "days left" : countdownBig(next.days)}
          </Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text
            style={{ fontSize: 15, fontWeight: "700", color: "#2a2350" }}
            numberOfLines={1}
          >
            {next.emoji} {next.title}
          </Text>
          <Text style={{ fontSize: 12, color: "#6b6280", marginTop: 2 }}>
            {next.tag} · {countdownBig(next.days)}
          </Text>
        </View>
      </View>
      {rest.map((it) => (
        <View
          key={it.id}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            paddingVertical: 6,
          }}
        >
          <Text
            style={{
              fontSize: 12,
              fontWeight: "700",
              color: urgencyColor(it.days),
              minWidth: 60,
            }}
          >
            {countdownBig(it.days)}
          </Text>
          <Text
            style={{ flex: 1, fontSize: 13, color: "#2a2350" }}
            numberOfLines={1}
          >
            {it.emoji} {it.title}
          </Text>
          <Text style={{ fontSize: 11, color: "#8b83a3" }}>{it.tag}</Text>
        </View>
      ))}
    </View>
  );
}

function CalendarPanel({
  events,
  assignments = [],
  onAdd,
  onRemove,
}: {
  events: StudyEvent[];
  assignments?: Assignment[];
  onAdd: (e: StudyEvent) => void;
  onRemove: (id: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [kind, setKind] = useState<EventKind>("exam");

  const sorted = [...events].sort((a, b) => a.date.localeCompare(b.date));
  const valid = title.trim().length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(date);

  function submit() {
    if (!valid) return;
    onAdd({ id: eventId(title, date), title: title.trim(), date, kind });
    setTitle("");
    setDate("");
    setKind("exam");
    setAdding(false);
  }

  return (
    <View style={styles.plan}>
      <View style={styles.planHead}>
        <Text style={styles.planTitle}>📅 Calendar</Text>
        <Text style={styles.linkBtn} onPress={() => setAdding((a) => !a)}>
          {adding ? "Close" : "+ Add date"}
        </Text>
      </View>

      {adding && (
        <View style={styles.calForm}>
          <TextInput
            style={styles.calInput}
            value={title}
            onChangeText={setTitle}
            placeholder="e.g. Biology final"
            placeholderTextColor="#8b83a3"
          />
          <TextInput
            style={styles.calInput}
            value={date}
            onChangeText={setDate}
            placeholder="Date — YYYY-MM-DD"
            placeholderTextColor="#8b83a3"
            keyboardType="numbers-and-punctuation"
          />
          <View style={styles.kindRow}>
            {KINDS.map((k) => (
              <TouchableOpacity
                key={k}
                onPress={() => setKind(k)}
                style={[
                  styles.kindChip,
                  kind === k && { backgroundColor: KIND_COLOR[k], borderColor: KIND_COLOR[k] },
                ]}
              >
                <Text style={[styles.kindChipText, kind === k && { color: "#fff" }]}>
                  {k}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          <TouchableOpacity
            onPress={submit}
            disabled={!valid}
            style={[styles.calAddBtn, !valid && styles.primaryBtnDisabled]}
          >
            <Text style={styles.calAddBtnText}>Add</Text>
          </TouchableOpacity>
        </View>
      )}

      <MonthGrid
        events={events}
        assignments={assignments}
        onPickDate={(iso) => {
          setDate(iso);
          setAdding(true);
        }}
      />

      {sorted.length === 0 ? (
        <Text style={styles.calEmpty}>
          No dates yet. Tap a day above, add an exam or final, or just tell
          Eliora.
        </Text>
      ) : (
        sorted.map((e) => (
          <View key={e.id} style={styles.calRow}>
            <View style={[styles.calChip, { backgroundColor: KIND_COLOR[e.kind ?? "other"] }]}>
              <Text style={styles.calChipText}>{e.kind ?? "event"}</Text>
            </View>
            <Text style={styles.calDate}>{formatDate(e.date)}</Text>
            <Text style={styles.calTitle} numberOfLines={1}>
              {e.title}
            </Text>
            <Text style={styles.calCountdown}>{countdown(e.date)}</Text>
            <Text
              style={styles.calRemove}
              onPress={() => onRemove(e.id)}
              accessibilityLabel={`Remove ${e.title}`}
            >
              ×
            </Text>
          </View>
        ))
      )}
    </View>
  );
}

function isBareYouTubeUrl(s: string): boolean {
  const t = s.trim();
  if (!t || /\s/.test(t)) return false;
  return /^(https?:\/\/)?(www\.|m\.)?(youtube\.com\/(watch\?|shorts\/|embed\/|live\/)|youtu\.be\/)\S+/i.test(
    t,
  );
}

function Summarizer({
  visible,
  profile,
  onClose,
  onAddToChat,
  onStudyGuide,
}: {
  visible: boolean;
  profile: LearnerProfile;
  onClose: () => void;
  onAddToChat: (msg: {
    content: string;
    flashcards?: Flashcard[];
    quiz?: QuizQuestion[];
  }) => void;
  onStudyGuide?: (detail: string) => void;
}) {
  const [tab, setTab] = useState<"text" | "video" | "doc">("text");
  const [output, setOutput] = useState<
    "summary" | "studyguide" | "modules" | "videonotes" | "flashcards" | "quiz"
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

  async function pickFile() {
    const res = await DocumentPicker.getDocumentAsync({
      type: ["application/pdf", "text/*", "image/*"],
      copyToCacheDirectory: true,
    });
    if (res.canceled || !res.assets?.length) return;
    const asset = res.assets[0];
    const mime = asset.mimeType ?? "";
    const isText = mime.startsWith("text/") || /\.(txt|md|markdown)$/i.test(asset.name);
    try {
      if (isText) {
        const content = await FileSystem.readAsStringAsync(asset.uri);
        setFile({ name: asset.name, text: content });
      } else {
        const base64 = await FileSystem.readAsStringAsync(asset.uri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        setFile({ name: asset.name, base64, mediaType: mime });
      }
    } catch {
      setFile({ name: asset.name });
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
      const res = await expoFetch(`${API_BASE_URL}/api/summarize`, {
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

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.container}>
        <ScrollView contentContainerStyle={styles.formScroll}>
          <View style={styles.modalHead}>
            <Text style={styles.formTitle}>Summarize</Text>
            <Text style={styles.linkBtn} onPress={onClose}>
              Close
            </Text>
          </View>

          <View style={styles.tabs}>
            {(["text", "video", "doc"] as const).map((t) => (
              <TouchableOpacity
                key={t}
                onPress={() => setTab(t)}
                style={[styles.tab, tab === t && styles.tabActive]}
              >
                <Text style={[styles.tabText, tab === t && styles.tabTextActive]}>
                  {t === "text" ? "Notes" : t === "video" ? "Video" : "Doc"}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {tab === "text" && (
            <TextInput
              style={[styles.formInput, styles.formTextarea, { minHeight: 140 }]}
              value={text}
              onChangeText={setText}
              placeholder="Paste your notes or any text here…"
              placeholderTextColor="#8b83a3"
              multiline
            />
          )}
          {tab === "video" && (
            <View style={{ gap: 6 }}>
              <TextInput
                style={styles.formInput}
                value={url}
                onChangeText={setUrl}
                placeholder="Paste a YouTube link…"
                placeholderTextColor="#8b83a3"
                autoCapitalize="none"
              />
              <Text style={styles.calEmpty}>
                I'll try to fetch the captions. YouTube often blocks this — if it
                fails, open the video's transcript ("…more" → "Show transcript"),
                copy it, and paste it into the "Notes" tab.
              </Text>
            </View>
          )}
          {tab === "doc" && (
            <View style={{ gap: 8 }}>
              <TouchableOpacity style={styles.secondaryBtn} onPress={pickFile}>
                <Text style={styles.secondaryBtnText}>
                  {file ? `Selected: ${file.name}` : "Choose a file"}
                </Text>
              </TouchableOpacity>
              <Text style={styles.calEmpty}>PDF, image, or text file.</Text>
            </View>
          )}

          <Text style={styles.calEmpty}>Make from this material:</Text>
          <View style={styles.outputRow}>
            {(
              [
                ["summary", "📝 Summary"],
                ["studyguide", "📚 Study guide"],
                ["modules", "🧩 Modules"],
                ["videonotes", "🎬 Video notes"],
                ["flashcards", "🃏 Flashcards"],
                ["quiz", "📋 Quiz"],
              ] as const
            ).map(([k, label]) => (
              <TouchableOpacity
                key={k}
                onPress={() => setOutput(k)}
                style={[styles.outChip, output === k && styles.outChipActive]}
              >
                <Text style={[styles.outChipText, output === k && styles.outChipTextActive]}>
                  {label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {output === "flashcards" && (
            <>
              <Text style={styles.calEmpty}>Flashcard style:</Text>
              <View style={styles.outputRow}>
                {FLASHCARD_STYLES.map((s) => (
                  <TouchableOpacity
                    key={s.key}
                    onPress={() => setFlashStyle(s.key)}
                    style={[styles.outChip, flashStyle === s.key && styles.outChipActive]}
                  >
                    <Text
                      style={[
                        styles.outChipText,
                        flashStyle === s.key && styles.outChipTextActive,
                      ]}
                    >
                      {s.emoji} {s.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </>
          )}

          <TouchableOpacity
            onPress={run}
            disabled={!canRun || busy}
            style={[styles.primaryBtn, (!canRun || busy) && styles.primaryBtnDisabled]}
          >
            <Text style={styles.primaryBtnText}>
              {busy
                ? "Working…"
                : output === "summary"
                  ? "Summarize"
                  : output === "studyguide"
                    ? "Make study guide"
                    : output === "modules"
                      ? "Break into modules"
                      : output === "videonotes"
                        ? "Take video notes"
                        : output === "flashcards"
                          ? "Make flashcards"
                          : "Make quiz"}
            </Text>
          </TouchableOpacity>

          {(!!result || cards || quiz) && (
            <View style={styles.resultBox}>
              {cards ? (
                cards.length ? (
                  <FlashcardDeck cards={cards} onMissed={() => {}} />
                ) : (
                  <Text style={styles.resultText}>No flashcards — try more material.</Text>
                )
              ) : quiz ? (
                quiz.length ? (
                  <QuizView quiz={quiz} onMissed={() => {}} onStudyGuide={onStudyGuide} />
                ) : (
                  <Text style={styles.resultText}>No quiz — try more material.</Text>
                )
              ) : (
                <Text style={styles.resultText}>{result}</Text>
              )}
              <TouchableOpacity
                style={styles.primaryBtn}
                onPress={() => {
                  if (cards?.length)
                    onAddToChat({
                      content: "Here are flashcards from your material:",
                      flashcards: cards,
                    });
                  else if (quiz?.length)
                    onAddToChat({ content: "Here's a quiz from your material:", quiz });
                  else onAddToChat({ content: result });
                  onClose();
                }}
              >
                <Text style={styles.primaryBtnText}>Add to chat</Text>
              </TouchableOpacity>
            </View>
          )}
        </ScrollView>
      </View>
    </Modal>
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

// Strip markdown markers for plain-text display (mobile has no md renderer):
// ==highlight== / **bold** → inner text, and leading #/- bullet markers dropped.
function stripMd(s: string): string {
  return s
    .replace(/==([^=]+)==/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*]\s+/gm, "• ")
    .trim();
}

// Smart-notes study tool: paste messy notes or upload a photo of handwriting,
// and get them cleaned up, transcribed, and with the key ideas pulled out.
// Three modes map to the three AI note features; all hit /api/notes-polish.
function SmartNotes({ profile }: { profile: LearnerProfile }) {
  const [mode, setMode] = useState<NotesMode>("clean");
  const [format, setFormat] = useState<NotesFormat>("outline");
  const [text, setText] = useState("");
  const [file, setFile] = useState<{
    name: string;
    base64?: string;
    mediaType?: string;
    text?: string;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [out, setOut] = useState<PolishedNotes | null>(null);
  const [err, setErr] = useState("");
  const canSubmit = (text.trim().length >= 10 || !!file) && !loading;

  async function pickFile() {
    const res = await DocumentPicker.getDocumentAsync({
      type: ["application/pdf", "text/*", "image/*"],
      copyToCacheDirectory: true,
    });
    if (res.canceled || !res.assets?.length) return;
    const asset = res.assets[0];
    const mime = asset.mimeType ?? "";
    const isText =
      mime.startsWith("text/") || /\.(txt|md|markdown)$/i.test(asset.name);
    try {
      if (isText) {
        const content = await FileSystem.readAsStringAsync(asset.uri);
        setFile({ name: asset.name, text: content });
      } else {
        const base64 = await FileSystem.readAsStringAsync(asset.uri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        setFile({ name: asset.name, base64, mediaType: mime });
        // A photo almost always means handwriting → switch to that mode.
        if (mime.startsWith("image/")) setMode("handwriting");
      }
    } catch {
      setFile({ name: asset.name });
    }
  }

  async function polish() {
    if (!canSubmit) return;
    setLoading(true);
    setErr("");
    setOut(null);
    // A pasted-text file just becomes the text; a pdf/image goes as base64.
    const body = {
      mode,
      format,
      text: (file?.text ?? text).trim() || undefined,
      fileBase64: file?.base64,
      fileMediaType: file?.mediaType,
      fileName: file?.base64 ? file?.name : undefined,
      profile,
    };
    try {
      const res = await expoFetch(`${API_BASE_URL}/api/notes-polish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.result) setOut(data.result as PolishedNotes);
      else setErr(data.error || "Couldn't tidy those notes — try again.");
    } catch {
      setErr("Couldn't reach the server. Please try again.");
    } finally {
      setLoading(false);
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

  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <Text style={styles.cardClass}>📝 Summarize</Text>
      </View>
      <Text style={styles.calEmpty}>
        Paste messy notes or upload a photo of your handwriting. I'll clean them
        up, turn handwriting into text, and highlight the key ideas.
      </Text>
      <View style={[styles.outputRow, { marginTop: 8 }]}>
        {modes.map(([k, label]) => (
          <TouchableOpacity
            key={k}
            onPress={() => setMode(k)}
            style={[styles.outChip, mode === k && styles.outChipActive]}
          >
            <Text style={[styles.outChipText, mode === k && styles.outChipTextActive]}>
              {label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      <View style={[styles.outputRow, { marginTop: 6, alignItems: "center" }]}>
        <Text style={styles.calEmpty}>Format:</Text>
        {formats.map(([k, label]) => (
          <TouchableOpacity
            key={k}
            onPress={() => setFormat(k)}
            style={[styles.outChip, format === k && styles.outChipActive]}
          >
            <Text style={[styles.outChipText, format === k && styles.outChipTextActive]}>
              {label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      <TextInput
        style={[styles.formInput, styles.formTextarea, { minHeight: 120, marginTop: 8 }]}
        value={text}
        onChangeText={setText}
        placeholder={
          mode === "handwriting"
            ? "Upload a photo below — or type any notes to tidy up…"
            : "Paste your messy notes here…"
        }
        placeholderTextColor="#8b83a3"
        multiline
      />
      <TouchableOpacity style={[styles.secondaryBtn, { marginTop: 8 }]} onPress={pickFile}>
        <Text style={styles.secondaryBtnText}>
          {file
            ? `Selected: ${file.name}`
            : mode === "handwriting"
              ? "Upload a photo of your notes"
              : "Choose a file (photo, PDF, or text)"}
        </Text>
      </TouchableOpacity>
      <TouchableOpacity
        onPress={polish}
        disabled={!canSubmit}
        style={[styles.primaryBtn, { marginTop: 10 }, !canSubmit && styles.primaryBtnDisabled]}
      >
        <Text style={styles.primaryBtnText}>
          {loading
            ? "Tidying your notes…"
            : mode === "handwriting"
              ? "✍️ Convert to text"
              : mode === "highlight"
                ? "🖍️ Highlight key ideas"
                : "🧹 Clean up notes"}
        </Text>
      </TouchableOpacity>
      {!!err && <Text style={[styles.resultText, { color: "#c0392b" }]}>{err}</Text>}
      {out && (
        <View style={styles.resultBox}>
          {!!out.note && <Text style={styles.resultText}>{out.note}</Text>}
          {!!out.cleaned && (
            <>
              <Text style={styles.cardClass}>📝 Clean notes</Text>
              <Text style={styles.resultText}>{stripMd(out.cleaned)}</Text>
            </>
          )}
          {out.keyIdeas.length > 0 && (
            <>
              <Text style={[styles.cardClass, { marginTop: 10 }]}>💡 Key ideas</Text>
              {out.keyIdeas.map((idea, i) => (
                <Text key={i} style={styles.resultText}>
                  • {idea}
                </Text>
              ))}
            </>
          )}
          {out.keyTerms.length > 0 && (
            <>
              <Text style={[styles.cardClass, { marginTop: 10 }]}>📚 Key terms</Text>
              {out.keyTerms.map((t, i) => (
                <Text key={i} style={styles.resultText}>
                  • {t.term} — {t.definition}
                </Text>
              ))}
            </>
          )}
        </View>
      )}
    </View>
  );
}

// Lessons from your own material (mirrors Lesson types in @eliora/shared).
// Upload notes / a PDF / a photo of a handout, pick a size, and Eliora builds
// a Khan-Academy-style lesson: teach-then-check steps you work through one at a
// time, plus key terms and a recap.
type LessonSize = "mini" | "regular";
type LessonStep = {
  heading: string;
  body: string;
  check?: QuizQuestion;
  visual?: LessonVisual;
  narration?: string;
};
type Lesson = {
  title: string;
  size: LessonSize;
  minutes: number;
  intro: string;
  steps: LessonStep[];
  keyTerms: { term: string; definition: string }[];
  recap?: string;
  note?: string;
};

// The diagram for a step. The lesson builder picks one of these shapes and
// supplies the labels; the layout is ours. Web draws them as SVG — here they're
// plain Views, so no native drawing dependency is needed.
type LessonVisualKind =
  | "steps"
  | "compare"
  | "parts"
  | "cycle"
  | "timeline"
  | "hierarchy"
  | "formula";
type LessonVisualItem = { label: string; detail?: string; value?: number };
type LessonVisual = {
  kind: LessonVisualKind;
  title?: string;
  items: LessonVisualItem[];
  caption?: string;
};

// One screen in slide mode (mirrors lessonSlides in @eliora/shared).
type LessonSlide =
  | { kind: "title"; title: string; body: string; narration: string }
  | {
      kind: "teach";
      stepIndex: number;
      title: string;
      body: string;
      visual?: LessonVisual;
      narration: string;
    }
  | { kind: "check"; stepIndex: number; title: string; check: QuizQuestion }
  | {
      kind: "terms";
      title: string;
      terms: { term: string; definition: string }[];
      narration: string;
    }
  | { kind: "recap"; title: string; body: string; narration: string };

// Markdown stripped down to something the voice can read without saying
// "asterisk asterisk" out loud. stripMd keeps bullet dots, which sound wrong
// when spoken, so narration gets its own pass.
function speakable(md: string): string {
  return md
    .replace(/==(.+?)==/g, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`(.+?)`/g, "$1")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function lessonSlides(lesson: Lesson): LessonSlide[] {
  const slides: LessonSlide[] = [
    {
      kind: "title",
      title: lesson.title,
      body: lesson.intro,
      narration: speakable(lesson.intro || lesson.title),
    },
  ];
  lesson.steps.forEach((step, stepIndex) => {
    slides.push({
      kind: "teach",
      stepIndex,
      title: step.heading,
      body: step.body,
      visual: step.visual,
      narration: speakable(step.narration || step.body),
    });
    if (step.check)
      slides.push({
        kind: "check",
        stepIndex,
        title: step.heading,
        check: step.check,
      });
  });
  if (lesson.keyTerms.length > 0)
    slides.push({
      kind: "terms",
      title: "Key terms",
      terms: lesson.keyTerms,
      narration: speakable(
        lesson.keyTerms.map((t) => `${t.term}: ${t.definition}`).join(". "),
      ),
    });
  if (lesson.recap)
    slides.push({
      kind: "recap",
      title: "Recap",
      body: lesson.recap,
      narration: speakable(lesson.recap),
    });
  return slides;
}

// ---------------------------------------------------------------------------
// Lesson diagrams, drawn with plain Views.
//
// Each shape gets a layout tuned to what it means: a process reads as a column
// of stages with arrows between them, a comparison as side-by-side columns, a
// split as a proportional bar. Portrait phones are narrow, so anything the web
// lays out horizontally stacks vertically here.
// ---------------------------------------------------------------------------
function DiagramBox({ item, tint }: { item: LessonVisualItem; tint?: boolean }) {
  return (
    <View style={[styles.dgBox, tint && styles.dgBoxTint]}>
      <Text style={styles.dgLabel}>{item.label}</Text>
      {!!item.detail && <Text style={styles.dgDetail}>{item.detail}</Text>}
    </View>
  );
}

function LessonDiagram({ visual }: { visual: LessonVisual }) {
  const { kind, items } = visual;
  if (items.length === 0) return null;

  let body: React.ReactNode;

  if (kind === "steps" || kind === "cycle") {
    // Both are sequences; a cycle just loops back, which the closing row says.
    body = (
      <View>
        {items.map((item, i) => (
          <View key={i}>
            <DiagramBox item={item} tint />
            {i < items.length - 1 && <Text style={styles.dgArrow}>↓</Text>}
          </View>
        ))}
        {kind === "cycle" && (
          <Text style={styles.dgLoop}>↻ back to {items[0].label}</Text>
        )}
      </View>
    );
  } else if (kind === "compare") {
    body = (
      <View style={styles.dgRow}>
        {items.map((item, i) => (
          <View key={i} style={styles.dgCol}>
            <View style={styles.dgColHead}>
              <Text style={styles.dgLabel}>{item.label}</Text>
            </View>
            {!!item.detail && <Text style={styles.dgColBody}>{item.detail}</Text>}
          </View>
        ))}
      </View>
    );
  } else if (kind === "parts") {
    const values = items.map((it) => (it.value && it.value > 0 ? it.value : 1));
    const sum = values.reduce((a, b) => a + b, 0);
    body = (
      <View>
        <View style={styles.dgBar}>
          {items.map((item, i) => (
            <View
              key={i}
              style={[
                styles.dgBarSeg,
                { flex: values[i], opacity: 0.9 - i * 0.15 },
                i === 0 && styles.dgBarSegFirst,
                i === items.length - 1 && styles.dgBarSegLast,
              ]}
            />
          ))}
        </View>
        {items.map((item, i) => (
          <View key={i} style={styles.dgLegendRow}>
            <View style={[styles.dgSwatch, { opacity: 0.9 - i * 0.15 }]} />
            <Text style={styles.dgLegendText}>
              <Text style={styles.dgLegendWord}>{item.label}</Text>
              {`  ${Math.round((values[i] / sum) * 100)}%`}
              {item.detail ? ` — ${item.detail}` : ""}
            </Text>
          </View>
        ))}
      </View>
    );
  } else if (kind === "timeline") {
    body = (
      <View>
        {items.map((item, i) => (
          <View key={i} style={styles.dgTimeRow}>
            <View style={styles.dgTimeRail}>
              <View style={styles.dgTimeDot} />
              {i < items.length - 1 && <View style={styles.dgTimeLine} />}
            </View>
            <View style={styles.dgTimeBody}>
              <Text style={styles.dgLabel}>{item.label}</Text>
              {!!item.detail && <Text style={styles.dgDetail}>{item.detail}</Text>}
            </View>
          </View>
        ))}
      </View>
    );
  } else if (kind === "hierarchy") {
    body = (
      <View>
        {!!visual.title && (
          <View style={styles.dgRoot}>
            <Text style={styles.dgRootText}>{visual.title}</Text>
          </View>
        )}
        <Text style={styles.dgArrow}>↓</Text>
        <View style={styles.dgRow}>
          {items.map((item, i) => (
            <View key={i} style={styles.dgCol}>
              <Text style={styles.dgLabel}>{item.label}</Text>
              {!!item.detail && <Text style={styles.dgDetail}>{item.detail}</Text>}
            </View>
          ))}
        </View>
      </View>
    );
  } else {
    body = (
      <View>
        {!!visual.title && (
          <View style={styles.dgFormula}>
            <Text style={styles.dgFormulaText}>{visual.title}</Text>
          </View>
        )}
        {items.map((item, i) => (
          <View key={i} style={styles.dgLegendRow}>
            <View style={styles.dgSymbol}>
              <Text style={styles.dgSymbolText}>{item.label.slice(0, 3)}</Text>
            </View>
            <Text style={styles.dgLegendText}>
              <Text style={styles.dgLegendWord}>{item.label}</Text>
              {item.detail ? ` — ${item.detail}` : ""}
            </Text>
          </View>
        ))}
      </View>
    );
  }

  return (
    <View style={styles.dgWrap}>
      {/* hierarchy and formula render the title inside the drawing itself. */}
      {!!visual.title && kind !== "hierarchy" && kind !== "formula" && (
        <Text style={styles.dgTitle}>{visual.title}</Text>
      )}
      {body}
      {!!visual.caption && <Text style={styles.dgCaption}>{visual.caption}</Text>}
    </View>
  );
}

// One check question inside the lesson player: the learner picks an option and
// taps Check, then sees whether they were right plus the explanation. Reports a
// missed topic upward the first time they get it wrong. Returns whether the
// learner has answered correctly yet, so the player can gate "Next" on mastery.
function LessonCheck({
  q,
  onResolved,
  onMissed,
}: {
  q: QuizQuestion;
  onResolved: (correct: boolean) => void;
  onMissed: (topic: string) => void;
}) {
  const [picked, setPicked] = useState<number | null>(null);
  const [checked, setChecked] = useState(false);
  const correct = checked && picked === q.answerIndex;

  function check() {
    if (picked === null) return;
    setChecked(true);
    const isRight = picked === q.answerIndex;
    if (!isRight) onMissed(q.topic || q.question);
    onResolved(isRight);
  }

  return (
    <View style={{ marginTop: 10 }}>
      <Text style={[styles.resultText, { fontWeight: "700" }]}>{q.question}</Text>
      {q.options.map((opt, i) => {
        const isPicked = picked === i;
        const isAnswer = i === q.answerIndex;
        // After checking, mark the right answer green and a wrong pick red.
        const state = checked
          ? isAnswer
            ? styles.lessonOptCorrect
            : isPicked
              ? styles.lessonOptWrong
              : null
          : isPicked
            ? styles.lessonOptPicked
            : null;
        return (
          <TouchableOpacity
            key={i}
            style={[styles.lessonOpt, state]}
            disabled={checked}
            onPress={() => setPicked(i)}
          >
            <Text style={styles.lessonOptText}>{opt}</Text>
          </TouchableOpacity>
        );
      })}
      {!checked ? (
        <TouchableOpacity
          onPress={check}
          disabled={picked === null}
          style={[
            styles.secondaryBtn,
            { marginTop: 8 },
            picked === null && styles.primaryBtnDisabled,
          ]}
        >
          <Text style={styles.secondaryBtnText}>Check answer</Text>
        </TouchableOpacity>
      ) : (
        <Text
          style={[
            styles.resultText,
            { marginTop: 8, fontWeight: "700", color: correct ? "#2e7d32" : "#c0392b" },
          ]}
        >
          {correct ? "✅ Correct!" : "❌ Not quite."}
          {q.explanation ? ` ${stripMd(q.explanation)}` : ""}
        </Text>
      )}
    </View>
  );
}

// The interactive lesson player: shows one step at a time (teach → check →
// feedback), a progress bar, and a completion screen with the score. "Next" is
// gated until the step's check question is answered (mastery-style pacing).
function LessonPlayer({
  lesson,
  onMissed,
  onRestart,
}: {
  lesson: Lesson;
  onMissed: (topic: string) => void;
  onRestart: () => void;
}) {
  const total = lesson.steps.length;
  const [idx, setIdx] = useState(0);
  const [done, setDone] = useState(false);
  // Per-step outcome once its check is answered (true = correct first try path).
  const [results, setResults] = useState<Record<number, boolean>>({});
  const step = lesson.steps[idx];
  const answered = step?.check ? idx in results : true;
  const answeredCount = Object.keys(results).length;
  const score = Object.values(results).filter(Boolean).length;
  const withChecks = lesson.steps.filter((s) => s.check).length;

  function next() {
    if (idx + 1 >= total) setDone(true);
    else setIdx(idx + 1);
  }

  if (done) {
    return (
      <View style={styles.resultBox}>
        <Text style={styles.cardClass}>🎉 Lesson complete</Text>
        {withChecks > 0 && (
          <Text style={[styles.resultText, { fontWeight: "700", marginTop: 4 }]}>
            You got {score} of {withChecks} checks right.
          </Text>
        )}
        {!!lesson.recap && (
          <Text style={[styles.resultText, { marginTop: 6 }]}>{stripMd(lesson.recap)}</Text>
        )}
        {lesson.keyTerms.length > 0 && (
          <>
            <Text style={[styles.cardClass, { marginTop: 10 }]}>📚 Key terms</Text>
            {lesson.keyTerms.map((t, i) => (
              <Text key={i} style={styles.resultText}>
                • {t.term} — {t.definition}
              </Text>
            ))}
          </>
        )}
        {!!lesson.note && (
          <Text style={[styles.resultText, { marginTop: 8 }]}>{lesson.note}</Text>
        )}
        <TouchableOpacity style={[styles.secondaryBtn, { marginTop: 12 }]} onPress={onRestart}>
          <Text style={styles.secondaryBtnText}>Make another lesson</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.resultBox}>
      <Text style={styles.cardClass}>
        {lesson.size === "mini" ? "⚡" : "📖"} {lesson.title}
      </Text>
      {idx === 0 && !!lesson.intro && (
        <Text style={[styles.resultText, { marginTop: 2 }]}>{stripMd(lesson.intro)}</Text>
      )}
      {/* Progress bar */}
      <View style={styles.lessonProgressTrack}>
        <View
          style={[styles.lessonProgressFill, { width: `${((idx + 1) / total) * 100}%` }]}
        />
      </View>
      <Text style={styles.calEmpty}>
        Step {idx + 1} of {total} · ~{lesson.minutes} min
      </Text>

      <Text style={[styles.cardClass, { marginTop: 10 }]}>{step.heading}</Text>
      {!!step.visual && <LessonDiagram visual={step.visual} />}
      <Text style={styles.resultText}>{stripMd(step.body)}</Text>

      {step.check && (
        <LessonCheck
          // Reset the check widget's internal state when the step changes.
          key={idx}
          q={step.check}
          onMissed={onMissed}
          onResolved={(correct) => setResults((r) => ({ ...r, [idx]: correct }))}
        />
      )}

      <TouchableOpacity
        onPress={next}
        disabled={!answered}
        style={[styles.primaryBtn, { marginTop: 12 }, !answered && styles.primaryBtnDisabled]}
      >
        <Text style={styles.primaryBtnText}>
          {idx + 1 >= total ? "Finish lesson" : "Next step →"}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

// Slide mode: the lesson as a narrated deck. One idea per screen, read aloud,
// advancing on its own when the voice finishes — closer to watching a short
// video than reading a page — but it stops at every check question until the
// learner answers, so it stays a lesson rather than a lecture.
function LessonSlideshow({
  lesson,
  onMissed,
}: {
  lesson: Lesson;
  onMissed: (topic: string) => void;
}) {
  const slides = useMemo(() => lessonSlides(lesson), [lesson]);
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [answered, setAnswered] = useState<Record<number, boolean>>({});
  const slide = slides[i];
  // Marks the narration currently being spoken, so a clip that finishes after
  // the learner has already moved on can't advance the deck a second time.
  const token = useRef(0);

  const blocked = slide.kind === "check" && !(i in answered);

  useEffect(() => {
    if (!playing || blocked) return;
    if (slide.kind === "check") {
      // Answered check: give the learner a beat to read the feedback, then
      // move on — there's no narration to pace this slide.
      const timer = setTimeout(() => {
        if (i + 1 < slides.length) setI(i + 1);
        else setPlaying(false);
      }, 1200);
      return () => clearTimeout(timer);
    }
    const mine = ++token.current;
    const advance = () => {
      if (mine !== token.current) return;
      token.current += 1;
      // Pace the deck to the voice rather than to a fixed timer.
      if (i + 1 < slides.length) setI(i + 1);
      else setPlaying(false);
    };
    Speech.stop();
    Speech.speak(slide.narration, {
      rate: 0.95,
      onDone: advance,
      onError: advance,
      onStopped: advance,
    });
    return () => {
      token.current += 1;
      Speech.stop();
    };
  }, [i, playing, blocked, slide, slides.length]);

  // Don't leave the phone talking after the learner navigates away.
  useEffect(
    () => () => {
      Speech.stop();
    },
    [],
  );

  function go(delta: number) {
    token.current += 1;
    Speech.stop();
    setI((prev) => Math.min(slides.length - 1, Math.max(0, prev + delta)));
  }

  return (
    <View style={styles.resultBox}>
      <View style={styles.slideBar}>
        <Text style={styles.calEmpty}>
          {i + 1} / {slides.length}
        </Text>
        <View style={styles.lessonProgressTrack}>
          <View
            style={[
              styles.lessonProgressFill,
              { width: `${((i + 1) / slides.length) * 100}%` },
            ]}
          />
        </View>
      </View>

      <View style={styles.slideCard}>
        {slide.kind === "title" && (
          <>
            <Text style={styles.slideKicker}>
              {lesson.size === "mini" ? "⚡ MINI LESSON" : "📖 LESSON"} · ~
              {lesson.minutes} MIN
            </Text>
            <Text style={styles.slideBigTitle}>{slide.title}</Text>
            {!!slide.body && <Text style={styles.slideLead}>{slide.body}</Text>}
          </>
        )}

        {slide.kind === "teach" && (
          <>
            <Text style={styles.slideTitle}>{slide.title}</Text>
            {!!slide.visual && <LessonDiagram visual={slide.visual} />}
            <Text style={styles.slideBody}>{stripMd(slide.body)}</Text>
          </>
        )}

        {slide.kind === "check" && (
          <>
            <Text style={styles.slideTitle}>Your turn</Text>
            <LessonCheck
              key={i}
              q={slide.check}
              onMissed={onMissed}
              onResolved={(ok) => setAnswered((a) => ({ ...a, [i]: ok }))}
            />
          </>
        )}

        {slide.kind === "terms" && (
          <>
            <Text style={styles.slideTitle}>📚 Key terms</Text>
            {slide.terms.map((t, ti) => (
              <Text key={ti} style={styles.slideBody}>
                <Text style={{ fontWeight: "700" }}>{t.term}</Text> — {t.definition}
              </Text>
            ))}
          </>
        )}

        {slide.kind === "recap" && (
          <>
            <Text style={styles.slideTitle}>🎉 Recap</Text>
            <Text style={styles.slideLead}>{slide.body}</Text>
            {!!lesson.note && <Text style={styles.slideNote}>{lesson.note}</Text>}
          </>
        )}
      </View>

      <View style={styles.slideControls}>
        <TouchableOpacity
          style={[styles.secondaryBtn, styles.slideNav, i === 0 && styles.primaryBtnDisabled]}
          disabled={i === 0}
          onPress={() => go(-1)}
        >
          <Text style={styles.secondaryBtnText}>‹ Back</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.primaryBtn, styles.slideNav]}
          onPress={() => {
            setPlaying((p) => {
              if (p) {
                token.current += 1;
                Speech.stop();
              }
              return !p;
            });
          }}
        >
          <Text style={styles.primaryBtnText}>{playing ? "⏸ Pause" : "▶ Play"}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[
            styles.secondaryBtn,
            styles.slideNav,
            (i + 1 >= slides.length || blocked) && styles.primaryBtnDisabled,
          ]}
          disabled={i + 1 >= slides.length || blocked}
          onPress={() => go(1)}
        >
          <Text style={styles.secondaryBtnText}>Next ›</Text>
        </TouchableOpacity>
      </View>
      {blocked && <Text style={styles.calEmpty}>Answer to continue</Text>}
    </View>
  );
}

function LessonBuilder({
  profile,
  onMissed,
}: {
  profile: LearnerProfile;
  onMissed: (topic: string) => void;
}) {
  const [size, setSize] = useState<LessonSize>("mini");
  const [text, setText] = useState("");
  const [file, setFile] = useState<{
    name: string;
    base64?: string;
    mediaType?: string;
    text?: string;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [lesson, setLesson] = useState<Lesson | null>(null);
  const [mode, setMode] = useState<"slides" | "read">("slides");
  const [err, setErr] = useState("");
  const canSubmit = (text.trim().length >= 20 || !!file) && !loading;

  async function pickFile() {
    const res = await DocumentPicker.getDocumentAsync({
      type: ["application/pdf", "text/*", "image/*"],
      copyToCacheDirectory: true,
    });
    if (res.canceled || !res.assets?.length) return;
    const asset = res.assets[0];
    const mime = asset.mimeType ?? "";
    const isText =
      mime.startsWith("text/") || /\.(txt|md|markdown)$/i.test(asset.name);
    try {
      if (isText) {
        const content = await FileSystem.readAsStringAsync(asset.uri);
        setFile({ name: asset.name, text: content });
      } else {
        const base64 = await FileSystem.readAsStringAsync(asset.uri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        setFile({ name: asset.name, base64, mediaType: mime });
      }
    } catch {
      setFile({ name: asset.name });
    }
  }

  async function build() {
    if (!canSubmit) return;
    setLoading(true);
    setErr("");
    setLesson(null);
    // A pasted-text file just becomes the text; a pdf/image goes as base64.
    const body = {
      size,
      text: (file?.text ?? text).trim() || undefined,
      fileBase64: file?.base64,
      fileMediaType: file?.mediaType,
      fileName: file?.base64 ? file?.name : undefined,
      profile,
    };
    try {
      const res = await expoFetch(`${API_BASE_URL}/api/lesson`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.lesson) setLesson(data.lesson as Lesson);
      else setErr(data.error || "Couldn't build a lesson — try again.");
    } catch {
      setErr("Couldn't reach the server. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  const sizes = [
    ["mini", "⚡ Mini · ~5–10 min"],
    ["regular", "📖 Regular · ~20–30 min"],
  ] as const;

  // Once a lesson is built, hand off to whichever player the learner picked:
  // narrated slides to watch, or the self-paced step view to read.
  if (lesson && lesson.steps.length > 0) {
    return (
      <View style={styles.card}>
        <View style={styles.cardHead}>
          <Text style={styles.cardClass}>🎓 Lesson</Text>
          <Text style={styles.linkBtn} onPress={() => setLesson(null)}>
            Exit
          </Text>
        </View>
        <View style={styles.outputRow}>
          {(
            [
              ["slides", "🎬 Slides"],
              ["read", "📄 Read"],
            ] as const
          ).map(([key, label]) => (
            <TouchableOpacity
              key={key}
              style={[styles.outChip, mode === key && styles.outChipActive]}
              onPress={() => setMode(key)}
            >
              <Text
                style={[
                  styles.outChipText,
                  mode === key && styles.outChipTextActive,
                ]}
              >
                {label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
        {mode === "slides" ? (
          <LessonSlideshow lesson={lesson} onMissed={onMissed} />
        ) : (
          <LessonPlayer
            lesson={lesson}
            onMissed={onMissed}
            onRestart={() => setLesson(null)}
          />
        )}
      </View>
    );
  }

  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <Text style={styles.cardClass}>🎓 Lesson from your material</Text>
      </View>
      <Text style={styles.calEmpty}>
        Paste your notes or upload a PDF, photo, or text file, and I'll turn it
        into a lesson you can work through like Khan Academy — learn a bit,
        answer a quick question, then move to the next step.
      </Text>
      <View style={[styles.outputRow, { marginTop: 8 }]}>
        {sizes.map(([k, label]) => (
          <TouchableOpacity
            key={k}
            onPress={() => setSize(k)}
            style={[styles.outChip, size === k && styles.outChipActive]}
          >
            <Text style={[styles.outChipText, size === k && styles.outChipTextActive]}>
              {label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      <TextInput
        style={[styles.formInput, styles.formTextarea, { minHeight: 120, marginTop: 8 }]}
        value={text}
        onChangeText={setText}
        placeholder="Paste your notes, a handout, or any material here…"
        placeholderTextColor="#8b83a3"
        multiline
      />
      <TouchableOpacity style={[styles.secondaryBtn, { marginTop: 8 }]} onPress={pickFile}>
        <Text style={styles.secondaryBtnText}>
          {file ? `Selected: ${file.name}` : "Upload a file (PDF, photo, or text)"}
        </Text>
      </TouchableOpacity>
      <TouchableOpacity
        onPress={build}
        disabled={!canSubmit}
        style={[styles.primaryBtn, { marginTop: 10 }, !canSubmit && styles.primaryBtnDisabled]}
      >
        <Text style={styles.primaryBtnText}>
          {loading
            ? "Building your lesson…"
            : size === "mini"
              ? "⚡ Build mini lesson"
              : "📖 Build lesson"}
        </Text>
      </TouchableOpacity>
      {!!err && <Text style={[styles.resultText, { color: "#c0392b" }]}>{err}</Text>}
      {lesson && lesson.steps.length === 0 && !!lesson.note && (
        <Text style={[styles.resultText, { marginTop: 8 }]}>{lesson.note}</Text>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Lesson plan from the first session.
//
// A tutor's first session is diagnostic: you talk, you listen for what they
// already have, and you leave with a plan. /api/lesson-plan reads the first
// session's transcript back and returns what it revealed plus an ordered course
// of sessions. Mirrors LessonPlan in @eliora/shared.
// ---------------------------------------------------------------------------

type SessionRead = {
  level: string;
  strengths: string[];
  gaps: string[];
  pace: string;
};
type PlannedSession = {
  number: number;
  title: string;
  focus: string;
  objectives: string[];
  activities: string[];
  homework?: string;
  checkpoint?: boolean;
};
type LessonPlanResult = {
  title: string;
  subject?: string;
  summary: string;
  read: SessionRead;
  sessions: PlannedSession[];
  nextSession: string;
  note?: string;
};

const PLAN_LENGTHS = [4, 6, 8] as const;

function SessionLessonPlan({
  session,
  profile,
  onAdopt,
  onAsk,
}: {
  // The first conversation with real content — null until they've talked.
  session: { title: string; messages: Message[] } | null;
  profile: LearnerProfile;
  onAdopt: (steps: IncomingMilestone[]) => void;
  onAsk: (message: string) => void;
}) {
  const [goal, setGoal] = useState("");
  const [count, setCount] = useState<number>(6);
  const [loading, setLoading] = useState(false);
  const [plan, setPlan] = useState<LessonPlanResult | null>(null);
  const [err, setErr] = useState("");
  const [adopted, setAdopted] = useState(false);
  // One session open at a time — six sessions of objectives all expanded is the
  // wall of text this app exists to avoid.
  const [open, setOpen] = useState<number | null>(1);

  const turns = session?.messages.filter((m) => m.role === "user").length ?? 0;
  const ready = turns >= 2;
  const canSubmit = ready && !loading;

  // The build round-trip can outlive this screen; don't set state into a
  // component the user has already navigated away from.
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  async function build() {
    if (!canSubmit || !session) return;
    setLoading(true);
    setErr("");
    setPlan(null);
    setAdopted(false);
    try {
      const res = await expoFetch(`${API_BASE_URL}/api/lesson-plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: session.messages.map((m) => ({
            role: m.role,
            content: m.content,
          })),
          goal: goal.trim() || undefined,
          sessionCount: count,
          profile,
        }),
      });
      const data = await res.json();
      if (!mounted.current) return;
      if (data.plan) {
        setPlan(data.plan as LessonPlanResult);
        setOpen(1);
      } else setErr(data.error || "Couldn't build that plan — try again.");
    } catch {
      if (mounted.current) setErr("Couldn't reach the server. Please try again.");
    } finally {
      if (mounted.current) setLoading(false);
    }
  }

  // Each planned session becomes one milestone, so the course lands where
  // they'll actually see it and can tick it off.
  function adopt() {
    if (!plan) return;
    onAdopt(
      plan.sessions.map((s) => ({
        title: `Session ${s.number} · ${s.title}`,
        detail: [s.focus, s.homework ? `Homework: ${s.homework}` : ""]
          .filter(Boolean)
          .join(" "),
        checkpoint: s.checkpoint,
      })),
    );
    setAdopted(true);
  }

  function startSession(s: PlannedSession) {
    onAsk(
      `Let's do session ${s.number} of my lesson plan: ${s.title}.\n\nThe focus: ${
        s.focus
      }\nBy the end I should be able to:\n${s.objectives
        .map((o) => `- ${o}`)
        .join("\n")}\n\nTeach it to me one piece at a time, and check I've got it before moving on.`,
    );
  }

  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <Text style={styles.cardClass}>🗺️ Lesson plan from our first session</Text>
      </View>
      <Text style={styles.calEmpty}>
        {ready
          ? `I'll read back our first conversation${
              session?.title ? ` (“${session.title}”)` : ""
            } — what you already had, what tripped you up — and plan the sessions ahead from it.`
          : "Once we've worked through something together, I'll read that first session back and build your plan from what it showed me."}
      </Text>
      {ready && (
        <>
          <TextInput
            style={[styles.formInput, styles.formTextarea, { marginTop: 8 }]}
            value={goal}
            onChangeText={setGoal}
            placeholder="Where do you want to get to? (optional)"
            placeholderTextColor="#8b83a3"
            multiline
          />
          <View style={[styles.outputRow, { marginTop: 8 }]}>
            {PLAN_LENGTHS.map((n) => (
              <TouchableOpacity
                key={n}
                onPress={() => setCount(n)}
                style={[styles.outChip, count === n && styles.outChipActive]}
              >
                <Text
                  style={[
                    styles.outChipText,
                    count === n && styles.outChipTextActive,
                  ]}
                >
                  {n} sessions
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </>
      )}
      <TouchableOpacity
        onPress={build}
        disabled={!canSubmit}
        style={[
          styles.primaryBtn,
          { marginTop: 10 },
          !canSubmit && styles.primaryBtnDisabled,
        ]}
      >
        <Text style={styles.primaryBtnText}>
          {loading
            ? "Reading our first session…"
            : ready
              ? "🗺️ Build my lesson plan"
              : "💬 Talk with me first"}
        </Text>
      </TouchableOpacity>
      {!!err && <Text style={[styles.resultText, { color: "#c0392b", marginTop: 8 }]}>{err}</Text>}
      {plan && (
        <View style={{ marginTop: 14 }}>
          <Text style={styles.planTitle}>{plan.title}</Text>
          {!!plan.summary && (
            <Text style={[styles.resultText, { marginTop: 6 }]}>{plan.summary}</Text>
          )}

          <Text style={styles.lpSecHead}>🔎 What that session showed me</Text>
          {!!plan.read.level && <Text style={styles.lpItem}>{plan.read.level}</Text>}
          {plan.read.strengths.length > 0 && (
            <>
              <Text style={styles.lpSecHead}>💪 You already have</Text>
              {plan.read.strengths.map((s, i) => (
                <Text key={i} style={styles.lpItem}>
                  • {s}
                </Text>
              ))}
            </>
          )}
          {plan.read.gaps.length > 0 && (
            <>
              <Text style={styles.lpSecHead}>🎯 What we'll fix, in order</Text>
              {plan.read.gaps.map((g, i) => (
                <Text key={i} style={styles.lpItem}>
                  {i + 1}. {g}
                </Text>
              ))}
            </>
          )}
          {!!plan.read.pace && <Text style={styles.lpNote}>{plan.read.pace}</Text>}

          <Text style={styles.lpSecHead}>📚 The sessions ahead</Text>
          {plan.sessions.map((s) => {
            const isOpen = open === s.number;
            return (
              <TouchableOpacity
                key={s.number}
                activeOpacity={0.8}
                style={styles.lpSession}
                onPress={() => setOpen(isOpen ? null : s.number)}
              >
                <View style={styles.lpSessionHead}>
                  <View style={styles.lpNum}>
                    <Text style={styles.lpNumText}>{s.number}</Text>
                  </View>
                  <Text style={styles.lpSessionTitle}>{s.title}</Text>
                  {s.checkpoint && (
                    <Text style={styles.checkpointBadge}>🚩</Text>
                  )}
                </View>
                <Text style={styles.lpFocus}>{s.focus}</Text>
                {isOpen && (
                  <>
                    {s.objectives.length > 0 && (
                      <>
                        <Text style={styles.lpSecHead}>By the end you can</Text>
                        {s.objectives.map((o, i) => (
                          <Text key={i} style={styles.lpItem}>
                            • {o}
                          </Text>
                        ))}
                      </>
                    )}
                    {s.activities.length > 0 && (
                      <>
                        <Text style={styles.lpSecHead}>What we'll do</Text>
                        {s.activities.map((a, i) => (
                          <Text key={i} style={styles.lpItem}>
                            • {a}
                          </Text>
                        ))}
                      </>
                    )}
                    {!!s.homework && (
                      <Text style={styles.lpHint}>📩 Between sessions: {s.homework}</Text>
                    )}
                    <TouchableOpacity
                      style={[styles.secondaryBtn, { marginTop: 8 }]}
                      onPress={() => startSession(s)}
                    >
                      <Text style={styles.secondaryBtnText}>▶️ Start this session</Text>
                    </TouchableOpacity>
                  </>
                )}
              </TouchableOpacity>
            );
          })}

          {!!plan.nextSession && (
            <Text style={styles.lpHint}>🎯 Next time we'll start with: {plan.nextSession}</Text>
          )}
          {!!plan.note && <Text style={styles.lpNote}>{plan.note}</Text>}
          <TouchableOpacity
            onPress={adopt}
            disabled={adopted}
            style={[
              styles.primaryBtn,
              { marginTop: 10 },
              adopted && styles.primaryBtnDisabled,
            ]}
          >
            <Text style={styles.primaryBtnText}>
              {adopted ? "✓ Added to your study plan" : "📌 Add these to my study plan"}
            </Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Notes workspace (mobile) — persistent notebook: free-form or Cornell notes,
// color-coded concept highlights, and wiki-style [[links]] between notes. Saved
// to AsyncStorage. (Infinite canvas / mind maps and voice dictation are web-only
// for now — they need native libs not in the mobile build.)
// ---------------------------------------------------------------------------

type NoteColor = "yellow" | "green" | "blue" | "pink" | "orange";
type NBStickyNote = { id: string; text: string; color: NoteColor };
type NBDoc = {
  id: string;
  title: string;
  template: "free" | "cornell";
  body: string;
  cue: string;
  summary: string;
  stickies: NBStickyNote[];
  updatedAt: number;
};
const NB_KEY = "eliora-notebook";
const NB_HIGHLIGHTS: Record<NoteColor, string> = {
  yellow: "#fdf0a6",
  green: "#c3e8cb",
  blue: "#c2dcf7",
  pink: "#f8c9dd",
  orange: "#ffd9ac",
};
const NB_COLORS: NoteColor[] = ["yellow", "green", "blue", "pink", "orange"];
function nbId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// Render one line of note markdown to RN <Text> spans: **bold**, ==highlight==
// (optionally ==color:text==), and [[links]] (tap to open that note).
function nbRenderLine(
  line: string,
  onLink: (title: string) => void,
  keyBase: string,
): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  line
    .split(/(\*\*[^*]+\*\*|==[^=]+==|\[\[[^\]]+\]\])/g)
    .forEach((part, i) => {
      if (!part) return;
      let m: RegExpMatchArray | null;
      if ((m = part.match(/^\*\*([^*]+)\*\*$/))) {
        out.push(
          <Text key={`${keyBase}-${i}`} style={{ fontWeight: "700" }}>
            {m[1]}
          </Text>,
        );
      } else if ((m = part.match(/^==([^=]+)==$/))) {
        const inner = m[1];
        const cm = inner.match(/^(yellow|green|blue|pink|orange):([\s\S]+)$/);
        const color = (cm ? cm[1] : "yellow") as NoteColor;
        const label = cm ? cm[2] : inner;
        out.push(
          <Text
            key={`${keyBase}-${i}`}
            style={{ backgroundColor: NB_HIGHLIGHTS[color], color: "#2a2350" }}
          >
            {label}
          </Text>,
        );
      } else if ((m = part.match(/^\[\[([^\]]+)\]\]$/))) {
        const title = m[1].trim();
        out.push(
          <Text
            key={`${keyBase}-${i}`}
            onPress={() => onLink(title)}
            style={{ color: "#7b4bd0", fontWeight: "600", textDecorationLine: "underline" }}
          >
            {title}
          </Text>,
        );
      } else {
        out.push(<Text key={`${keyBase}-${i}`}>{part}</Text>);
      }
    });
  return out;
}

function NBPreview({
  text,
  onLink,
}: {
  text: string;
  onLink: (title: string) => void;
}) {
  const lines = text.split("\n");
  return (
    <View>
      {lines.map((raw, i) => {
        const line = raw.replace(/\s+$/, "");
        if (!line.trim()) return <View key={i} style={{ height: 6 }} />;
        let m: RegExpMatchArray | null;
        if ((m = line.match(/^(#{1,3})\s+(.*)$/))) {
          const lvl = m[1].length;
          return (
            <Text
              key={i}
              style={{
                fontWeight: "800",
                fontSize: lvl === 1 ? 18 : lvl === 2 ? 16 : 14.5,
                color: "#7b4bd0",
                marginTop: 8,
                marginBottom: 2,
              }}
            >
              {nbRenderLine(m[2], onLink, String(i))}
            </Text>
          );
        }
        if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
          return (
            <Text key={i} style={{ fontSize: 14.5, color: "#2a2350", lineHeight: 21 }}>
              {"•  "}
              {nbRenderLine(m[1], onLink, String(i))}
            </Text>
          );
        }
        return (
          <Text key={i} style={{ fontSize: 14.5, color: "#2a2350", lineHeight: 21 }}>
            {nbRenderLine(line, onLink, String(i))}
          </Text>
        );
      })}
    </View>
  );
}

function NotesWorkspace() {
  const [docs, setDocs] = useState<NBDoc[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [sel, setSel] = useState({ start: 0, end: 0 });

  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(NB_KEY);
        const saved = raw ? (JSON.parse(raw) as NBDoc[]) : null;
        if (Array.isArray(saved) && saved.length) {
          const norm = saved.map((d) => ({ ...d, stickies: d.stickies ?? [] }));
          setDocs(norm);
          setActiveId(norm[0].id);
        }
      } catch {
        /* ignore */
      }
      setLoaded(true);
    })();
  }, []);

  useEffect(() => {
    if (!loaded) return;
    AsyncStorage.setItem(NB_KEY, JSON.stringify(docs)).catch(() => {});
  }, [docs, loaded]);

  const active = docs.find((d) => d.id === activeId) ?? null;

  function createDoc(template: "free" | "cornell") {
    const doc: NBDoc = {
      id: nbId(),
      title: template === "cornell" ? "Cornell notes" : "Untitled note",
      template,
      body: "",
      cue: "",
      summary: "",
      stickies: [],
      updatedAt: Date.now(),
    };
    setDocs((prev) => [doc, ...prev]);
    setActiveId(doc.id);
  }
  function patch(id: string, p: Partial<NBDoc>) {
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
  function openByTitle(title: string) {
    const found = docs.find(
      (d) => d.title.trim().toLowerCase() === title.trim().toLowerCase(),
    );
    if (found) {
      setActiveId(found.id);
    } else {
      const doc: NBDoc = {
        id: nbId(),
        title,
        template: "free",
        body: "",
        cue: "",
        summary: "",
        stickies: [],
        updatedAt: Date.now(),
      };
      setDocs((prev) => [doc, ...prev]);
      setActiveId(doc.id);
    }
  }
  function wrapSelection(before: string, after: string) {
    if (!active) return;
    const val = active.body;
    const start = Math.min(sel.start, sel.end);
    const end = Math.max(sel.start, sel.end);
    const chosen = val.slice(start, end) || "concept";
    patch(active.id, {
      body: val.slice(0, start) + before + chosen + after + val.slice(end),
    });
  }

  return (
    <ScrollView contentContainerStyle={styles.studyScroll}>
      <View style={styles.card}>
        <View style={styles.cardHead}>
          <Text style={styles.cardClass}>📓 Smart Notes</Text>
        </View>
        <Text style={styles.calEmpty}>
          Free-form or Cornell notes, color-code key concepts, and link notes with
          [[title]].
        </Text>
        <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
          <TouchableOpacity
            style={[styles.primaryBtn, { flex: 1 }]}
            onPress={() => createDoc("free")}
          >
            <Text style={styles.primaryBtnText}>＋ New note</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.secondaryBtn, { flex: 1 }]}
            onPress={() => createDoc("cornell")}
          >
            <Text style={styles.secondaryBtnText}>📐 Cornell</Text>
          </TouchableOpacity>
        </View>

        {docs.length > 0 && (
          <View style={{ marginTop: 10, gap: 4 }}>
            {docs.map((d) => (
              <TouchableOpacity
                key={d.id}
                onPress={() => setActiveId(d.id)}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  paddingVertical: 8,
                  paddingHorizontal: 10,
                  borderRadius: 10,
                  backgroundColor: d.id === activeId ? "#eef4ef" : "transparent",
                }}
              >
                <Text style={{ flex: 1, fontSize: 15, color: "#2a2350", fontWeight: d.id === activeId ? "700" : "500" }}>
                  {d.template === "cornell" ? "📐 " : "📝 "}
                  {d.title || "Untitled"}
                </Text>
                <Text onPress={() => removeDoc(d.id)} style={{ color: "#8b83a3", fontSize: 18, paddingHorizontal: 6 }}>
                  ×
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        )}
      </View>

      {active && (
        <View style={styles.card}>
          <TextInput
            value={active.title}
            onChangeText={(t) => patch(active.id, { title: t })}
            placeholder="Note title"
            placeholderTextColor="#8b83a3"
            style={{ fontSize: 19, fontWeight: "800", color: "#7b4bd0", paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: "#efe4f0" }}
          />

          {/* Color-code toolbar (wraps the current selection in the notes field) */}
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
            <Text style={{ fontSize: 12.5, color: "#6b6280", fontWeight: "600" }}>Color:</Text>
            {NB_COLORS.map((c) => (
              <TouchableOpacity
                key={c}
                onPress={() => wrapSelection(`==${c}:`, "==")}
                style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: NB_HIGHLIGHTS[c], borderWidth: 1, borderColor: "rgba(0,0,0,0.15)" }}
              />
            ))}
            <TouchableOpacity
              onPress={() => wrapSelection("**", "**")}
              style={{ paddingHorizontal: 10, paddingVertical: 3, borderRadius: 8, borderWidth: 1, borderColor: "#efe4f0" }}
            >
              <Text style={{ fontWeight: "800", color: "#2a2350" }}>B</Text>
            </TouchableOpacity>
          </View>

          {active.template === "cornell" ? (
            <View style={{ marginTop: 10 }}>
              <Text style={styles.nbLabel}>Cues / questions</Text>
              <TextInput
                value={active.cue}
                onChangeText={(t) => patch(active.id, { cue: t })}
                placeholder="Key questions, cues, keywords…"
                placeholderTextColor="#8b83a3"
                multiline
                style={[styles.formInput, styles.formTextarea, { minHeight: 90 }]}
              />
              <Text style={styles.nbLabel}>Notes</Text>
              <TextInput
                value={active.body}
                onChangeText={(t) => patch(active.id, { body: t })}
                onSelectionChange={(e) => setSel(e.nativeEvent.selection)}
                placeholder="Main notes from class or reading…"
                placeholderTextColor="#8b83a3"
                multiline
                style={[styles.formInput, styles.formTextarea, { minHeight: 140 }]}
              />
              <Text style={styles.nbLabel}>Summary</Text>
              <TextInput
                value={active.summary}
                onChangeText={(t) => patch(active.id, { summary: t })}
                placeholder="Sum it up in a sentence or two…"
                placeholderTextColor="#8b83a3"
                multiline
                style={[styles.formInput, styles.formTextarea, { minHeight: 70 }]}
              />
            </View>
          ) : (
            <TextInput
              value={active.body}
              onChangeText={(t) => patch(active.id, { body: t })}
              onSelectionChange={(e) => setSel(e.nativeEvent.selection)}
              placeholder="Write your notes… use ## headings, - bullets, and [[links]]."
              placeholderTextColor="#8b83a3"
              multiline
              style={[styles.formInput, styles.formTextarea, { minHeight: 160, marginTop: 10 }]}
            />
          )}

          {(active.body.trim() || active.cue.trim() || active.summary.trim()) && (
            <View style={{ marginTop: 12, padding: 12, borderRadius: 12, backgroundColor: "#f3f7f4" }}>
              <Text style={{ fontSize: 11.5, fontWeight: "800", color: "#6b6280", marginBottom: 6 }}>
                PREVIEW
              </Text>
              {active.template === "cornell" && !!active.cue.trim() && (
                <View style={{ marginBottom: 6 }}>
                  <Text style={{ fontWeight: "800", color: "#7b4bd0", fontSize: 13 }}>Cues</Text>
                  <NBPreview text={active.cue} onLink={openByTitle} />
                </View>
              )}
              <NBPreview text={active.body} onLink={openByTitle} />
              {active.template === "cornell" && !!active.summary.trim() && (
                <View style={{ marginTop: 6, paddingTop: 6, borderTopWidth: 1, borderTopColor: "#efe4f0" }}>
                  <Text style={{ fontWeight: "800", color: "#7b4bd0", fontSize: 13 }}>Summary</Text>
                  <NBPreview text={active.summary} onLink={openByTitle} />
                </View>
              )}
            </View>
          )}

          {/* Sticky notes (mobile: colored cards; drag is web-only) */}
          <View style={{ marginTop: 12 }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <Text style={{ fontWeight: "700", fontSize: 14, color: "#2a2350" }}>🗒️ Sticky notes</Text>
              <TouchableOpacity
                onPress={() =>
                  patch(active.id, {
                    stickies: [
                      ...active.stickies,
                      { id: nbId(), text: "", color: NB_COLORS[active.stickies.length % NB_COLORS.length] },
                    ],
                  })
                }
              >
                <Text style={{ color: "#7b4bd0", fontWeight: "700", fontSize: 13 }}>＋ Add</Text>
              </TouchableOpacity>
            </View>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {active.stickies.map((s) => (
                <View
                  key={s.id}
                  style={{ width: "47%", minHeight: 80, borderRadius: 8, padding: 8, backgroundColor: NB_HIGHLIGHTS[s.color] }}
                >
                  <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
                    <Text
                      onPress={() =>
                        patch(active.id, { stickies: active.stickies.filter((x) => x.id !== s.id) })
                      }
                      style={{ fontSize: 15, color: "#2a2350" }}
                    >
                      ×
                    </Text>
                  </View>
                  <TextInput
                    value={s.text}
                    onChangeText={(t) =>
                      patch(active.id, {
                        stickies: active.stickies.map((x) => (x.id === s.id ? { ...x, text: t } : x)),
                      })
                    }
                    placeholder="Note…"
                    placeholderTextColor="#6b6280"
                    multiline
                    style={{ fontSize: 13, color: "#2a2350", minHeight: 44 }}
                  />
                </View>
              ))}
            </View>
          </View>
        </View>
      )}
    </ScrollView>
  );
}

function FlashcardDeck({
  cards,
  onMissed,
}: {
  cards: Flashcard[];
  onMissed: (topic: string) => void;
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
    <View style={styles.toolBox}>
      <View style={styles.toolHead}>
        <Text style={styles.toolTitle}>🃏 Flashcards</Text>
        <Text style={styles.planCount}>
          {i + 1}/{cards.length}
        </Text>
      </View>
      <TouchableOpacity
        style={styles.flashcard}
        onPress={() => setFlipped((f) => !f)}
        accessibilityLabel="Flip card"
      >
        <Text style={styles.flashcardLabel}>{flipped ? meta.back : meta.front}</Text>
        <Text style={styles.flashcardText}>{flipped ? card.back : card.front}</Text>
        <Text style={styles.flashcardHint}>
          {meta.emoji} {meta.label} · tap to flip
        </Text>
      </TouchableOpacity>
      <View style={styles.flashNav}>
        <TouchableOpacity
          style={[styles.smallBtn, i === 0 && styles.primaryBtnDisabled]}
          disabled={i === 0}
          onPress={() => go(-1)}
        >
          <Text style={styles.smallBtnText}>← Prev</Text>
        </TouchableOpacity>
        <Text style={styles.linkBtn} onPress={() => onMissed(card.front)}>
          Still learning
        </Text>
        <TouchableOpacity
          style={[styles.smallBtn, i === cards.length - 1 && styles.primaryBtnDisabled]}
          disabled={i === cards.length - 1}
          onPress={() => go(1)}
        >
          <Text style={styles.smallBtnText}>Next →</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function QuizView({
  quiz,
  onMissed,
  onStudyGuide,
}: {
  quiz: QuizQuestion[];
  onMissed: (topic: string) => void;
  onStudyGuide?: (detail: string) => void;
}) {
  const [answers, setAnswers] = useState<(number | null)[]>(() =>
    quiz.map(() => null),
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
      if (answers[i] !== q.answerIndex) onMissed(q.topic || q.question);
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
    <View style={styles.toolBox}>
      <View style={styles.toolHead}>
        <Text style={styles.toolTitle}>📝 Quiz</Text>
        {checked && (
          <Text style={styles.planCount}>
            {score}/{quiz.length}
          </Text>
        )}
      </View>
      {quiz.map((q, qi) => (
        <View key={qi} style={{ marginBottom: 12 }}>
          <Text style={styles.quizQ}>
            {qi + 1}. {q.question}
          </Text>
          {q.options.map((opt, oi) => {
            const picked = answers[qi] === oi;
            const correct = oi === q.answerIndex;
            let bg = "#fff";
            if (checked && correct) bg = "#d8efe0";
            else if (checked && picked && !correct) bg = "#f6dcdc";
            else if (picked) bg = "#f3ebfd";
            return (
              <TouchableOpacity
                key={oi}
                disabled={checked}
                onPress={() =>
                  setAnswers((a) => a.map((v, k) => (k === qi ? oi : v)))
                }
                style={[styles.quizOpt, { backgroundColor: bg }]}
              >
                <Text style={styles.quizOptText}>
                  {opt}
                  {checked && correct ? "  ✓" : ""}
                </Text>
              </TouchableOpacity>
            );
          })}
          {checked && !!q.explanation && (
            <Text style={styles.quizExplain}>{q.explanation}</Text>
          )}
        </View>
      ))}
      {!checked ? (
        <TouchableOpacity
          style={[styles.primaryBtn, !allAnswered && styles.primaryBtnDisabled]}
          disabled={!allAnswered}
          onPress={check}
        >
          <Text style={styles.primaryBtnText}>Check answers</Text>
        </TouchableOpacity>
      ) : (
        <Text style={styles.quizDone}>
          {score === quiz.length
            ? "🎉 Perfect! You've got this."
            : "Nice work — I'll help you revise the ones you missed."}
        </Text>
      )}
      {checked && wrong.length > 0 && onStudyGuide && (
        <TouchableOpacity
          style={[styles.primaryBtn, { marginTop: 8 }]}
          onPress={studyGuide}
        >
          <Text style={styles.primaryBtnText}>📚 Study guide on what I missed</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

// "Test yourself" flow: name a topic (or tap a class / weak area), pick how hard
// and how many questions, and Eliora generates a fresh multiple-choice quiz on
// demand — grounded in the topic, not in pasted material. Wrong answers still
// feed the weak-topics list and can spin up a targeted study guide via chat.
type QuizDifficulty =
  | "kindergarten"
  | "elementary"
  | "middle"
  | "high"
  | "college";

const QUIZ_DIFFICULTIES: { key: QuizDifficulty; label: string }[] = [
  { key: "kindergarten", label: "Kindergarten" },
  { key: "elementary", label: "Elementary" },
  { key: "middle", label: "Middle" },
  { key: "high", label: "High school" },
  { key: "college", label: "College" },
];

// ---------------------------------------------------------------------------
// Flashcards — the Quizlet-shaped study tool. Mirrors the web app's studio.
//
// Three screens in one: the deck shelf, the editor, and the study round. The
// editor is the point — Eliora drafts, the learner corrects, and the deck is
// honest about which side wrote each card.
//
// Decks persist in AsyncStorage, same local-first approach as the plan.
// ---------------------------------------------------------------------------

function newCardId(): string {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function FlashcardsScreen({
  profile,
  subjects,
  missed,
  onMissed,
}: {
  profile: LearnerProfile | null;
  subjects: string[];
  missed: string[];
  onMissed: (topic: string) => void;
}) {
  const [decks, setDecks] = useState<SavedDeck[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [studying, setStudying] = useState(false);

  const [topic, setTopic] = useState("");
  const [text, setText] = useState("");
  const [style, setStyle] = useState<FlashcardStyle | undefined>(undefined);
  const [difficulty, setDifficulty] = useState<QuizDifficulty>("high");
  const [count, setCount] = useState(12);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(DECKS_KEY);
        const saved = raw ? (JSON.parse(raw) as SavedDeck[]) : null;
        if (Array.isArray(saved)) setDecks(saved);
      } catch {
        /* ignore corrupt storage */
      }
      setLoaded(true);
    })();
  }, []);

  useEffect(() => {
    if (!loaded) return;
    AsyncStorage.setItem(DECKS_KEY, JSON.stringify(decks)).catch(() => {});
  }, [decks, loaded]);

  const deck = decks.find((d) => d.id === openId) ?? null;

  function patchDeck(id: string, fn: (d: SavedDeck) => SavedDeck) {
    setDecks((prev) =>
      prev.map((d) => (d.id === id ? { ...fn(d), updatedAt: Date.now() } : d)),
    );
  }

  const suggestions = Array.from(
    new Set([...subjects, ...missed].map((s) => s.trim()).filter(Boolean)),
  ).slice(0, 8);

  // Draft a deck, or (when `into` is given) draft more cards onto an open one.
  async function generate(into?: SavedDeck) {
    if (busy) return;
    const cleanTopic = topic.trim();
    const cleanText = text.trim();
    if (!into && !cleanTopic && !cleanText) return;
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        count,
        style,
        difficulty,
        focus: missed.slice(0, 8),
        profile: profile ?? undefined,
      };
      if (into) {
        // "More like these": keep the deck's framing, and tell her what's
        // already in it so she doesn't hand back the same cards reworded.
        body.topic = into.title;
        body.style = into.style ?? style;
        body.difficulty = into.difficulty ?? difficulty;
        body.existing = into.cards.map((c) => c.front);
      } else {
        if (cleanTopic) body.topic = cleanTopic;
        if (cleanText) body.material = cleanText;
      }

      const res = await expoFetch(`${API_BASE_URL}/api/flashcards`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.error || !Array.isArray(data.cards) || !data.cards.length) {
        setError(data.error || "I couldn't make cards from that. Try again.");
        return;
      }
      const cards = data.cards as DeckCard[];

      if (into) {
        patchDeck(into.id, (d) => ({ ...d, cards: [...d.cards, ...cards] }));
        return;
      }
      const now = Date.now();
      const fresh: SavedDeck = {
        id: `d${now.toString(36)}`,
        title: cleanTopic || "Untitled deck",
        cards,
        createdAt: now,
        updatedAt: now,
        style,
        difficulty,
        fromMaterial: cleanText ? "pasted notes" : undefined,
      };
      setDecks((prev) => [fresh, ...prev]);
      setOpenId(fresh.id);
      setTopic("");
      setText("");
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  // --- Study round ---------------------------------------------------------
  if (deck && studying) {
    return (
      <StudyRound
        deck={deck}
        onExit={() => setStudying(false)}
        onMissed={onMissed}
        onFinish={(known, learning) =>
          patchDeck(deck.id, (d) => ({ ...d, known, learning }))
        }
      />
    );
  }

  // --- Deck editor ---------------------------------------------------------
  if (deck) {
    const aiCount = deck.cards.filter((c) => c.source === "ai" && !c.edited).length;
    return (
      <View style={styles.card}>
        <View style={styles.cardHead}>
          <Text style={styles.cardClass}>🃏 Flashcards</Text>
          <Text style={styles.linkBtn} onPress={() => setOpenId(null)}>
            All decks
          </Text>
        </View>

        <TextInput
          style={[styles.assignInput, { marginTop: 10, fontWeight: "700" }]}
          value={deck.title}
          placeholder="Deck name"
          placeholderTextColor="#9aa39c"
          onChangeText={(v) => patchDeck(deck.id, (d) => ({ ...d, title: v }))}
        />

        <Text style={styles.fcNote}>
          {aiCount > 0
            ? "Eliora drafted these — read them before you drill them. Fix anything she got wrong and it stops counting as hers."
            : "Your deck, your wording. Edit any card, or add your own."}
        </Text>

        <View style={styles.fcActions}>
          <TouchableOpacity
            style={[styles.fcBtn, !deck.cards.length && styles.primaryBtnDisabled]}
            disabled={!deck.cards.length}
            onPress={() => setStudying(true)}
          >
            <Text style={styles.fcBtnText}>
              ▶️ Study {deck.cards.length} card{deck.cards.length === 1 ? "" : "s"}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.fcBtnGhost}
            onPress={() =>
              patchDeck(deck.id, (d) => ({
                ...d,
                cards: [
                  ...d.cards,
                  { id: newCardId(), front: "", back: "", source: "you" },
                ],
              }))
            }
          >
            <Text style={styles.fcBtnGhostText}>＋ Add a card</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.fcBtnGhost, busy && styles.primaryBtnDisabled]}
            disabled={busy}
            onPress={() => generate(deck)}
          >
            <Text style={styles.fcBtnGhostText}>
              {busy ? "Writing…" : "✦ More like these"}
            </Text>
          </TouchableOpacity>
        </View>
        {!!error && (
          <Text style={[styles.resultText, { color: "#c0392b", marginTop: 8 }]}>
            {error}
          </Text>
        )}

        {deck.cards.map((c, i) => (
          <View key={c.id} style={styles.fcEditRow}>
            <View style={styles.fcEditHead}>
              <Text style={styles.fcNum}>{i + 1}</Text>
              <Text
                style={[
                  styles.fcBadge,
                  (c.source === "you" || c.edited) && styles.fcBadgeYou,
                ]}
              >
                {c.source === "you" ? "✍️ You" : c.edited ? "✦ Edited" : "✦ AI"}
              </Text>
              {!!c.topic && <Text style={styles.fcTopic}>{c.topic}</Text>}
              <View style={{ flex: 1 }} />
              <Text
                style={styles.fcIconBtn}
                onPress={() =>
                  patchDeck(deck.id, (d) => ({
                    ...d,
                    cards: d.cards.map((x) =>
                      x.id === c.id ? { ...x, starred: !x.starred } : x,
                    ),
                  }))
                }
              >
                {c.starred ? "★" : "☆"}
              </Text>
              <Text
                style={styles.fcIconBtn}
                onPress={() =>
                  patchDeck(deck.id, (d) => ({
                    ...d,
                    cards: d.cards.filter((x) => x.id !== c.id),
                  }))
                }
              >
                ✕
              </Text>
            </View>
            <TextInput
              style={styles.fcEditFront}
              value={c.front}
              multiline
              placeholder="Front — the term or question"
              placeholderTextColor="#9aa39c"
              onChangeText={(v) =>
                patchDeck(deck.id, (d) => ({
                  ...d,
                  cards: d.cards.map((x) =>
                    x.id === c.id
                      ? { ...x, front: v, edited: x.source === "ai" }
                      : x,
                  ),
                }))
              }
            />
            <TextInput
              style={styles.fcEditBack}
              value={c.back}
              multiline
              placeholder="Back — the definition or answer"
              placeholderTextColor="#9aa39c"
              onChangeText={(v) =>
                patchDeck(deck.id, (d) => ({
                  ...d,
                  cards: d.cards.map((x) =>
                    x.id === c.id
                      ? { ...x, back: v, edited: x.source === "ai" }
                      : x,
                  ),
                }))
              }
            />
          </View>
        ))}
        {!deck.cards.length && (
          <Text style={styles.assignEmpty}>
            This deck is empty. Add a card, or ask Eliora for more.
          </Text>
        )}
      </View>
    );
  }

  // --- Deck shelf + draft form --------------------------------------------
  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <Text style={styles.cardClass}>🃏 Flashcards</Text>
      </View>
      <Text style={styles.assignEmpty}>
        Name a topic or paste your own notes — Eliora drafts the deck, you clean
        it up, then you flip through it.
      </Text>

      <View style={styles.assignAddRow}>
        <TextInput
          style={styles.assignInput}
          value={topic}
          placeholder="Cards on… (e.g. cell organelles)"
          placeholderTextColor="#9aa39c"
          onChangeText={setTopic}
          editable={!busy}
          onSubmitEditing={() => generate()}
        />
        <TouchableOpacity
          style={styles.assignAddBtn}
          onPress={() => generate()}
          disabled={busy || (!topic.trim() && !text.trim())}
        >
          <Text style={styles.assignAddBtnText}>{busy ? "…" : "Make"}</Text>
        </TouchableOpacity>
      </View>

      {suggestions.length > 0 && (
        <View style={styles.assignSubjRow}>
          {suggestions.map((s) => (
            <TouchableOpacity
              key={s}
              style={styles.assignSubjChip}
              disabled={busy}
              onPress={() => setTopic(s)}
            >
              <Text style={styles.assignSubjChipText}>
                {missed.includes(s) ? "🎯 " : "📁 "}
                {s}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      <TextInput
        style={styles.fcPaste}
        value={text}
        placeholder="…or paste the notes you want cards from"
        placeholderTextColor="#9aa39c"
        onChangeText={setText}
        editable={!busy}
        multiline
      />

      <Text style={[styles.quizQ, { marginTop: 14 }]}>Card style</Text>
      <View style={styles.assignSubjRow}>
        <TouchableOpacity
          disabled={busy}
          onPress={() => setStyle(undefined)}
          style={[
            styles.assignSubjChip,
            style === undefined && styles.assignSubjChipActive,
          ]}
        >
          <Text
            style={[
              styles.assignSubjChipText,
              style === undefined && styles.assignSubjChipTextActive,
            ]}
          >
            🎲 Mixed
          </Text>
        </TouchableOpacity>
        {FLASHCARD_STYLES.map((s) => (
          <TouchableOpacity
            key={s.key}
            disabled={busy}
            onPress={() => setStyle(s.key)}
            style={[
              styles.assignSubjChip,
              style === s.key && styles.assignSubjChipActive,
            ]}
          >
            <Text
              style={[
                styles.assignSubjChipText,
                style === s.key && styles.assignSubjChipTextActive,
              ]}
            >
              {s.emoji} {s.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <Text style={[styles.quizQ, { marginTop: 14 }]}>How hard?</Text>
      <View style={styles.assignSubjRow}>
        {QUIZ_DIFFICULTIES.map((d) => (
          <TouchableOpacity
            key={d.key}
            disabled={busy}
            onPress={() => setDifficulty(d.key)}
            style={[
              styles.assignSubjChip,
              difficulty === d.key && styles.assignSubjChipActive,
            ]}
          >
            <Text
              style={[
                styles.assignSubjChipText,
                difficulty === d.key && styles.assignSubjChipTextActive,
              ]}
            >
              {d.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <Text style={[styles.quizQ, { marginTop: 14 }]}>How many cards?</Text>
      <View style={styles.assignSubjRow}>
        {[8, 12, 20, 30].map((n) => (
          <TouchableOpacity
            key={n}
            disabled={busy}
            onPress={() => setCount(n)}
            style={[
              styles.assignSubjChip,
              count === n && styles.assignSubjChipActive,
            ]}
          >
            <Text
              style={[
                styles.assignSubjChipText,
                count === n && styles.assignSubjChipTextActive,
              ]}
            >
              {n}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {!!error && (
          <Text style={[styles.resultText, { color: "#c0392b", marginTop: 8 }]}>
            {error}
          </Text>
        )}

      {decks.length > 0 && (
        <>
          <Text style={[styles.quizQ, { marginTop: 18 }]}>Your decks</Text>
          {decks.map((d) => {
            const left = d.learning?.length ?? 0;
            return (
              <View key={d.id} style={styles.fcDeckRow}>
                <TouchableOpacity
                  style={styles.fcDeckOpen}
                  onPress={() => setOpenId(d.id)}
                >
                  <Text style={styles.fcDeckTitle}>{d.title}</Text>
                  <Text style={styles.fcDeckMeta}>
                    {d.cards.length} card{d.cards.length === 1 ? "" : "s"}
                    {d.fromMaterial ? ` · from ${d.fromMaterial}` : ""}
                    {left ? ` · ${left} still learning` : ""}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.fcBtn, !d.cards.length && styles.primaryBtnDisabled]}
                  disabled={!d.cards.length}
                  onPress={() => {
                    setOpenId(d.id);
                    setStudying(true);
                  }}
                >
                  <Text style={styles.fcBtnText}>▶️</Text>
                </TouchableOpacity>
                <Text
                  style={styles.fcIconBtn}
                  onPress={() => setDecks((prev) => prev.filter((x) => x.id !== d.id))}
                >
                  ✕
                </Text>
              </View>
            );
          })}
        </>
      )}
    </View>
  );
}

// One pass through a deck: flip the card, say whether you knew it, move on.
//
// "Still learning" is the useful half — those cards come back in the next round
// and get logged as weak areas, so the rest of Eliora knows what to aim at.
function StudyRound({
  deck,
  onExit,
  onMissed,
  onFinish,
}: {
  deck: SavedDeck;
  onExit: () => void;
  onMissed: (topic: string) => void;
  onFinish: (known: string[], learning: string[]) => void;
}) {
  // A round is a frozen list of ids: editing the deck mid-round shouldn't
  // shuffle the cards out from under the learner.
  const [round, setRound] = useState<string[]>(() =>
    deck.cards.filter((c) => c.front.trim()).map((c) => c.id),
  );
  const [i, setI] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [known, setKnown] = useState<string[]>([]);
  const [learning, setLearning] = useState<string[]>([]);

  const card = deck.cards.find((c) => c.id === round[i]);
  const done = i >= round.length;

  function mark(gotIt: boolean) {
    if (!card) return;
    const nextKnown = gotIt ? [...known, card.id] : known;
    const nextLearning = gotIt ? learning : [...learning, card.id];
    setKnown(nextKnown);
    setLearning(nextLearning);
    if (!gotIt) {
      // Feed the weak-area tracker the sub-concept, falling back to the front.
      const topic = (card.topic || card.front).trim();
      if (topic) onMissed(topic);
    }
    setFlipped(false);
    setI((n) => n + 1);
    // Last card: hand the tally back so "still learning" survives a reload.
    if (i + 1 >= round.length) onFinish(nextKnown, nextLearning);
  }

  function startRound(ids: string[]) {
    setRound(ids);
    setI(0);
    setFlipped(false);
    setKnown([]);
    setLearning([]);
  }

  if (done) {
    const total = known.length + learning.length;
    return (
      <View style={styles.card}>
        <View style={styles.cardHead}>
          <Text style={styles.cardClass}>🃏 {deck.title}</Text>
          <Text style={styles.linkBtn} onPress={onExit}>
            Edit deck
          </Text>
        </View>
        <Text style={styles.fcScore}>
          {known.length} / {total} known
        </Text>
        <Text style={styles.assignEmpty}>
          {learning.length
            ? `${learning.length} card${learning.length === 1 ? "" : "s"} to go again — they're saved as weak areas too.`
            : "Every card, first try. That deck is done."}
        </Text>
        <View style={styles.fcActions}>
          {learning.length > 0 && (
            <TouchableOpacity
              style={styles.fcBtn}
              onPress={() => startRound(learning)}
            >
              <Text style={styles.fcBtnText}>
                🔁 Just the {learning.length} I&apos;m still learning
              </Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={styles.fcBtnGhost}
            onPress={() =>
              startRound(deck.cards.filter((c) => c.front.trim()).map((c) => c.id))
            }
          >
            <Text style={styles.fcBtnGhostText}>↻ Whole deck again</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.fcBtnGhost} onPress={onExit}>
            <Text style={styles.fcBtnGhostText}>Done</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  if (!card) {
    return (
      <View style={styles.card}>
        <Text style={styles.assignEmpty}>Nothing to study yet.</Text>
        <TouchableOpacity style={styles.fcBtnGhost} onPress={onExit}>
          <Text style={styles.fcBtnGhostText}>Back to the deck</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const meta = flashcardStyleMeta(card.style);

  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <Text style={styles.cardClass}>🃏 {deck.title}</Text>
        <Text style={styles.linkBtn} onPress={onExit}>
          Edit deck
        </Text>
      </View>

      <View style={styles.fcBar}>
        <View
          style={[styles.fcBarFill, { width: `${(i / round.length) * 100}%` }]}
        />
      </View>
      <Text style={styles.fcCount}>
        {i + 1} of {round.length} · {known.length} known · {learning.length} still
        learning
      </Text>

      <TouchableOpacity
        style={styles.fcFace}
        onPress={() => setFlipped((f) => !f)}
        accessibilityLabel="Flip card"
      >
        {/* Name each side the way its style does — a cloze card's front is a
            "Fill in the blank", not a "Term". */}
        <Text style={styles.fcSide}>{flipped ? meta.back : meta.front}</Text>
        <Text style={styles.fcFaceText}>{flipped ? card.back : card.front}</Text>
        {!flipped && !!card.hint && (
          <Text style={styles.fcHint}>💡 {card.hint}</Text>
        )}
        <Text style={styles.fcTapHint}>Tap to flip</Text>
      </TouchableOpacity>

      {flipped ? (
        <View style={styles.fcActions}>
          <TouchableOpacity style={styles.fcBtnBad} onPress={() => mark(false)}>
            <Text style={styles.fcBtnBadText}>Still learning</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.fcBtnGood} onPress={() => mark(true)}>
            <Text style={styles.fcBtnGoodText}>Got it</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={styles.fcActions}>
          <TouchableOpacity style={styles.fcBtn} onPress={() => setFlipped(true)}>
            <Text style={styles.fcBtnText}>Show the answer</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

function PracticeQuiz({
  profile,
  subjects,
  missed,
  onMissed,
  onStudyGuide,
}: {
  profile: LearnerProfile | null;
  subjects: string[];
  missed: string[];
  onMissed: (topic: string) => void;
  onStudyGuide: (detail: string) => void;
}) {
  const [topic, setTopic] = useState("");
  const [difficulty, setDifficulty] = useState<QuizDifficulty>("high");
  const [count, setCount] = useState(5);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quiz, setQuiz] = useState<QuizQuestion[] | null>(null);
  const [quizTopic, setQuizTopic] = useState("");

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
      const res = await expoFetch(`${API_BASE_URL}/api/practice-quiz`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic: clean,
          count,
          difficulty,
          focus: missed.slice(0, 8),
          profile: profile ?? undefined,
        }),
      });
      const data = await res.json();
      if (data.error || !Array.isArray(data.quiz) || !data.quiz.length) {
        setError(
          data.error || "I couldn't build a quiz on that. Try another topic.",
        );
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

  return (
    <>
      <View style={styles.card}>
        <View style={styles.cardHead}>
          <Text style={styles.cardClass}>🧠 Practice quiz</Text>
        </View>
        <Text style={styles.assignEmpty}>
          Pick something to be quizzed on — a class, a topic, or something
          you&apos;ve been getting wrong. Eliora writes a fresh quiz just for you.
        </Text>

        {!quiz && (
          <>
            <View style={styles.assignAddRow}>
              <TextInput
                style={styles.assignInput}
                value={topic}
                placeholder="Quiz me on… (e.g. photosynthesis)"
                placeholderTextColor="#9aa39c"
                onChangeText={setTopic}
                editable={!busy}
                onSubmitEditing={() => generate(topic)}
              />
              <TouchableOpacity
                style={styles.assignAddBtn}
                onPress={() => generate(topic)}
                disabled={busy || !topic.trim()}
              >
                <Text style={styles.assignAddBtnText}>
                  {busy ? "…" : "Start"}
                </Text>
              </TouchableOpacity>
            </View>

            {suggestions.length > 0 && (
              <View style={styles.folderRow}>
                {suggestions.map((s) => (
                  <TouchableOpacity
                    key={s}
                    style={styles.folder}
                    disabled={busy}
                    onPress={() => {
                      setTopic(s);
                      generate(s);
                    }}
                  >
                    <Text style={styles.folderText}>
                      {missed.includes(s) ? "🎯 " : "📁 "}
                      {s}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}

            <Text style={[styles.quizQ, { marginTop: 14 }]}>How hard?</Text>
            <View style={styles.assignSubjRow}>
              {QUIZ_DIFFICULTIES.map((d) => (
                <TouchableOpacity
                  key={d.key}
                  disabled={busy}
                  onPress={() => setDifficulty(d.key)}
                  style={[
                    styles.assignSubjChip,
                    difficulty === d.key && styles.assignSubjChipActive,
                  ]}
                >
                  <Text
                    style={[
                      styles.assignSubjChipText,
                      difficulty === d.key && styles.assignSubjChipTextActive,
                    ]}
                  >
                    {d.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={[styles.quizQ, { marginTop: 14 }]}>
              How many questions?
            </Text>
            <View style={styles.assignSubjRow}>
              {[3, 5, 7, 10].map((n) => (
                <TouchableOpacity
                  key={n}
                  disabled={busy}
                  onPress={() => setCount(n)}
                  style={[
                    styles.assignSubjChip,
                    count === n && styles.assignSubjChipActive,
                  ]}
                >
                  <Text
                    style={[
                      styles.assignSubjChipText,
                      count === n && styles.assignSubjChipTextActive,
                    ]}
                  >
                    {n}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {error && (
              <Text style={[styles.assignEmpty, { color: "#b3453b" }]}>
                {error}
              </Text>
            )}
          </>
        )}
      </View>

      {busy && !quiz && (
        <View style={styles.card}>
          <Text style={styles.assignEmpty}>Writing your quiz… ✍️</Text>
        </View>
      )}

      {quiz && (
        <>
          <View style={styles.cardHead}>
            <Text style={styles.cardClass}>📝 {quizTopic}</Text>
            <TouchableOpacity
              style={styles.assignAddBtn}
              onPress={() => {
                setQuiz(null);
                setError(null);
              }}
            >
              <Text style={styles.assignAddBtnText}>← New</Text>
            </TouchableOpacity>
          </View>
          <QuizView
            quiz={quiz}
            onMissed={onMissed}
            onStudyGuide={onStudyGuide}
          />
        </>
      )}
    </>
  );
}

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
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <Text style={styles.cardClass}>📁 Subjects</Text>
        {subjects.length > 0 && (
          <Text style={styles.planCount}>{subjects.length}</Text>
        )}
      </View>
      <View style={styles.assignAddRow}>
        <TextInput
          style={styles.assignInput}
          value={name}
          onChangeText={setName}
          placeholder="Add a subject (e.g. Algebra 1)…"
          placeholderTextColor="#9b93b3"
          onSubmitEditing={add}
          returnKeyType="done"
        />
        <TouchableOpacity style={styles.assignAddBtn} onPress={add}>
          <Text style={styles.assignAddBtnText}>Add</Text>
        </TouchableOpacity>
      </View>
      {subjects.length > 0 ? (
        <View style={styles.folderRow}>
          {subjects.map((s) => (
            <View key={s} style={styles.folder}>
              <Text style={styles.folderText}>📁 {s}</Text>
              <Text style={styles.folderRemove} onPress={() => onRemove(s)}>
                ✕
              </Text>
            </View>
          ))}
        </View>
      ) : (
        <Text style={styles.assignEmpty}>
          No subjects yet. Add the classes you want help with.
        </Text>
      )}
    </View>
  );
}

function greetingFor(p: LearnerProfile): Message {
  const name = p.name?.trim() ? `, ${p.name.trim()}` : "";
  return {
    role: "assistant",
    content:
      `Hi${name} 💡 Thanks for sharing all that — I've got your info for ` +
      `${p.klass.trim()}. Want me to build your learning plan and find a few ` +
      `study videos to get started?`,
  };
}

// Additive merge: KEEP every existing milestone and append only new titles, so
// adopting a lesson plan never wipes the steps already on the study plan.
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

  const choiceGroup = (
    question: string,
    options: string[],
    value: string,
    setValue: (s: string) => void,
  ) => (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{question}</Text>
      {options.map((opt) => {
        const selected = value === opt;
        return (
          <TouchableOpacity
            key={opt}
            style={[styles.choiceBtn, selected && styles.choiceBtnSelected]}
            onPress={() => setValue(selected ? "" : opt)}
          >
            <View
              style={[
                styles.choiceRadio,
                selected && styles.choiceRadioSelected,
              ]}
            />
            <Text style={styles.choiceText}>{opt}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );

  // Multi-select variant — value is a comma-joined list.
  const multiChoiceGroup = (
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
      <View style={styles.field}>
        <Text style={styles.fieldLabel}>
          {question}{" "}
          <Text style={styles.choiceHint}>(select all that apply)</Text>
        </Text>
        {options.map((opt) => {
          const isSel = chosen.has(opt);
          return (
            <TouchableOpacity
              key={opt}
              style={[styles.choiceBtn, isSel && styles.choiceBtnSelected]}
              onPress={() => toggle(opt)}
            >
              <View
                style={[
                  styles.choiceCheckbox,
                  isSel && styles.choiceCheckboxSelected,
                ]}
              >
                {isSel && <Text style={styles.choiceCheckMark}>✓</Text>}
              </View>
              <Text style={styles.choiceText}>{opt}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
    );
  };

  const field = (
    label: string,
    value: string,
    setter: (s: string) => void,
    placeholder: string,
    multiline = false,
  ) => (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={[styles.formInput, multiline && styles.formTextarea]}
        value={value}
        onChangeText={setter}
        placeholder={placeholder}
        placeholderTextColor="#8b83a3"
        multiline={multiline}
        autoCorrect
        spellCheck
      />
    </View>
  );

  return (
    <View style={styles.container}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={styles.formScroll}>
        <Text style={styles.formTitle}>Welcome to Eliora 💡</Text>
        <Text style={styles.formIntro}>
          A few quick questions so I can build a learning plan that fits you. Only
          the class is required — share what you like.
        </Text>

        {field("Your name (optional)", name, setName, "What should I call you?")}
        {field(
          "What class are you taking? *",
          klass,
          setKlass,
          "e.g. Algebra 1, AP Biology, Intro Spanish",
        )}
        {field(
          "What do you struggle with while learning?",
          struggles,
          setStruggles,
          "e.g. focus, reading, remembering, test anxiety",
          true,
        )}
        {field(
          "How do you like to learn?",
          learningStyle,
          setLearningStyle,
          "e.g. videos, examples, hands-on, talking it through",
          true,
        )}
        {field(
          "What do you like to do? (hobbies / interests)",
          interests,
          setInterests,
          "e.g. soccer, drawing, video games, music",
          true,
        )}
        {field(
          "What has worked for you in the past? (optional)",
          pastSuccess,
          setPastSuccess,
          "e.g. flashcards, studying with a friend, short sessions",
          true,
        )}

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

        {choiceGroup(
          "What grade or year are you currently in?",
          GRADE_YEAR_OPTIONS,
          gradeYear,
          setGradeYear,
        )}

        {field(
          "What subjects are you currently studying?",
          subjectsStudying,
          setSubjectsStudying,
          "e.g. World History, Algebra 2, Chemistry, Spanish",
        )}

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

        {field(
          "How do you struggle or need help in your studies the most? (optional)",
          needHelpMost,
          setNeedHelpMost,
          "In your own words — anything you want me to know",
          true,
        )}

        <View style={styles.formActions}>
          {onCancel && (
            <TouchableOpacity style={styles.secondaryBtn} onPress={onCancel}>
              <Text style={styles.secondaryBtnText}>Cancel</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={[styles.primaryBtn, !canSubmit && styles.primaryBtnDisabled]}
            onPress={submit}
            disabled={!canSubmit}
          >
            <Text style={styles.primaryBtnText}>
              {initial ? "Save" : "Start learning"}
            </Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </View>
  );
}

// Short intake survey that gathers what Eliora needs to build a good after-school
// schedule — when the learner is free, how much time they have, when/how they
// focus, and what to prioritize — then hands the answers to the schedule builder.
function ScheduleSetupSurvey({
  visible,
  onClose,
  initial,
  onSubmit,
}: {
  visible: boolean;
  onClose: () => void;
  initial?: {
    homeTime?: string;
    focusTime?: string;
    sessionLength?: string;
    focusHelp?: string;
  };
  onSubmit: (a: {
    homeTime: string;
    budget: string;
    focusTime: string;
    sessionLength: string;
    focusHelp: string;
    focusNote: string;
  }) => void;
}) {
  const [homeTime, setHomeTime] = useState(initial?.homeTime ?? "");
  const [budget, setBudget] = useState("");
  const [focusTime, setFocusTime] = useState(initial?.focusTime ?? "");
  const [sessionLength, setSessionLength] = useState(
    initial?.sessionLength ?? "",
  );
  const [focusHelp, setFocusHelp] = useState(initial?.focusHelp ?? "");
  const [focusNote, setFocusNote] = useState("");

  const canSubmit = homeTime.length > 0;

  const choiceGroup = (
    question: string,
    options: string[],
    value: string,
    setValue: (s: string) => void,
  ) => (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{question}</Text>
      {options.map((opt) => {
        const selected = value === opt;
        return (
          <TouchableOpacity
            key={opt}
            style={[styles.choiceBtn, selected && styles.choiceBtnSelected]}
            onPress={() => setValue(selected ? "" : opt)}
          >
            <View
              style={[
                styles.choiceRadio,
                selected && styles.choiceRadioSelected,
              ]}
            />
            <Text style={styles.choiceText}>{opt}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );

  // Like choiceGroup but multi-select — value is a comma-joined list.
  const multiChoiceGroup = (
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
      <View style={styles.field}>
        <Text style={styles.fieldLabel}>
          {question}{" "}
          <Text style={styles.choiceHint}>(select all that apply)</Text>
        </Text>
        {options.map((opt) => {
          const isSel = chosen.has(opt);
          return (
            <TouchableOpacity
              key={opt}
              style={[styles.choiceBtn, isSel && styles.choiceBtnSelected]}
              onPress={() => toggle(opt)}
            >
              <View
                style={[
                  styles.choiceCheckbox,
                  isSel && styles.choiceCheckboxSelected,
                ]}
              >
                {isSel && <Text style={styles.choiceCheckMark}>✓</Text>}
              </View>
              <Text style={styles.choiceText}>{opt}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
    );
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.container}>
        <ScrollView contentContainerStyle={styles.formScroll}>
          <View style={styles.modalHead}>
            <Text style={styles.formTitle}>Set up my schedule</Text>
            <Text style={styles.linkBtn} onPress={onClose}>
              Close
            </Text>
          </View>
          <Text style={styles.schedHint}>
            A few quick questions so I can build today&apos;s study plan around
            you. You can tweak the blocks after.
          </Text>

          {choiceGroup(
            "When are you usually free to study?",
            HOME_TIME_OPTIONS,
            homeTime,
            setHomeTime,
          )}
          {choiceGroup(
            "How much study time do you want today?",
            STUDY_BUDGET_OPTIONS,
            budget,
            setBudget,
          )}
          {choiceGroup(
            "When do you focus best?",
            FOCUS_TIME_OPTIONS,
            focusTime,
            setFocusTime,
          )}
          {choiceGroup(
            "How long can you focus in one sitting?",
            SESSION_LENGTH_OPTIONS,
            sessionLength,
            setSessionLength,
          )}
          {multiChoiceGroup(
            "What helps you focus?",
            FOCUS_HELP_OPTIONS,
            focusHelp,
            setFocusHelp,
          )}

          <View style={styles.field}>
            <Text style={styles.fieldLabel}>
              Anything today&apos;s schedule should prioritize? (optional)
            </Text>
            <TextInput
              style={[styles.formInput, styles.formTextarea]}
              value={focusNote}
              onChangeText={setFocusNote}
              placeholder="e.g. Bio exam Friday, catch up on algebra"
              placeholderTextColor="#9aa39c"
              multiline
            />
          </View>

          <TouchableOpacity
            style={[styles.primaryBtn, !canSubmit && styles.primaryBtnDisabled]}
            disabled={!canSubmit}
            onPress={() => {
              if (!canSubmit) return;
              onSubmit({
                homeTime,
                budget,
                focusTime,
                sessionLength,
                focusHelp,
                focusNote: focusNote.trim(),
              });
              onClose();
            }}
          >
            <Text style={styles.primaryBtnText}>✨ Build my schedule</Text>
          </TouchableOpacity>
        </ScrollView>
      </View>
    </Modal>
  );
}

// Today's 9am–9pm day plan with an editable text block per hour, a block-type
// tag (study/break/class/other), an AI "build" button, and a per-task focus
// countdown timer. One timer runs at a time.
function ScheduleCard({
  schedule,
  onSet,
  onClear,
  homeHour,
  onSetHomeHour,
  onGenerate,
  onSetup,
  generating,
}: {
  schedule: DaySchedule | null;
  onSet: (hour: number, patch: Partial<ScheduleBlock>) => void;
  onClear: () => void;
  homeHour: number;
  onSetHomeHour: (h: number) => void;
  onGenerate: () => void;
  onSetup: () => void;
  generating: boolean;
}) {
  const today = todayISO();
  const fresh = schedule && schedule.date === today ? schedule : null;
  const blocks = fresh?.blocks ?? {};
  const currentHour = new Date().getHours();
  const filled = SCHEDULE_HOURS.filter(
    (h) => (blocks[h]?.text ?? "").trim(),
  ).length;

  const [timer, setTimer] = useState<{
    hour: number;
    left: number;
    running: boolean;
  } | null>(null);
  useEffect(() => {
    if (!timer?.running) return;
    const id = setInterval(() => {
      setTimer((t) => {
        if (!t || !t.running) return t;
        if (t.left <= 1) {
          Vibration.vibrate([0, 250, 120, 250]);
          return { ...t, left: 0, running: false };
        }
        return { ...t, left: t.left - 1 };
      });
    }, 1000);
    return () => clearInterval(id);
  }, [timer?.running, timer?.hour]);
  const startTimer = (h: number) =>
    setTimer({ hour: h, left: TIMER_DEFAULT_MIN * 60, running: true });
  const toggleTimer = (h: number) =>
    setTimer((t) =>
      t && t.hour === h
        ? t.left <= 0
          ? { hour: h, left: TIMER_DEFAULT_MIN * 60, running: true }
          : { ...t, running: !t.running }
        : { hour: h, left: TIMER_DEFAULT_MIN * 60, running: true },
    );

  const cycleKind = (h: number) => {
    const cur = blocks[h]?.kind ?? "study";
    const idx = SCHEDULE_KINDS.findIndex((k) => k.key === cur);
    onSet(h, { kind: SCHEDULE_KINDS[(idx + 1) % SCHEDULE_KINDS.length].key });
  };

  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <Text style={styles.cardClass}>🕘 Today&apos;s schedule</Text>
        <Text style={styles.subjectsCount}>
          {filled ? `${filled} planned` : ""}
        </Text>
      </View>
      <Text style={styles.schedHint}>
        Plan 9 AM–9 PM, or let me build study time around when you get home. Tap a
        block&apos;s tag to change study / break / class, and ⏱ to run a{" "}
        {TIMER_DEFAULT_MIN}-min focus timer.
      </Text>
      <TouchableOpacity style={styles.schedSetupBtn} onPress={onSetup}>
        <Text style={styles.schedSetupBtnText}>📝 Set up my schedule</Text>
      </TouchableOpacity>
      <View style={styles.schedBuildRow}>
        <Text style={styles.schedBuildLabel}>I get home at</Text>
        <View style={styles.schedStepper}>
          <TouchableOpacity
            style={styles.schedStepBtn}
            onPress={() => onSetHomeHour(Math.max(11, homeHour - 1))}
            accessibilityLabel="Earlier home time"
          >
            <Text style={styles.schedStepBtnText}>−</Text>
          </TouchableOpacity>
          <Text style={styles.schedStepVal}>{hourLabel(homeHour)}</Text>
          <TouchableOpacity
            style={styles.schedStepBtn}
            onPress={() => onSetHomeHour(Math.min(20, homeHour + 1))}
            accessibilityLabel="Later home time"
          >
            <Text style={styles.schedStepBtnText}>+</Text>
          </TouchableOpacity>
        </View>
      </View>
      <TouchableOpacity
        style={styles.schedBuildBtn}
        disabled={generating}
        onPress={onGenerate}
      >
        {generating ? (
          <ActivityIndicator color="#7b4bd0" />
        ) : (
          <Text style={styles.schedBuildBtnText}>
            ✨ Build my study schedule
          </Text>
        )}
      </TouchableOpacity>
      <View style={styles.schedList}>
        {SCHEDULE_HOURS.map((h) => {
          const b = blocks[h];
          const hasText = !!(b?.text ?? "").trim();
          const kind = scheduleKind(b?.kind ?? "study");
          const isNow = h === currentHour;
          return (
            <View
              key={h}
              style={[
                styles.schedRow,
                isNow && styles.schedRowNow,
                { borderLeftColor: hasText ? kind.color : "#efe4f0" },
              ]}
            >
              <View style={styles.schedTimeWrap}>
                <Text style={styles.schedTime}>{hourLabel(h)}</Text>
                {isNow && <Text style={styles.schedNowDot}>NOW</Text>}
              </View>
              <TouchableOpacity
                style={styles.schedKind}
                onPress={() => cycleKind(h)}
                accessibilityLabel={`Block type: ${kind.label}. Tap to change.`}
              >
                <Text
                  style={[styles.schedKindEmoji, !hasText && { opacity: 0.4 }]}
                >
                  {kind.emoji}
                </Text>
              </TouchableOpacity>
              <TextInput
                style={styles.schedInput}
                value={b?.text ?? ""}
                placeholder={isNow ? "Now — what's the plan?" : "—"}
                placeholderTextColor="#9b93b3"
                onChangeText={(text) => onSet(h, { text })}
              />
              {hasText &&
                (timer && timer.hour === h ? (
                  <View style={styles.schedTimer}>
                    <TouchableOpacity
                      style={styles.schedTimerBtn}
                      onPress={() => toggleTimer(h)}
                      accessibilityLabel={
                        timer.left <= 0
                          ? "Restart timer"
                          : timer.running
                            ? "Pause timer"
                            : "Resume timer"
                      }
                    >
                      <Text style={styles.schedTimerBtnText}>
                        {timer.left <= 0 ? "↺" : timer.running ? "⏸" : "▶"}
                      </Text>
                    </TouchableOpacity>
                    <Text
                      style={[
                        styles.schedTimerTime,
                        timer.left <= 0 && styles.schedTimerDone,
                      ]}
                    >
                      {timer.left <= 0 ? "done ✓" : fmtTimer(timer.left)}
                    </Text>
                    <TouchableOpacity
                      style={styles.schedTimerClear}
                      onPress={() => setTimer(null)}
                      accessibilityLabel="Clear timer"
                    >
                      <Text style={styles.schedTimerClearText}>✕</Text>
                    </TouchableOpacity>
                  </View>
                ) : (
                  <TouchableOpacity
                    style={styles.schedTimerStart}
                    onPress={() => startTimer(h)}
                    accessibilityLabel={`Start a ${TIMER_DEFAULT_MIN}-minute focus timer for this block`}
                  >
                    <Text style={styles.schedTimerStartText}>⏱</Text>
                  </TouchableOpacity>
                ))}
            </View>
          );
        })}
      </View>
      {filled > 0 && (
        <TouchableOpacity
          style={styles.schedClearRow}
          onPress={onClear}
          accessibilityLabel="Clear today's schedule"
        >
          <Text style={styles.linkBtn}>Clear day</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

// Turn "HH:MM" (24h) into a friendly label like "9:00 AM".
function timeLabel(hhmm: string): string {
  const [h, m] = hhmm.split(":").map((n) => parseInt(n, 10));
  const ampm = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

// Daily check-in reminder: a toggle plus an hour/minute stepper for the local
// time Eliora pushes a notification and opens a check-in chat.
function CheckInCard({
  prefs,
  onChange,
}: {
  prefs: CheckInPrefs;
  onChange: (p: CheckInPrefs) => void;
}) {
  const [h, m] = prefs.time.split(":").map((n) => parseInt(n, 10));
  const setTime = (hh: number, mm: number) =>
    onChange({
      ...prefs,
      time: `${String((hh + 24) % 24).padStart(2, "0")}:${String(mm).padStart(2, "0")}`,
    });
  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <Text style={styles.cardClass}>🔔 Daily check-in</Text>
        <TouchableOpacity
          onPress={() => onChange({ ...prefs, enabled: !prefs.enabled })}
        >
          <Text style={styles.linkBtn}>{prefs.enabled ? "On" : "Off"}</Text>
        </TouchableOpacity>
      </View>
      <Text style={styles.schedHint}>
        I&apos;ll send a gentle nudge once a day and open a quick check-in chat
        when you tap it.
      </Text>
      {prefs.enabled ? (
        <View style={styles.schedBuildRow}>
          <Text style={styles.schedBuildLabel}>Remind me at</Text>
          <View style={styles.schedStepper}>
            <TouchableOpacity
              style={styles.schedStepBtn}
              onPress={() => setTime(h - 1, m)}
              accessibilityLabel="Earlier check-in hour"
            >
              <Text style={styles.schedStepBtnText}>−</Text>
            </TouchableOpacity>
            <Text style={styles.schedStepVal}>{timeLabel(prefs.time)}</Text>
            <TouchableOpacity
              style={styles.schedStepBtn}
              onPress={() => setTime(h + 1, m)}
              accessibilityLabel="Later check-in hour"
            >
              <Text style={styles.schedStepBtnText}>+</Text>
            </TouchableOpacity>
          </View>
          <TouchableOpacity
            style={styles.schedStepBtn}
            onPress={() => setTime(h, (m + 15) % 60)}
            accessibilityLabel="Adjust minutes"
          >
            <Text style={styles.schedStepBtnText}>:{String(m).padStart(2, "0")}</Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </View>
  );
}

export default function App() {
  const [chats, setChats] = useState<Chat[]>([]);
  const [activeChatId, setActiveChatId] = useState<string>("");
  const activeChat = chats.find((c) => c.id === activeChatId);
  const messages = activeChat?.messages ?? [];
  // The "first session": the oldest conversation where they actually worked on
  // something. Chats are appended in order, so the first with two real turns is
  // it — a one-line "hi" chat isn't a session anyone could plan from.
  const firstSession =
    chats.find((c) => c.messages.filter((m) => m.role === "user").length >= 2) ??
    null;
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
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");
  const [folders, setFolders] = useState<ChatFolder[]>([]);
  const [activeFolder, setActiveFolder] = useState<string | null>(null);
  const [newFolderText, setNewFolderText] = useState("");
  function renameChat(id: string, raw: string) {
    const title = raw.trim();
    setChats((prev) =>
      prev.map((c) =>
        c.id === id
          ? { ...c, title: title || c.title, named: title ? true : c.named }
          : c,
      ),
    );
    setRenamingId(null);
  }
  function createFolder(name: string): string | null {
    const n = name.trim();
    if (!n) return null;
    const id = `f${Date.now().toString(36)}`;
    setFolders((prev) => [...prev, { id, name: n }]);
    return id;
  }
  function deleteFolder(id: string) {
    setFolders((prev) => prev.filter((f) => f.id !== id));
    setChats((prev) =>
      prev.map((c) => (c.folderId === id ? { ...c, folderId: undefined } : c)),
    );
    if (activeFolder === id) setActiveFolder(null);
  }
  function moveChatToFolder(chatId: string, folderId: string | undefined) {
    setChats((prev) =>
      prev.map((c) => (c.id === chatId ? { ...c, folderId } : c)),
    );
  }
  const [profile, setProfile] = useState<LearnerProfile | null>(null);
  const [plan, setPlan] = useState<Milestone[]>([]);
  const [events, setEvents] = useState<StudyEvent[]>([]);
  const [missed, setMissed] = useState<string[]>([]);
  const [subjects, setSubjects] = useState<string[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [goals, setGoals] = useState<SmartGoal[]>([]);
  const [schedule, setSchedule] = useState<DaySchedule | null>(null);
  const [homeHour, setHomeHour] = useState(16); // default 4 PM
  const [scheduleSurveyOpen, setScheduleSurveyOpen] = useState(false);
  // Latest schedule-survey answers: today's study-minute cap and what to focus on.
  const [scheduleBudgetMin, setScheduleBudgetMin] = useState<number | undefined>(
    undefined,
  );
  const [scheduleFocusNote, setScheduleFocusNote] = useState("");
  // Daily check-in push notification prefs (enabled + local time "HH:MM").
  const [checkIn, setCheckIn] = useState<CheckInPrefs>({
    enabled: true,
    time: DEFAULT_CHECKIN_TIME,
  });
  // Set when a daily check-in notification is tapped; consumed once chat is
  // ready (may fire on a cold start before storage has loaded).
  const [pendingCheckIn, setPendingCheckIn] = useState(false);
  const [generatingSchedule, setGeneratingSchedule] = useState(false);
  const [breakingGoalId, setBreakingGoalId] = useState<string | null>(null);
  const [breakingAssignmentId, setBreakingAssignmentId] = useState<
    string | null
  >(null);
  const [editing, setEditing] = useState(false);
  const [summarizing, setSummarizing] = useState(false);
  const [tab, setTab] = useState<
    "chat" | "study" | "practice" | "calendar" | "plan" | "notebook"
  >("chat");
  // Sub-tab within the Study tab; lives here (not inside the Study view) so it
  // survives switching to another top-level tab and back.
  const [studySection, setStudySection] = useState<
    "overview" | "plan" | "notes" | "lessons" | "flashcards"
  >("overview");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [autoBuild, setAutoBuild] = useState(false);
  const [showClassSurvey, setShowClassSurvey] = useState(false);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const listRef = useRef<FlatList<Message>>(null);

  // Restore saved profile + plan + conversation.
  useEffect(() => {
    (async () => {
      try {
        const rawP = await AsyncStorage.getItem(PROFILE_KEY);
        const savedProfile = rawP ? (JSON.parse(rawP) as LearnerProfile) : null;
        if (savedProfile) setProfile(savedProfile);

        const rawPlan = await AsyncStorage.getItem(PLAN_KEY);
        const savedPlan = rawPlan ? (JSON.parse(rawPlan) as Milestone[]) : null;
        if (Array.isArray(savedPlan)) setPlan(savedPlan);

        const rawEvents = await AsyncStorage.getItem(EVENTS_KEY);
        const savedEvents = rawEvents
          ? (JSON.parse(rawEvents) as StudyEvent[])
          : null;
        if (Array.isArray(savedEvents)) setEvents(savedEvents);

        const rawMissed = await AsyncStorage.getItem(MISSED_KEY);
        const savedMissed = rawMissed ? (JSON.parse(rawMissed) as string[]) : null;
        if (Array.isArray(savedMissed)) setMissed(savedMissed);

        const rawSubjects = await AsyncStorage.getItem(SUBJECTS_KEY);
        const savedSubjects = rawSubjects
          ? (JSON.parse(rawSubjects) as string[])
          : null;
        if (Array.isArray(savedSubjects)) setSubjects(savedSubjects);

        const rawAssign = await AsyncStorage.getItem(ASSIGNMENTS_KEY);
        const savedAssign = rawAssign
          ? (JSON.parse(rawAssign) as Assignment[])
          : null;
        if (Array.isArray(savedAssign)) setAssignments(savedAssign);

        const rawGoals = await AsyncStorage.getItem(GOALS_KEY);
        const savedGoals = rawGoals
          ? (JSON.parse(rawGoals) as SmartGoal[])
          : null;
        if (Array.isArray(savedGoals)) setGoals(savedGoals);

        const rawSched = await AsyncStorage.getItem(SCHEDULE_KEY);
        const savedSched = rawSched
          ? (JSON.parse(rawSched) as DaySchedule)
          : null;
        // Only restore if it's for today — a day plan starts fresh each morning.
        if (savedSched && savedSched.date === todayISO())
          setSchedule(savedSched);

        const rawHome = await AsyncStorage.getItem(HOMETIME_KEY);
        const savedHome = rawHome ? parseInt(rawHome, 10) : NaN;
        if (savedHome >= 11 && savedHome <= 20) setHomeHour(savedHome);

        const rawDismissed = await AsyncStorage.getItem(REM_DISMISSED_KEY);
        const savedDismissed = rawDismissed
          ? (JSON.parse(rawDismissed) as string[])
          : null;
        if (Array.isArray(savedDismissed)) setDismissed(savedDismissed);

        const rawFolders = await AsyncStorage.getItem(CHAT_FOLDERS_KEY);
        const savedFolders = rawFolders
          ? (JSON.parse(rawFolders) as ChatFolder[])
          : null;
        if (Array.isArray(savedFolders)) setFolders(savedFolders);

        const rawChats = await AsyncStorage.getItem(CHATS_KEY);
        let loadedChats = rawChats ? (JSON.parse(rawChats) as Chat[]) : null;
        if (!Array.isArray(loadedChats) || !loadedChats.length) {
          const old = await AsyncStorage.getItem(STORAGE_KEY);
          const msgs: Message[] = old
            ? (JSON.parse(old) as Message[])
            : savedProfile
              ? [greetingFor(savedProfile)]
              : [];
          loadedChats = [
            { id: newChatId(), title: chatTitle(msgs), messages: msgs },
          ];
        }
        setChats(loadedChats);
        const savedActive = await AsyncStorage.getItem(ACTIVE_KEY);
        setActiveChatId(
          loadedChats.find((c) => c.id === savedActive)?.id ?? loadedChats[0].id,
        );
      } catch {
        /* ignore corrupt storage */
      }
      setLoaded(true);
    })();
  }, []);

  // Persist chats — debounced so streaming doesn't thrash storage, but it saves
  // DURING a reply (not only after) so nothing is lost if the app is closed or
  // backgrounded mid-stream.
  const saveRef = useRef({ chats, activeChatId });
  saveRef.current = { chats, activeChatId };
  const flushChats = () => {
    const { chats: cs, activeChatId: act } = saveRef.current;
    if (!cs.length) return;
    AsyncStorage.setItem(CHATS_KEY, JSON.stringify(cs)).catch(() => {});
    AsyncStorage.setItem(ACTIVE_KEY, act).catch(() => {});
  };
  useEffect(() => {
    if (!loaded || !chats.length) return;
    const id = setTimeout(flushChats, 400);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chats, activeChatId, loaded]);

  // Flush immediately when the app is backgrounded/closed.
  useEffect(() => {
    if (!loaded) return;
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "inactive" || s === "background") flushChats();
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  useEffect(() => {
    if (!loaded) return;
    AsyncStorage.setItem(PLAN_KEY, JSON.stringify(plan)).catch(() => {});
  }, [plan, loaded]);

  useEffect(() => {
    if (!loaded) return;
    AsyncStorage.setItem(EVENTS_KEY, JSON.stringify(events)).catch(() => {});
  }, [events, loaded]);

  function addEvent(e: StudyEvent) {
    setEvents((prev) => (prev.some((x) => x.id === e.id) ? prev : [...prev, e]));
  }
  function removeEvent(id: string) {
    setEvents((prev) => prev.filter((x) => x.id !== id));
  }

  useEffect(() => {
    if (!loaded) return;
    AsyncStorage.setItem(ASSIGNMENTS_KEY, JSON.stringify(assignments)).catch(
      () => {},
    );
  }, [assignments, loaded]);

  useEffect(() => {
    if (!loaded) return;
    AsyncStorage.setItem(REM_DISMISSED_KEY, JSON.stringify(dismissed)).catch(
      () => {},
    );
  }, [dismissed, loaded]);

  useEffect(() => {
    if (!loaded) return;
    AsyncStorage.setItem(CHAT_FOLDERS_KEY, JSON.stringify(folders)).catch(
      () => {},
    );
  }, [folders, loaded]);

  function addAssignment(a: { title: string; subject?: string; due?: string }) {
    const title = a.title.trim();
    if (!title) return;
    setAssignments((prev) => [
      ...prev,
      {
        id: `a${Date.now().toString(36)}`,
        title,
        subject: a.subject?.trim() || undefined,
        due: a.due || undefined,
        done: false,
      },
    ]);
  }
  function toggleAssignment(id: string) {
    setAssignments((prev) =>
      prev.map((a) => (a.id === id ? { ...a, done: !a.done } : a)),
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
  async function breakDownAssignment(a: Assignment) {
    if (breakingAssignmentId) return;
    setBreakingAssignmentId(a.id);
    try {
      const res = await fetch(`${API_BASE_URL}/api/breakdown`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task: a.title,
          subject: a.subject,
          due: a.due,
          today: todayISO(),
          context: a.concern,
          profile: profile ?? undefined,
        }),
      });
      const data = (await res.json()) as {
        breakdown?: { steps?: Omit<TaskStep, "done" | "due">[] };
      };
      const steps = data.breakdown?.steps ?? [];
      if (steps.length) {
        // Re-running keeps whatever was already ticked off, matched by title —
        // losing progress is a reason never to press the button twice.
        const before = new Map(
          (a.steps ?? []).map((s) => [s.title.toLowerCase(), s] as const),
        );
        const dues = paceStepDates(steps.length, a.due);
        setAssignments((prev) =>
          prev.map((x) =>
            x.id === a.id
              ? {
                  ...x,
                  steps: steps.map((s, i) => {
                    const prev = before.get(s.title.toLowerCase());
                    return {
                      ...s,
                      due: prev?.due ?? dues[i],
                      done: !!prev?.done,
                    };
                  }),
                }
              : x,
          ),
        );
      }
    } catch {
      /* ignore — the button can be tapped again */
    } finally {
      setBreakingAssignmentId(null);
    }
  }
  function toggleAssignmentStep(id: string, index: number) {
    setAssignments((prev) =>
      prev.map((a) =>
        a.id === id
          ? {
              ...a,
              steps: (a.steps ?? []).map((s, i) =>
                i === index ? { ...s, done: !s.done } : s,
              ),
            }
          : a,
      ),
    );
  }
  function clearAssignmentSteps(id: string) {
    setAssignments((prev) =>
      prev.map((a) => (a.id === id ? { ...a, steps: undefined } : a)),
    );
  }

  // Persist SMART goals.
  useEffect(() => {
    if (!loaded) return;
    AsyncStorage.setItem(GOALS_KEY, JSON.stringify(goals)).catch(() => {});
  }, [goals, loaded]);

  // Persist today's schedule and the learner's home time.
  useEffect(() => {
    if (!loaded) return;
    if (schedule) {
      AsyncStorage.setItem(SCHEDULE_KEY, JSON.stringify(schedule)).catch(
        () => {},
      );
    } else {
      AsyncStorage.removeItem(SCHEDULE_KEY).catch(() => {});
    }
  }, [schedule, loaded]);
  useEffect(() => {
    if (!loaded) return;
    AsyncStorage.setItem(HOMETIME_KEY, String(homeHour)).catch(() => {});
  }, [homeHour, loaded]);

  // --- Daily check-in push notifications ------------------------------------
  // Load saved reminder prefs once on mount.
  useEffect(() => {
    loadCheckInPrefs()
      .then(setCheckIn)
      .catch(() => {});
  }, []);

  // Persist prefs and (re)register this device with the server whenever the
  // reminder changes. Debounced so dragging the time doesn't spam the API.
  useEffect(() => {
    if (!loaded) return;
    saveCheckInPrefs(checkIn).catch(() => {});
    const id = setTimeout(() => {
      syncCheckInRegistration(checkIn, profile?.name).catch(() => {});
    }, 500);
    return () => clearTimeout(id);
  }, [checkIn, loaded, profile?.name]);

  // A tapped check-in notification (foreground, background, or cold start) opens
  // the daily check-in chat. Flag it here; the effect below fires it once chat
  // is ready.
  useEffect(() => {
    const isCheckIn = (r: Notifications.NotificationResponse | null) =>
      r?.notification.request.content.data?.type === "daily-check-in";
    const sub = Notifications.addNotificationResponseReceivedListener((r) => {
      if (isCheckIn(r)) setPendingCheckIn(true);
    });
    Notifications.getLastNotificationResponseAsync()
      .then((r) => {
        if (isCheckIn(r)) setPendingCheckIn(true);
      })
      .catch(() => {});
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (!loaded || !pendingCheckIn || busy) return;
    setPendingCheckIn(false);
    startCheckIn();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, pendingCheckIn, busy]);

  // Take the learner to chat and have Eliora open the daily check-in.
  function startCheckIn() {
    setTab("chat");
    send(CHECK_IN_CHAT_PROMPT, { hidden: true });
  }

  // Update one hour block of today's schedule (starting a fresh day if needed).
  const setScheduleBlock = (hour: number, patch: Partial<ScheduleBlock>) => {
    const today = todayISO();
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
  const clearSchedule = () => setSchedule({ date: todayISO(), blocks: {} });

  // Ask Eliora to fill the day around the learner's home time, plan, goals and
  // assignments — mirrors the web "Build my study schedule" button.
  const generateStudySchedule = async (opts?: {
    homeHour?: number;
    budgetMin?: number;
    focusNote?: string;
  }) => {
    if (generatingSchedule) return;
    setGeneratingSchedule(true);
    try {
      const budgetMin = opts?.budgetMin ?? scheduleBudgetMin;
      const focusNote = (opts?.focusNote ?? scheduleFocusNote).trim();
      const res = await fetch(`${API_BASE_URL}/api/suggest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "schedule",
          homeHour: opts?.homeHour ?? homeHour,
          budgetMin: budgetMin || undefined,
          focusNote: focusNote || undefined,
          profile: profile ?? undefined,
          plan: plan.filter((m) => !m.done).map((m) => m.title),
          assignments: assignments
            .filter((a) => !a.done)
            .map((a) => ({ title: a.title, subject: a.subject, due: a.due })),
          goals: goals.length ? goals : undefined,
        }),
      });
      const data = (await res.json()) as {
        blocks?: { hour?: number; kind?: string; text?: string }[];
      };
      const list = Array.isArray(data.blocks) ? data.blocks : [];
      if (list.length) {
        const map: Record<number, ScheduleBlock> = {};
        for (const b of list) {
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
        if (Object.keys(map).length)
          setSchedule({ date: todayISO(), blocks: map });
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
    // Persist the study-style answers so the coach reuses them everywhere.
    if (profile && (a.focusTime || a.sessionLength || a.focusHelp)) {
      const next: LearnerProfile = {
        ...profile,
        focusTime: a.focusTime || profile.focusTime,
        sessionLength: a.sessionLength || profile.sessionLength,
        focusHelp: a.focusHelp || profile.focusHelp,
      };
      setProfile(next);
      AsyncStorage.setItem(PROFILE_KEY, JSON.stringify(next)).catch(() => {});
    }
    generateStudySchedule({
      homeHour: nextHomeHour,
      budgetMin,
      focusNote: a.focusNote,
    });
  };

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
        timeBound: g.timeBound || undefined,
        statement: g.statement?.trim() || undefined,
        target:
          typeof g.target === "number" && g.target > 0 ? g.target : undefined,
        current: typeof g.target === "number" && g.target > 0 ? 0 : undefined,
        id: `g${Date.now().toString(36)}`,
        done: false,
      },
    ]);
  }
  // Nudge numeric progress (clamped 0..target); auto-completes at the target.
  function stepGoal(id: string, delta: number) {
    setGoals((prev) =>
      prev.map((g) => {
        if (g.id !== id || typeof g.target !== "number") return g;
        const current = Math.max(
          0,
          Math.min(g.target, (g.current ?? 0) + delta),
        );
        return { ...g, current, done: current >= g.target };
      }),
    );
  }
  function toggleGoalDone(id: string) {
    setGoals((prev) =>
      prev.map((g) => (g.id === id ? { ...g, done: !g.done } : g)),
    );
  }
  function removeGoal(id: string) {
    setGoals((prev) => prev.filter((g) => g.id !== id));
  }
  // Break a goal into a checklist of steps (right here on the Plan tab) via the
  // goal-tasks endpoint, and store them on the goal so they render as a checklist.
  async function breakDownGoal(g: SmartGoal) {
    if (breakingGoalId) return;
    setBreakingGoalId(g.id);
    try {
      const res = await fetch(`${API_BASE_URL}/api/goal-tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal: g, profile: profile ?? undefined }),
      });
      const data = (await res.json()) as { tasks?: string[] };
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
  // The notes line under a goal step. Emptying it clears the line.
  function setGoalTaskDetail(goalId: string, index: number, detail: string) {
    const clean = detail.trim();
    setGoals((prev) =>
      prev.map((g) =>
        g.id === goalId
          ? {
              ...g,
              tasks: (g.tasks ?? []).map((t, i) =>
                i === index ? { ...t, detail: clean || undefined } : t,
              ),
            }
          : g,
      ),
    );
  }
  // Take the learner to chat and have Eliora coach them through a specific step.
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

  useEffect(() => {
    if (!loaded) return;
    AsyncStorage.setItem(MISSED_KEY, JSON.stringify(missed)).catch(() => {});
  }, [missed, loaded]);

  function addMissed(topic: string) {
    const t = topic.trim();
    if (!t) return;
    setMissed((prev) => (prev.includes(t) ? prev : [...prev, t]));
  }

  useEffect(() => {
    if (!loaded) return;
    AsyncStorage.setItem(SUBJECTS_KEY, JSON.stringify(subjects)).catch(() => {});
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

  function handleProfile(p: LearnerProfile) {
    AsyncStorage.setItem(PROFILE_KEY, JSON.stringify(p)).catch(() => {});
    const firstTime = !profile;
    setProfile(p);
    setEditing(false);
    if (firstTime) {
      const name = p.name?.trim() ? `, ${p.name.trim()}` : "";
      setMessages([
        {
          role: "assistant",
          content:
            `Hi${name} 💡 Thanks for sharing all that — give me a sec to look ` +
            `over your answers.`,
        },
      ]);
      setAutoBuild(true);
    } else if (messages.length === 0) {
      setMessages([greetingFor(p)]);
    }
  }

  // After sign-up, silently kick off the analysis — Eliora reflects on the
  // survey and chats a little before building the plan (see profileContext).
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

  function newChat() {
    const id = newChatId();
    const msgs = profile ? [greetingFor(profile)] : [];
    setChats((prev) => [...prev, { id, title: chatTitle(msgs), messages: msgs }]);
    setActiveChatId(id);
    setInput("");
    setTab("chat");
  }

  function closeChat(id: string) {
    const doDelete = () =>
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
    // Confirm before deleting a conversation that has real messages — chats are
    // saved, so this is permanent. Empty "New chat" tabs delete without asking.
    const chat = chats.find((c) => c.id === id);
    const hasContent = chat?.messages.some((m) => m.role === "user") ?? false;
    if (!hasContent) {
      doDelete();
      return;
    }
    Alert.alert("Delete conversation?", "This can't be undone.", [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: doDelete },
    ]);
  }

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

  function togglePlan(i: number) {
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
  function buildPlanFromChat() {
    if (busy) return;
    setTab("chat");
    send(PLAN_FROM_CHAT_PROMPT);
  }

  // Reminders: due-soon assignments, upcoming exams, and post-exam follow-ups.
  type Reminder = {
    id: string;
    icon: string;
    text: string;
    kind: "calendar" | "chat";
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
        kind: "calendar",
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
  const shownReminders = reminders.filter((r) => !dismissed.includes(r.id));
  function handleReminder(r: Reminder) {
    if (r.kind === "chat") {
      setTab("chat");
      if (r.chatMsg) send(r.chatMsg);
    } else setTab("calendar");
  }
  function checkReminder(r: Reminder) {
    if (r.id.startsWith("asg-")) toggleAssignment(r.id.slice(4));
    else setDismissed((prev) => (prev.includes(r.id) ? prev : [...prev, r.id]));
  }
  function addClass(d: { klass: string; struggles: string; goal: string }) {
    const klass = d.klass.trim();
    if (!klass || busy) return;
    addSubject(klass);
    setTab("chat");
    const struggles = d.struggles.trim();
    const goal = d.goal.trim();
    send(
      `I also need help with another class: ${klass}.` +
        (struggles ? ` In this class I struggle with: ${struggles}.` : "") +
        (goal ? ` What I want to get done: ${goal}.` : "") +
        ` Add this class to my learning plan — call save_plan with the FULL ` +
        `updated list that KEEPS all my existing steps and ADDS 2–4 small steps ` +
        `(include one checkpoint) for ${klass}. Start each new step's title with ` +
        `"${klass}: " so I can tell my classes apart. Then give me a short 2–3 ` +
        `sentence walkthrough and one tiny step to start.`,
      { hidden: true },
    );
  }
  function toggleNextStep() {
    const i = plan.findIndex((m) => !m.done);
    if (i >= 0) togglePlan(i);
  }

  async function send(override?: string, opts?: { hidden?: boolean }) {
    const text = (typeof override === "string" ? override : input).trim();
    if (!text || busy) return;

    const userMsg: Message = { role: "user", content: text };
    // The model always sees the kickoff; a hidden auto-build doesn't show it.
    const apiMessages: Message[] = [...messages, userMsg];
    const visible: Message[] = opts?.hidden ? [...messages] : apiMessages;
    setMessages([...visible, { role: "assistant", content: "" }]);
    if (typeof override !== "string") setInput("");
    setBusy(true);

    try {
      const res = await expoFetch(`${API_BASE_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: apiMessages
            .slice(1)
            .map((m) => ({ role: m.role, content: m.content })),
          profile: profile ?? undefined,
          plan: plan.length ? plan : undefined,
          events: events.length ? events : undefined,
          missed: missed.length ? missed : undefined,
          subjects: subjects.length ? subjects : undefined,
          assignments: assignments.length ? assignments : undefined,
          goals: goals.length ? goals : undefined,
        }),
      });

      if (!res.body) throw new Error("No response stream");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let acc = "";
      const videos: Video[] = [];
      const socials: SocialRec[] = [];
      const resources: ResourceRec[] = [];
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
            | ResourceRec[]
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
        if (evt.type === "text" && evt.value) acc += evt.value;
        else if (evt.type === "videos" && evt.items)
          videos.push(...(evt.items as Video[]));
        else if (evt.type === "socials" && evt.items)
          socials.push(...(evt.items as SocialRec[]));
        else if (evt.type === "resources" && evt.items)
          resources.push(...(evt.items as ResourceRec[]));
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
            resources: resources.length ? [...resources] : undefined,
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
    } catch {
      setMessages((prev) => {
        const copy = [...prev];
        copy[copy.length - 1] = {
          role: "assistant",
          content: "Sorry, I couldn't reach Eliora. Check the API URL and try again.",
        };
        return copy;
      });
    } finally {
      setBusy(false);
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 50);
    }
  }

  if (!loaded) return <View style={styles.container} />;

  if (!profile || editing) {
    return (
      <SignUp
        initial={profile}
        onComplete={handleProfile}
        onCancel={profile ? () => setEditing(false) : undefined}
      />
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <StatusBar style="dark" />
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Eliora</Text>
          <Text style={styles.subtitle}>Your focus & study coach</Text>
        </View>
        <TouchableOpacity
          style={styles.ghostBtn}
          onPress={newChat}
          disabled={busy}
          accessibilityLabel="Start a new chat"
        >
          <Text style={styles.ghostBtnText}>New chat</Text>
        </TouchableOpacity>
      </View>

      <Summarizer
        visible={summarizing}
        profile={profile}
        onClose={() => setSummarizing(false)}
        onAddToChat={(msg) =>
          setMessages((prev) => [
            ...prev,
            {
              role: "assistant",
              content: msg.content,
              flashcards: msg.flashcards,
              quiz: msg.quiz,
            },
          ])
        }
        onStudyGuide={studyGuideFromQuiz}
      />

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.tabBar}
        contentContainerStyle={styles.tabBarContent}
      >
        <TouchableOpacity
          style={[styles.viewTab, tab === "chat" && styles.viewTabActive]}
          onPress={() => setTab("chat")}
        >
          <Text style={[styles.viewTabText, tab === "chat" && styles.viewTabTextActive]}>
            💬 Chat
          </Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.viewTab} onPress={() => setSummarizing(true)}>
          <Text style={styles.viewTabText}>📝 Summarize</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.viewTab, tab === "calendar" && styles.viewTabActive]}
          onPress={() => setTab("calendar")}
        >
          <Text
            style={[styles.viewTabText, tab === "calendar" && styles.viewTabTextActive]}
          >
            📅 Calendar
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.viewTab, tab === "plan" && styles.viewTabActive]}
          onPress={() => setTab("plan")}
        >
          <Text style={[styles.viewTabText, tab === "plan" && styles.viewTabTextActive]}>
            🎯 Plan
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.viewTab, tab === "study" && styles.viewTabActive]}
          onPress={() => setTab("study")}
        >
          <Text style={[styles.viewTabText, tab === "study" && styles.viewTabTextActive]}>
            📋 Study
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.viewTab, tab === "notebook" && styles.viewTabActive]}
          onPress={() => setTab("notebook")}
        >
          <Text style={[styles.viewTabText, tab === "notebook" && styles.viewTabTextActive]}>
            📓 Smart Notes
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.viewTab, tab === "practice" && styles.viewTabActive]}
          onPress={() => setTab("practice")}
        >
          <Text
            style={[styles.viewTabText, tab === "practice" && styles.viewTabTextActive]}
          >
            🧠 Practice
          </Text>
        </TouchableOpacity>
      </ScrollView>

      {tab === "plan" ? (
        <ScrollView contentContainerStyle={styles.studyScroll}>
          {shownReminders.length > 0 && (
            <View style={styles.card}>
              <View style={styles.cardHead}>
                <Text style={styles.cardClass}>🔔 Reminders</Text>
              </View>
              {shownReminders.map((r) => (
                <View key={r.id} style={styles.reminderRow}>
                  <TouchableOpacity
                    style={styles.reminderCheck}
                    onPress={() => checkReminder(r)}
                    accessibilityLabel="Mark done"
                  />
                  <TouchableOpacity
                    style={styles.reminderTap}
                    onPress={() => handleReminder(r)}
                  >
                    <Text>{r.icon}</Text>
                    <Text style={styles.reminderText}>{r.text}</Text>
                    <Text style={styles.reminderChevron}>›</Text>
                  </TouchableOpacity>
                </View>
              ))}
            </View>
          )}
          <PlanStrip
            plan={plan}
            onToggleNext={toggleNextStep}
            onOpen={() => setTab("chat")}
          />
          <GoalsPanel
            goals={goals}
            profile={profile}
            onAdd={addGoal}
            onStep={stepGoal}
            onToggle={toggleGoalDone}
            onRemove={removeGoal}
            onBreakDown={breakDownGoal}
            onToggleTask={toggleGoalTask}
            onSetTaskDetail={setGoalTaskDetail}
            onHelpTask={helpWithTask}
            breakingGoalId={breakingGoalId}
          />
          <AssignmentsPanel
            assignments={assignments}
            subjects={subjects}
            onAdd={addAssignment}
            onToggle={toggleAssignment}
            onSetConcern={setAssignmentConcern}
            onRemove={removeAssignment}
            onBreakDown={breakDownAssignment}
            onToggleStep={toggleAssignmentStep}
            onClearSteps={clearAssignmentSteps}
            breakingAssignmentId={breakingAssignmentId}
          />
          <ScheduleCard
            schedule={schedule}
            onSet={setScheduleBlock}
            onClear={clearSchedule}
            homeHour={homeHour}
            onSetHomeHour={setHomeHour}
            onGenerate={() => generateStudySchedule()}
            onSetup={() => setScheduleSurveyOpen(true)}
            generating={generatingSchedule}
          />
          <ScheduleSetupSurvey
            visible={scheduleSurveyOpen}
            onClose={() => setScheduleSurveyOpen(false)}
            initial={{
              focusTime: profile?.focusTime,
              sessionLength: profile?.sessionLength,
              focusHelp: profile?.focusHelp,
            }}
            onSubmit={handleScheduleSurvey}
          />
          <CheckInCard prefs={checkIn} onChange={setCheckIn} />
          <View style={styles.card}>
            <View style={styles.cardHead}>
              <Text style={styles.cardClass}>📅 Calendar</Text>
              <Text style={styles.linkBtn} onPress={() => setTab("calendar")}>
                Open ›
              </Text>
            </View>
            <MonthGrid
              events={events}
              assignments={assignments}
              onPickDate={() => setTab("calendar")}
            />
          </View>
          {plan.length > 0 ? (
            <>
              <TouchableOpacity
                style={styles.planRebuildBtn}
                disabled={busy}
                onPress={buildPlanFromChat}
              >
                <Text style={styles.planRebuildBtnText}>
                  ↻ Rebuild from our chat
                </Text>
              </TouchableOpacity>
              <PlanBoard
                plan={plan}
                onToggle={togglePlan}
                onAdd={addMilestone}
                onRemove={removeMilestone}
              />
            </>
          ) : (
            <View style={styles.card}>
              <View style={styles.cardHead}>
                <Text style={styles.cardClass}>🎯 Your learning plan</Text>
              </View>
              <Text style={{ color: "#6b6280", marginVertical: 8 }}>
                No plan yet. Eliora can build one from your conversation — the
                topics you've talked about and what you're stuck on.
              </Text>
              <TouchableOpacity
                style={styles.planBuildBtn}
                disabled={busy}
                onPress={buildPlanFromChat}
              >
                <Text style={styles.studyToolBtnText}>
                  🎯 Build my plan from our chat
                </Text>
              </TouchableOpacity>
              <Text style={{ color: "#6b6280", marginTop: 12, marginBottom: 4 }}>
                …or add your own steps:
              </Text>
              <PlanPanel
                plan={plan}
                onToggle={togglePlan}
                onAdd={addMilestone}
                onRemove={removeMilestone}
              />
            </View>
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
            <View style={styles.addClassRow}>
              <Text style={styles.addClassLabel}>
                Need help with another class?
              </Text>
              <TouchableOpacity
                style={styles.addClassPlus}
                disabled={busy}
                onPress={() => setShowClassSurvey(true)}
                accessibilityLabel="Add a class you need help with"
              >
                <Text style={styles.addClassPlusText}>+</Text>
              </TouchableOpacity>
            </View>
          )}
        </ScrollView>
      ) : tab === "study" ? (
        <ScrollView contentContainerStyle={styles.studyScroll}>
          <View style={styles.outputRow}>
            {(
              [
                ["overview", "🏠 Overview"],
                ["plan", "🗓️ Plan"],
                ["notes", "📓 Notes"],
                ["lessons", "🧩 Lessons"],
                ["flashcards", "🃏 Flashcards"],
              ] as const
            ).map(([key, label]) => (
              <TouchableOpacity
                key={key}
                style={[styles.outChip, studySection === key && styles.outChipActive]}
                onPress={() => setStudySection(key)}
              >
                <Text
                  style={[
                    styles.outChipText,
                    studySection === key && styles.outChipTextActive,
                  ]}
                >
                  {label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          {studySection === "overview" ? (
            <>
              <ProfileCard profile={profile} onEdit={() => setEditing(true)} />
              <SubjectsPanel
                subjects={subjects}
                onAdd={addSubject}
                onRemove={removeSubject}
              />
              <View style={styles.card}>
                <View style={styles.cardHead}>
                  <Text style={styles.cardClass}>🛠️ Study tools</Text>
                </View>
                <View style={styles.studyToolsGrid}>
                  {(
                    [
                      // No "Flashcards" shortcut here — the real deck builder is
                      // its own card further down this tab.
                      ["📝 Quiz me", "Quiz me on what I'm learning."],
                      ["📚 Study guide", "Make me a study guide for what I should review."],
                      ["🎬 Study videos", "Recommend me a few study videos for my class."],
                      ["📱 Short-form recs", "Recommend TikTok, YouTube Shorts, and Instagram accounts or searches for what I'm studying."],
                      ["🧠 Study tip", studyTipPrompt()],
                      ["💡 Suggestions", "Give me a couple of study suggestions."],
                    ] as const
                  ).map(([label, msg]) => (
                    <TouchableOpacity
                      key={label}
                      style={styles.studyToolBtn}
                      disabled={busy}
                      onPress={() => {
                        setTab("chat");
                        send(msg);
                      }}
                    >
                      <Text style={styles.studyToolBtnText}>{label}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            </>
          ) : studySection === "plan" ? (
            <SessionLessonPlan
              session={firstSession}
              profile={profile}
              onAdopt={(steps) => setPlan((prev) => appendPlan(prev, steps))}
              onAsk={(msg) => {
                setTab("chat");
                send(msg);
              }}
            />
          ) : studySection === "notes" ? (
            <SmartNotes profile={profile} />
          ) : studySection === "lessons" ? (
            <LessonBuilder profile={profile} onMissed={addMissed} />
          ) : (
            <FlashcardsScreen
              profile={profile}
              subjects={subjects}
              missed={missed}
              onMissed={addMissed}
            />
          )}
        </ScrollView>
      ) : tab === "notebook" ? (
        <NotesWorkspace />
      ) : tab === "practice" ? (
        <ScrollView contentContainerStyle={styles.studyScroll}>
          <PracticeQuiz
            profile={profile}
            subjects={subjects}
            missed={missed}
            onMissed={addMissed}
            onStudyGuide={studyGuideFromQuiz}
          />
        </ScrollView>
      ) : tab === "calendar" ? (
        <ScrollView contentContainerStyle={styles.studyScroll}>
          <DeadlineCountdown
            events={events}
            assignments={assignments}
            goals={goals}
          />
          <CalendarPanel
            events={events}
            assignments={assignments}
            onAdd={addEvent}
            onRemove={removeEvent}
          />
        </ScrollView>
      ) : (
      <View style={{ flex: 1 }}>
        <View style={{ paddingHorizontal: 16, paddingTop: 6 }}>
          <PlanStrip
            plan={plan}
            onToggleNext={toggleNextStep}
            onOpen={() => setTab("study")}
          />
        </View>
        {folders.length > 0 && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.folderFilter}
            contentContainerStyle={styles.folderFilterContent}
          >
            <TouchableOpacity
              style={[
                styles.folderChip,
                activeFolder === null && styles.folderChipActive,
              ]}
              onPress={() => setActiveFolder(null)}
            >
              <Text
                style={[
                  styles.folderChipText,
                  activeFolder === null && styles.folderChipTextActive,
                ]}
              >
                All
              </Text>
            </TouchableOpacity>
            {folders.map((f) => (
              <TouchableOpacity
                key={f.id}
                style={[
                  styles.folderChip,
                  activeFolder === f.id && styles.folderChipActive,
                ]}
                onPress={() => setActiveFolder(f.id)}
                onLongPress={() => deleteFolder(f.id)}
              >
                <Text
                  style={[
                    styles.folderChipText,
                    activeFolder === f.id && styles.folderChipTextActive,
                  ]}
                >
                  📁 {f.name}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.chatTabs}
          contentContainerStyle={styles.chatTabsContent}
        >
          {chats
            .filter(
              (c) => activeFolder === null || c.folderId === activeFolder,
            )
            .map((c) => {
            const active = c.id === activeChatId;
            return (
              <TouchableOpacity
                key={c.id}
                style={[styles.chatTab, active && styles.chatTabActive]}
                onPress={() => setActiveChatId(c.id)}
                onLongPress={() => {
                  setRenamingId(c.id);
                  setRenameText(c.title);
                }}
              >
                <Text
                  style={[styles.chatTabLabel, active && styles.chatTabLabelActive]}
                  numberOfLines={1}
                >
                  {c.title}
                </Text>
                {(chats.length > 1 ||
                  c.messages.some((m) => m.role === "user")) && (
                  <Text
                    style={styles.chatTabClose}
                    onPress={() => closeChat(c.id)}
                  >
                    {"  ✕"}
                  </Text>
                )}
              </TouchableOpacity>
            );
          })}
          <TouchableOpacity style={styles.chatTabNew} onPress={newChat}>
            <Text style={styles.chatTabNewText}>＋</Text>
          </TouchableOpacity>
        </ScrollView>

      <Modal
        visible={renamingId !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setRenamingId(null)}
      >
        <View style={styles.renameOverlay}>
          <View style={styles.renameCard}>
            <Text style={styles.renameTitle}>Name this chat</Text>
            <TextInput
              style={styles.renameInput}
              value={renameText}
              onChangeText={setRenameText}
              placeholder="Chat name…"
              placeholderTextColor="#8b83a3"
              onSubmitEditing={() => renamingId && renameChat(renamingId, renameText)}
              returnKeyType="done"
            />

            <Text style={styles.renameSubLabel}>Folder</Text>
            <View style={styles.folderPickRow}>
              <TouchableOpacity
                style={[
                  styles.folderPick,
                  !chats.find((c) => c.id === renamingId)?.folderId &&
                    styles.folderPickActive,
                ]}
                onPress={() =>
                  renamingId && moveChatToFolder(renamingId, undefined)
                }
              >
                <Text style={styles.folderPickText}>No folder</Text>
              </TouchableOpacity>
              {folders.map((f) => {
                const inIt =
                  chats.find((c) => c.id === renamingId)?.folderId === f.id;
                return (
                  <TouchableOpacity
                    key={f.id}
                    style={[styles.folderPick, inIt && styles.folderPickActive]}
                    onPress={() =>
                      renamingId && moveChatToFolder(renamingId, f.id)
                    }
                  >
                    <Text style={styles.folderPickText}>📁 {f.name}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <View style={styles.newFolderRow}>
              <TextInput
                style={styles.newFolderInput}
                value={newFolderText}
                onChangeText={setNewFolderText}
                placeholder="New folder…"
                placeholderTextColor="#8b83a3"
              />
              <TouchableOpacity
                style={styles.newFolderBtn}
                onPress={() => {
                  const id = createFolder(newFolderText);
                  if (id && renamingId) moveChatToFolder(renamingId, id);
                  setNewFolderText("");
                }}
              >
                <Text style={styles.newFolderBtnText}>Add</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.renameActions}>
              <TouchableOpacity
                style={styles.renameCancel}
                onPress={() => setRenamingId(null)}
              >
                <Text style={styles.renameCancelText}>Close</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.renameSave}
                onPress={() => renamingId && renameChat(renamingId, renameText)}
              >
                <Text style={styles.renameSaveText}>Save</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(_, i) => String(i)}
        contentContainerStyle={styles.list}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
        renderItem={({ item }) => (
          <View
            style={{
              alignItems: item.role === "user" ? "flex-end" : "flex-start",
              gap: 8,
            }}
          >
            <View
              style={[
                styles.bubble,
                item.role === "user" ? styles.userBubble : styles.assistantBubble,
              ]}
            >
              {item.role === "user" ? (
                <Text style={styles.userText}>{renderContent(item.content)}</Text>
              ) : item.content ? (
                renderMessageBody(item.content)
              ) : (
                <Text style={styles.assistantText}>{busy ? "…" : ""}</Text>
              )}
            </View>
            {item.role === "assistant" && !!item.content && (
              <TouchableOpacity
                style={styles.speakBtn}
                onPress={() => {
                  Speech.stop();
                  Speech.speak(item.content, { rate: 0.95 });
                }}
                accessibilityLabel="Read this message aloud"
              >
                <Text style={styles.speakBtnText}>🔊 Read aloud</Text>
              </TouchableOpacity>
            )}
            {item.videos && item.videos.length > 0 && (
              <VideoCards videos={item.videos} />
            )}
            {item.socials && item.socials.length > 0 && (
              <SocialCards socials={item.socials} />
            )}
            {item.resources && item.resources.length > 0 && (
              <ResourceCards resources={item.resources} />
            )}
            {item.flashcards && item.flashcards.length > 0 && (
              <FlashcardDeck cards={item.flashcards} onMissed={addMissed} />
            )}
            {item.quiz && item.quiz.length > 0 && (
              <QuizView
                quiz={item.quiz}
                onMissed={addMissed}
                onStudyGuide={studyGuideFromQuiz}
              />
            )}
          </View>
        )}
      />
      </View>
      )}

      {tab === "chat" && (
        <>
      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder="Message Eliora…"
          placeholderTextColor="#8b83a3"
          multiline
          autoCorrect
          spellCheck
          autoCapitalize="sentences"
        />
        <TouchableOpacity
          style={styles.sendBtn}
          onPress={() => send()}
          disabled={busy}
          accessibilityLabel="Send message"
        >
          {busy ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.sendText}>Send</Text>
          )}
        </TouchableOpacity>
      </View>
        </>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fdf4f2" },
  // Sign-up form
  formScroll: { padding: 20, paddingTop: 64, paddingBottom: 48, gap: 16 },
  formTitle: { fontSize: 26, fontWeight: "700", color: "#7b4bd0" },
  formIntro: { fontSize: 16, color: "#6b6280", lineHeight: 22 },
  field: { gap: 6 },
  fieldLabel: { fontSize: 16, fontWeight: "600", color: "#2a2350" },
  choiceBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#efe4f0",
    backgroundColor: "#fff",
    marginTop: 8,
  },
  choiceBtnSelected: { borderColor: "#7b4bd0", backgroundColor: "#f3ebfd" },
  choiceRadio: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1.5,
    borderColor: "#7b4bd0",
    backgroundColor: "#fff",
  },
  choiceRadioSelected: { backgroundColor: "#7b4bd0" },
  choiceText: { flex: 1, fontSize: 15, color: "#2a2350" },
  choiceHint: { fontWeight: "400", fontSize: 13, color: "#6b6280" },
  choiceCheckbox: {
    width: 18,
    height: 18,
    borderRadius: 5,
    borderWidth: 1.5,
    borderColor: "#7b4bd0",
    backgroundColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
  },
  choiceCheckboxSelected: { backgroundColor: "#7b4bd0" },
  choiceCheckMark: { color: "#fff", fontSize: 12, fontWeight: "700", lineHeight: 14 },
  formInput: {
    fontSize: 17,
    backgroundColor: "#fff",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#efe4f0",
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  formTextarea: { minHeight: 64, textAlignVertical: "top" },
  formActions: { flexDirection: "row", justifyContent: "flex-end", gap: 10, marginTop: 8 },
  primaryBtn: {
    backgroundColor: "#7b4bd0",
    borderRadius: 14,
    paddingHorizontal: 22,
    paddingVertical: 14,
  },
  primaryBtnDisabled: { opacity: 0.5 },
  primaryBtnText: { color: "#fff", fontSize: 17, fontWeight: "600" },
  secondaryBtn: {
    borderWidth: 1,
    borderColor: "#efe4f0",
    borderRadius: 14,
    paddingHorizontal: 22,
    paddingVertical: 14,
  },
  secondaryBtnText: { color: "#6b6280", fontSize: 17 },
  // Summarizer modal
  modalHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  tabs: { flexDirection: "row", gap: 6 },
  tab: {
    flex: 1,
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#efe4f0",
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: "center",
  },
  tabActive: { backgroundColor: "#7b4bd0", borderColor: "#7b4bd0" },
  tabText: { fontSize: 15, color: "#6b6280" },
  tabTextActive: { color: "#fff", fontWeight: "600" },
  resultBox: {
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#efe4f0",
    borderRadius: 12,
    padding: 14,
    gap: 12,
  },
  resultText: { fontSize: 16, lineHeight: 24, color: "#2a2350" },
  outputRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  outChip: {
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#efe4f0",
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  outChipActive: { backgroundColor: "#7b4bd0", borderColor: "#7b4bd0" },
  outChipText: { fontSize: 13, color: "#6b6280" },
  outChipTextActive: { color: "#fff", fontWeight: "600" },
  // Lesson player (Khan-Academy-style stepped lessons)
  lessonProgressTrack: {
    height: 8,
    borderRadius: 999,
    backgroundColor: "#e6eae6",
    marginTop: 10,
    overflow: "hidden",
  },
  lessonProgressFill: {
    height: 8,
    borderRadius: 999,
    backgroundColor: "#7b4bd0",
  },
  lessonOpt: {
    borderWidth: 1,
    borderColor: "#efe4f0",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginTop: 8,
    backgroundColor: "#fff",
  },
  lessonOptText: { fontSize: 16, color: "#2a2350" },
  lessonOptPicked: { borderColor: "#7b4bd0", backgroundColor: "#f3ebfd" },
  lessonOptCorrect: { borderColor: "#2e7d32", backgroundColor: "#e4f4e6" },
  lessonOptWrong: { borderColor: "#c0392b", backgroundColor: "#fbe9e7" },

  // Lesson diagrams (drawn with Views — no SVG dependency)
  dgWrap: { marginTop: 10, marginBottom: 2 },
  dgTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: "#6b6280",
    textAlign: "center",
    marginBottom: 8,
  },
  dgCaption: {
    fontSize: 12.5,
    color: "#6b6280",
    fontStyle: "italic",
    textAlign: "center",
    marginTop: 8,
  },
  dgBox: {
    borderWidth: 1.5,
    borderColor: "#7b4bd0",
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: "#fff",
  },
  dgBoxTint: { backgroundColor: "#f3ebfd" },
  dgLabel: { fontSize: 14.5, fontWeight: "700", color: "#2a2350" },
  dgDetail: { fontSize: 12.5, color: "#6b6280", marginTop: 2, lineHeight: 17 },
  dgArrow: {
    fontSize: 18,
    color: "#8b83a3",
    textAlign: "center",
    marginVertical: 2,
  },
  dgLoop: {
    fontSize: 12.5,
    color: "#7b4bd0",
    textAlign: "center",
    marginTop: 6,
    fontWeight: "600",
  },
  dgRow: { flexDirection: "row", gap: 8 },
  dgCol: {
    flex: 1,
    borderWidth: 1.5,
    borderColor: "#7b4bd0",
    borderRadius: 12,
    backgroundColor: "#fff",
    overflow: "hidden",
    paddingBottom: 10,
  },
  dgColHead: {
    backgroundColor: "#f3ebfd",
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderBottomWidth: 1.5,
    borderBottomColor: "#7b4bd0",
  },
  dgColBody: {
    fontSize: 12.5,
    color: "#6b6280",
    lineHeight: 17,
    paddingHorizontal: 10,
    paddingTop: 8,
  },
  dgBar: {
    flexDirection: "row",
    height: 40,
    borderRadius: 10,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "#d8c8e2",
  },
  dgBarSeg: { backgroundColor: "#7b4bd0" },
  dgBarSegFirst: { borderTopLeftRadius: 9, borderBottomLeftRadius: 9 },
  dgBarSegLast: { borderTopRightRadius: 9, borderBottomRightRadius: 9 },
  dgLegendRow: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 8 },
  dgSwatch: {
    width: 14,
    height: 14,
    borderRadius: 4,
    backgroundColor: "#7b4bd0",
  },
  dgLegendText: { flex: 1, fontSize: 13, color: "#6b6280", lineHeight: 18 },
  dgLegendWord: { fontWeight: "700", color: "#2a2350" },
  dgTimeRow: { flexDirection: "row", gap: 12 },
  dgTimeRail: { alignItems: "center", width: 16 },
  dgTimeDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: "#7b4bd0",
    marginTop: 4,
  },
  dgTimeLine: { flex: 1, width: 2, backgroundColor: "#d8c8e2", marginVertical: 2 },
  dgTimeBody: { flex: 1, paddingBottom: 14 },
  dgRoot: {
    backgroundColor: "#7b4bd0",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 11,
    alignSelf: "center",
  },
  dgRootText: { color: "#fff", fontSize: 15, fontWeight: "700" },
  dgFormula: {
    borderWidth: 1.5,
    borderColor: "#7b4bd0",
    backgroundColor: "#f3ebfd",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 14,
    alignItems: "center",
  },
  dgFormulaText: {
    fontSize: 20,
    fontWeight: "700",
    color: "#2a2350",
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  },
  dgSymbol: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: "#7b4bd0",
    alignItems: "center",
    justifyContent: "center",
  },
  dgSymbolText: { color: "#fff", fontSize: 11, fontWeight: "700" },

  // Lesson slide (presentation) mode
  slideBar: { flexDirection: "row", alignItems: "center", gap: 10 },
  slideCard: {
    borderWidth: 1,
    borderColor: "#efe4f0",
    borderRadius: 16,
    backgroundColor: "#fbfaf6",
    padding: 18,
    minHeight: 240,
    justifyContent: "center",
    gap: 4,
  },
  slideKicker: {
    fontSize: 11.5,
    fontWeight: "700",
    letterSpacing: 0.7,
    color: "#7b4bd0",
  },
  slideBigTitle: {
    fontSize: 25,
    lineHeight: 31,
    fontWeight: "800",
    color: "#2a2350",
    marginTop: 8,
  },
  slideTitle: { fontSize: 19, fontWeight: "800", color: "#2a2350" },
  slideLead: { fontSize: 15.5, lineHeight: 23, color: "#6b6280", marginTop: 8 },
  slideBody: { fontSize: 15, lineHeight: 23, color: "#2a2350", marginTop: 8 },
  slideNote: { fontSize: 13.5, color: "#7b4bd0", marginTop: 10 },
  slideControls: { flexDirection: "row", gap: 8, alignItems: "center" },
  slideNav: { flex: 1, marginTop: 0 },

  // Chat header
  header: {
    paddingTop: 64,
    paddingHorizontal: 20,
    paddingBottom: 8,
    flexDirection: "row",
    alignItems: "flex-start",
  },
  title: { fontSize: 28, fontWeight: "700", color: "#7b4bd0" },
  subtitle: { fontSize: 15, color: "#6b6280", marginTop: 2 },
  headerBtns: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    gap: 8,
    marginTop: 4,
  },
  ghostBtn: {
    borderWidth: 1,
    borderColor: "#7b4bd0",
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  ghostBtnText: { color: "#7b4bd0", fontSize: 13, fontWeight: "600" },
  timerDisplay: {
    fontSize: 72,
    fontWeight: "700",
    textAlign: "center",
    color: "#7b4bd0",
    marginVertical: 8,
  },
  timerDone: {
    textAlign: "center",
    fontSize: 17,
    color: "#2a2350",
    marginBottom: 4,
  },
  // Focus garden
  scene: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#efe4f0",
    minHeight: 150,
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    padding: 16,
    marginBottom: 4,
  },
  sceneFlower: { fontSize: 60 },
  sceneNote: { fontSize: 15, color: "#6b6280", textAlign: "center" },
  gardenWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
  },
  gardenFlower: { fontSize: 22 },
  locTitleRow: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    marginTop: 8,
    marginBottom: 4,
  },
  locRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 8,
  },
  locEmoji: { fontSize: 22 },
  locName: { flex: 1, fontSize: 15, fontWeight: "600", color: "#2a2350" },
  locCurrent: { fontSize: 13, fontWeight: "700", color: "#7b4bd0" },
  smallGhost: {
    borderWidth: 1,
    borderColor: "#7b4bd0",
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  smallGhostText: { color: "#7b4bd0", fontSize: 13 },
  levelChip: {
    backgroundColor: "#7b4bd0",
    color: "#fff",
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 2,
    fontSize: 13,
    fontWeight: "700",
    overflow: "hidden",
  },
  customRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginTop: 10,
  },
  customLabel: { fontSize: 14, color: "#6b6280" },
  customInput: {
    width: 70,
    fontSize: 15,
    backgroundColor: "#fff",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#efe4f0",
    paddingHorizontal: 10,
    paddingVertical: 8,
    textAlign: "center",
  },
  prizeBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: "#f0b43f",
    borderRadius: 14,
    padding: 12,
    marginBottom: 6,
  },
  prizeTitle: { fontWeight: "700", fontSize: 16, color: "#3a2a06" },
  prizeText: { fontSize: 13, color: "#3a2a06" },
  achToast: {
    backgroundColor: "#7b4bd0",
    borderRadius: 12,
    padding: 12,
    marginBottom: 4,
  },
  achToastText: { color: "#fff", fontSize: 15, fontWeight: "600" },
  fbCard: {
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#efe4f0",
    borderRadius: 14,
    padding: 16,
    marginBottom: 10,
    gap: 8,
  },
  fbTitle: { fontSize: 17, fontWeight: "700", color: "#7b4bd0" },
  fbSub: { fontSize: 15, color: "#2a2350" },
  fbInput: {
    borderWidth: 1,
    borderColor: "#d8c8e2",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: "#2a2350",
    backgroundColor: "#fff",
  },
  fbMoodRow: { flexDirection: "row", gap: 8 },
  fbMoodBtn: {
    flex: 1,
    alignItems: "center",
    gap: 2,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#efe4f0",
    backgroundColor: "#f3ebfd",
  },
  fbMoodText: { fontSize: 14, fontWeight: "600", color: "#2a2350" },
  fbSkip: { color: "#6b6280", fontSize: 14, marginTop: 2 },
  achItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#efe4f0",
    borderRadius: 12,
    padding: 10,
    marginBottom: 6,
  },
  achEmoji: { fontSize: 22 },
  achName: { fontSize: 14, fontWeight: "600", color: "#2a2350" },
  // Profile card
  card: {
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#efe4f0",
    borderRadius: 14,
    padding: 12,
  },
  cardHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  cardClass: { flex: 1, fontWeight: "700", fontSize: 16, color: "#7b4bd0" },
  linkBtn: {
    color: "#7b4bd0",
    fontSize: 14,
    textDecorationLine: "underline",
  },
  cardRow: { fontSize: 14, color: "#2a2350", marginTop: 6 },
  cardLabel: { color: "#6b6280" },
  folderRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 },
  folder: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#fbf6e9",
    borderWidth: 1,
    borderColor: "#e6d9b8",
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  folderText: { fontSize: 14, color: "#2a2350" },
  folderRemove: { fontSize: 14, color: "#8b83a3" },
  // Plan panel
  plan: {
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#efe4f0",
    borderRadius: 14,
    padding: 12,
  },
  planHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  planTitle: { fontWeight: "700", fontSize: 16, color: "#2a2350" },
  planCount: { fontSize: 14, color: "#6b6280" },
  progressTrack: {
    height: 8,
    borderRadius: 6,
    backgroundColor: "#f3ebfd",
    marginVertical: 10,
    overflow: "hidden",
  },
  progressFill: { height: "100%", backgroundColor: "#7b4bd0", borderRadius: 6 },
  planRow: { flexDirection: "row", alignItems: "flex-start" },
  planItem: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    paddingVertical: 6,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: "#7b4bd0",
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxOn: { backgroundColor: "#7b4bd0" },
  checkboxCheckpoint: { borderColor: "#b8742a" },
  checkboxOnCheckpoint: { backgroundColor: "#b8742a", borderColor: "#b8742a" },
  checkmark: { color: "#fff", fontSize: 14, lineHeight: 16 },
  planItemText: { flex: 1, fontSize: 15, color: "#2a2350", lineHeight: 21 },
  planItemDone: { textDecorationLine: "line-through", color: "#8b83a3" },
  checkpointBadge: { color: "#b8742a", fontWeight: "700", fontSize: 12 },

  // Lesson plan from the first session
  lpSecHead: {
    fontSize: 12,
    fontWeight: "800",
    color: "#7b4bd0",
    textTransform: "uppercase",
    letterSpacing: 0.3,
    marginTop: 12,
    marginBottom: 4,
  },
  lpItem: { fontSize: 14.5, color: "#2a2350", lineHeight: 21, marginBottom: 3 },
  lpSession: {
    marginTop: 10,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#e2e6e0",
    backgroundColor: "#fff",
  },
  lpSessionHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  lpNum: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: "#7b4bd0",
    alignItems: "center",
    justifyContent: "center",
  },
  lpNumText: { color: "#fff", fontSize: 12.5, fontWeight: "800" },
  lpSessionTitle: {
    flex: 1,
    fontSize: 15,
    fontWeight: "700",
    color: "#2a2350",
    lineHeight: 20,
  },
  lpFocus: { marginTop: 6, fontSize: 14.5, color: "#2a2350", lineHeight: 21 },
  lpHint: {
    marginTop: 8,
    padding: 10,
    borderRadius: 10,
    backgroundColor: "#f3ebfd",
    fontSize: 14,
    color: "#2a2350",
    lineHeight: 20,
  },
  lpNote: {
    marginTop: 10,
    fontSize: 13.5,
    fontStyle: "italic",
    color: "#6b6280",
    lineHeight: 20,
  },
  // Plan path (snake) view
  pathToggleRow: { flexDirection: "row", gap: 8, marginBottom: 10 },
  pathToggleBtn: {
    flex: 1,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#efe4f0",
    backgroundColor: "#fff",
    alignItems: "center",
  },
  pathToggleBtnActive: { backgroundColor: "#7b4bd0", borderColor: "#7b4bd0" },
  pathToggleText: { fontSize: 13, fontWeight: "700", color: "#6b6280" },
  pathToggleTextActive: { color: "#fff" },
  pathHerePill: {
    fontSize: 11,
    fontWeight: "800",
    color: "#7b4bd0",
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#7b4bd0",
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
    overflow: "hidden",
  },
  // Calendar
  calForm: { gap: 8, marginVertical: 10 },
  calInput: {
    fontSize: 15,
    backgroundColor: "#fff",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#efe4f0",
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  kindRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  kindChip: {
    borderWidth: 1,
    borderColor: "#efe4f0",
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  kindChipText: { fontSize: 13, color: "#6b6280", textTransform: "capitalize" },
  calAddBtn: {
    backgroundColor: "#7b4bd0",
    borderRadius: 10,
    paddingVertical: 11,
    alignItems: "center",
  },
  calAddBtnText: { color: "#fff", fontSize: 15, fontWeight: "600" },
  calEmpty: { fontSize: 14, color: "#6b6280", marginTop: 8 },
  calGridWrap: { marginVertical: 10 },
  calNav: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  calNavBtn: {
    width: 34,
    height: 34,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#efe4f0",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#fff",
  },
  calNavBtnText: { fontSize: 20, color: "#7b4bd0", lineHeight: 22 },
  calMonthLabel: { fontSize: 15, fontWeight: "700", color: "#2a2350" },
  calWeekRow: { flexDirection: "row", marginBottom: 4 },
  calWeekday: {
    width: "14.28%",
    textAlign: "center",
    fontSize: 11,
    fontWeight: "600",
    color: "#6b6280",
  },
  calGrid: { flexDirection: "row", flexWrap: "wrap" },
  calCell: { width: "14.28%", padding: 2 },
  calBox: {
    height: 42,
    borderWidth: 1,
    borderColor: "#e3e6e1",
    borderRadius: 8,
    backgroundColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
  },
  calBoxToday: { borderColor: "#7b4bd0", borderWidth: 2 },
  calBoxNum: { fontSize: 13, color: "#2a2350" },
  calBoxNumToday: { color: "#7b4bd0", fontWeight: "700" },
  calDots: { flexDirection: "row", gap: 2, height: 5 },
  calDot: { width: 5, height: 5, borderRadius: 3 },
  calRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 6 },
  calChip: { borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2 },
  calChipText: {
    color: "#fff",
    fontSize: 11,
    fontWeight: "700",
    textTransform: "capitalize",
  },
  calDate: { width: 52, fontWeight: "600", fontSize: 14, color: "#2a2350" },
  calTitle: { flex: 1, fontSize: 14, color: "#2a2350" },
  calCountdown: { fontSize: 13, color: "#6b6280" },
  calRemove: { fontSize: 20, color: "#8b83a3", paddingHorizontal: 4 },
  // Messages
  tabBar: { flexGrow: 0 },
  tabBarContent: {
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: 16,
    paddingBottom: 8,
    alignItems: "center",
  },
  viewTab: {
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#efe4f0",
    borderRadius: 12,
    paddingVertical: 9,
    paddingHorizontal: 14,
    alignItems: "center",
  },
  viewTabActive: { backgroundColor: "#7b4bd0", borderColor: "#7b4bd0" },
  viewTabText: { fontSize: 11, fontWeight: "600", color: "#6b6280" },
  viewTabTextActive: { color: "#fff" },
  studyScroll: { padding: 16, gap: 12 },
  planStrip: {
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#7b4bd0",
    borderRadius: 14,
    padding: 12,
  },
  planStripHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 6,
  },
  planStripLabel: { fontSize: 14, fontWeight: "700", color: "#7b4bd0" },
  planStripNext: { flexDirection: "row", alignItems: "center", gap: 10 },
  planStripCheck: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: "#7b4bd0",
  },
  planStripNextText: { flex: 1, fontSize: 15, color: "#2a2350" },
  planStripNextLabel: { color: "#6b6280", fontWeight: "600" },
  planStripDone: { fontSize: 15, color: "#2a2350" },
  chatTabs: { maxHeight: 48, backgroundColor: "#fdf4f2" },
  chatTabsContent: {
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 6,
    alignItems: "center",
  },
  chatTab: {
    flexDirection: "row",
    alignItems: "center",
    maxWidth: 170,
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#efe4f0",
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  chatTabActive: { borderColor: "#7b4bd0", backgroundColor: "#f3ebfd" },
  chatTabLabel: { fontSize: 13, color: "#6b6280" },
  chatTabLabelActive: { color: "#2a2350", fontWeight: "600" },
  renameOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.4)",
    justifyContent: "center",
    padding: 28,
  },
  renameCard: {
    backgroundColor: "#fff",
    borderRadius: 16,
    padding: 20,
    gap: 14,
  },
  renameTitle: { fontSize: 17, fontWeight: "700", color: "#2a2350" },
  renameInput: {
    borderWidth: 1,
    borderColor: "#7b4bd0",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 11,
    fontSize: 16,
    color: "#2a2350",
  },
  renameActions: { flexDirection: "row", justifyContent: "flex-end", gap: 10 },
  renameCancel: { paddingHorizontal: 16, paddingVertical: 10, justifyContent: "center" },
  renameCancelText: { color: "#6b6280", fontSize: 15, fontWeight: "600" },
  renameSave: {
    backgroundColor: "#7b4bd0",
    borderRadius: 10,
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  renameSaveText: { color: "#fff", fontSize: 15, fontWeight: "600" },
  renameSubLabel: {
    fontSize: 12,
    fontWeight: "700",
    color: "#6b6280",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 4,
  },
  folderPickRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  folderPick: {
    borderWidth: 1,
    borderColor: "#efe4f0",
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 7,
    backgroundColor: "#fff",
  },
  folderPickActive: { backgroundColor: "#f3ebfd", borderColor: "#7b4bd0" },
  folderPickText: { fontSize: 13, color: "#2a2350" },
  folderPickTextActive: { color: "#7b4bd0", fontWeight: "600" },
  newFolderRow: { flexDirection: "row", gap: 8 },
  newFolderInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#efe4f0",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 14,
    color: "#2a2350",
  },
  newFolderBtn: {
    backgroundColor: "#7b4bd0",
    borderRadius: 10,
    paddingHorizontal: 16,
    justifyContent: "center",
  },
  newFolderBtnText: { color: "#fff", fontSize: 14, fontWeight: "600" },
  folderFilter: { flexGrow: 0, marginBottom: 6 },
  folderFilterContent: {
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: 16,
  },
  folderChip: {
    borderWidth: 1,
    borderColor: "#efe4f0",
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 5,
    backgroundColor: "#fff",
  },
  folderChipActive: { backgroundColor: "#7b4bd0", borderColor: "#7b4bd0" },
  folderChipText: { fontSize: 12.5, color: "#6b6280" },
  folderChipTextActive: { color: "#fff", fontWeight: "600" },
  chatTabClose: { fontSize: 13, color: "#8b83a3" },
  chatTabNew: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "#7b4bd0",
    alignItems: "center",
    justifyContent: "center",
  },
  chatTabNewText: { color: "#fff", fontSize: 18, lineHeight: 20 },
  list: { padding: 16, gap: 12 },
  bubble: { maxWidth: "85%", padding: 14, borderRadius: 18 },
  userBubble: { alignSelf: "flex-end", backgroundColor: "#7b4bd0" },
  assistantBubble: { alignSelf: "flex-start", backgroundColor: "#f3ebfd" },
  userText: { color: "#fff", fontSize: 17, lineHeight: 24 },
  assistantText: { color: "#2a2350", fontSize: 17, lineHeight: 24 },
  link: { color: "#7b4bd0", textDecorationLine: "underline" },
  // Markdown blocks inside an assistant bubble (see renderMessageBody).
  mdH2: {
    color: "#7b4bd0",
    fontSize: 17,
    fontWeight: "800",
    lineHeight: 23,
    marginTop: 12,
    marginBottom: 3,
  },
  mdH3: {
    color: "#2a2350",
    fontSize: 16,
    fontWeight: "700",
    lineHeight: 22,
    marginTop: 10,
    marginBottom: 2,
  },
  mdP: { marginVertical: 3 },
  mdBullet: { flexDirection: "row", gap: 8, marginVertical: 3 },
  mdBulletMark: { color: "#7b4bd0", fontWeight: "700", fontSize: 17, lineHeight: 24 },
  mdBold: { fontWeight: "700" },
  mdMark: { backgroundColor: "#ffe9a8", fontWeight: "600" },
  speakBtn: {
    borderWidth: 1,
    borderColor: "#efe4f0",
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 4,
    alignSelf: "flex-start",
  },
  speakBtnText: { color: "#7b4bd0", fontSize: 13 },
  videoWrap: { flexDirection: "row", flexWrap: "wrap", gap: 10, maxWidth: "90%" },
  videoCard: {
    width: 150,
    backgroundColor: "#fff",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#efe4f0",
    overflow: "hidden",
  },
  videoThumb: { width: "100%", height: 84, backgroundColor: "#e3e7e2" },
  videoMeta: { padding: 8 },
  videoTitle: { fontSize: 13, fontWeight: "600", color: "#2a2350", lineHeight: 17 },
  videoChannel: { fontSize: 11, color: "#6b6280", marginTop: 4 },
  socialWrap: { flexDirection: "row", flexWrap: "wrap", gap: 10, maxWidth: "90%" },
  socialCard: {
    width: 170,
    backgroundColor: "#fff",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#efe4f0",
    padding: 10,
    gap: 6,
  },
  socialBadge: {
    alignSelf: "flex-start",
    borderRadius: 999,
    paddingVertical: 3,
    paddingHorizontal: 8,
  },
  socialBadgeText: { color: "#fff", fontSize: 11, fontWeight: "700" },
  socialTitle: { fontSize: 13, fontWeight: "600", color: "#2a2350", lineHeight: 17 },
  socialNote: { fontSize: 11, color: "#6b6280", lineHeight: 15 },
  socialOpen: { fontSize: 12, fontWeight: "600", color: "#7b4bd0" },
  // Non-video resource cards (sites, books, practice sets)
  resourceWrap: { gap: 8, maxWidth: "90%" },
  resourceHeader: { fontSize: 13, fontWeight: "700", color: "#6b6280" },
  resourceCard: {
    backgroundColor: "#fff",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#efe4f0",
    padding: 10,
    gap: 6,
  },
  resourceTopRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  resourceBadge: {
    borderRadius: 999,
    paddingVertical: 3,
    paddingHorizontal: 8,
  },
  resourceBadgeText: { color: "#fff", fontSize: 11, fontWeight: "700" },
  resourceTitle: {
    flex: 1,
    fontSize: 13,
    fontWeight: "600",
    color: "#2a2350",
    lineHeight: 17,
  },
  resourceNote: { fontSize: 11, color: "#6b6280", lineHeight: 15 },
  resourceOpen: { fontSize: 12, fontWeight: "600", color: "#7b4bd0" },
  // Study tools (flashcards + quiz)
  toolBox: {
    maxWidth: "90%",
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#efe4f0",
    borderRadius: 14,
    padding: 14,
  },
  toolHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  toolTitle: { fontWeight: "700", fontSize: 16, color: "#2a2350" },
  flashcard: {
    minHeight: 120,
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: "#f3ebfd",
    borderWidth: 1,
    borderColor: "#efe4f0",
    borderRadius: 12,
    padding: 16,
  },
  flashcardLabel: { fontSize: 11, letterSpacing: 1, color: "#6b6280" },
  flashcardText: {
    fontSize: 19,
    fontWeight: "600",
    color: "#2a2350",
    textAlign: "center",
  },
  flashcardHint: { fontSize: 12, color: "#8b83a3" },

  // Flashcards studio — deck shelf, editor, and the flip card.
  fcNote: { fontSize: 13, color: "#6b6280", marginTop: 8, lineHeight: 19 },
  fcPaste: {
    marginTop: 10,
    minHeight: 74,
    borderWidth: 1,
    borderColor: "#efe4f0",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: "#2a2350",
    backgroundColor: "#fff",
    textAlignVertical: "top",
  },
  fcActions: { flexDirection: "row", gap: 8, marginTop: 12, flexWrap: "wrap" },
  fcBtn: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#7b4bd0",
    backgroundColor: "#f3ebfd",
  },
  fcBtnText: { color: "#7b4bd0", fontSize: 14, fontWeight: "600" },
  fcBtnGhost: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#efe4f0",
    backgroundColor: "#fff",
  },
  fcBtnGhostText: { color: "#6b6280", fontSize: 14, fontWeight: "600" },
  fcBtnGood: {
    flex: 1,
    minWidth: 130,
    paddingVertical: 13,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#2e7d32",
    backgroundColor: "#e4f4e6",
    alignItems: "center",
  },
  fcBtnGoodText: { color: "#2e7d32", fontSize: 15, fontWeight: "700" },
  fcBtnBad: {
    flex: 1,
    minWidth: 130,
    paddingVertical: 13,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#c0392b",
    backgroundColor: "#fbe9e7",
    alignItems: "center",
  },
  fcBtnBadText: { color: "#c0392b", fontSize: 15, fontWeight: "700" },
  fcEditRow: {
    borderWidth: 1,
    borderColor: "#efe4f0",
    borderRadius: 12,
    padding: 10,
    marginTop: 8,
    backgroundColor: "#fff",
  },
  fcEditHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 6,
    flexWrap: "wrap",
  },
  fcNum: { fontSize: 12, color: "#6b6280", fontWeight: "700", minWidth: 16 },
  fcBadge: {
    fontSize: 11,
    fontWeight: "700",
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 999,
    overflow: "hidden",
    backgroundColor: "#f3ebfd",
    color: "#7b4bd0",
  },
  fcBadgeYou: { backgroundColor: "#efe9f5", color: "#6b6280" },
  fcTopic: { fontSize: 11.5, color: "#8b83a3" },
  fcIconBtn: { color: "#6b6280", fontSize: 16, paddingHorizontal: 6 },
  fcEditFront: {
    borderWidth: 1,
    borderColor: "#efe4f0",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
    fontWeight: "600",
    color: "#2a2350",
    backgroundColor: "#fdf9ff",
    textAlignVertical: "top",
  },
  fcEditBack: {
    marginTop: 6,
    borderWidth: 1,
    borderColor: "#efe4f0",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
    color: "#2a2350",
    backgroundColor: "#fdf9ff",
    textAlignVertical: "top",
  },
  fcDeckRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 8 },
  fcDeckOpen: {
    flex: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#efe4f0",
    backgroundColor: "#fff",
  },
  fcDeckTitle: { fontSize: 14.5, fontWeight: "700", color: "#2a2350" },
  fcDeckMeta: { fontSize: 12, color: "#6b6280", marginTop: 2 },
  fcBar: {
    height: 6,
    borderRadius: 999,
    backgroundColor: "#efe4f0",
    marginTop: 12,
    overflow: "hidden",
  },
  fcBarFill: { height: "100%", backgroundColor: "#7b4bd0", borderRadius: 999 },
  fcCount: { fontSize: 12, color: "#6b6280", marginTop: 6 },
  fcFace: {
    minHeight: 180,
    marginTop: 12,
    paddingHorizontal: 18,
    paddingVertical: 22,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#efe4f0",
    backgroundColor: "#f3ebfd",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  fcSide: { fontSize: 11, letterSpacing: 1, fontWeight: "700", color: "#6b6280" },
  fcFaceText: {
    fontSize: 20,
    lineHeight: 28,
    fontWeight: "600",
    color: "#2a2350",
    textAlign: "center",
  },
  fcHint: { fontSize: 13, color: "#6b6280", fontStyle: "italic" },
  fcTapHint: { fontSize: 11.5, color: "#8b83a3" },
  fcScore: { fontSize: 26, fontWeight: "800", color: "#7b4bd0", marginTop: 12 },
  flashNav: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 10,
  },
  smallBtn: {
    borderWidth: 1,
    borderColor: "#efe4f0",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  smallBtnText: { color: "#2a2350", fontSize: 14 },
  quizQ: { fontWeight: "600", fontSize: 16, marginBottom: 6, color: "#2a2350" },
  quizOpt: {
    borderWidth: 1,
    borderColor: "#efe4f0",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 6,
  },
  quizOptText: { fontSize: 15, color: "#2a2350" },
  quizExplain: { fontSize: 14, color: "#6b6280", marginTop: 4 },
  quizDone: { fontSize: 15, color: "#2a2350", marginTop: 8, fontWeight: "600" },
  // Quick-action chips
  chips: { maxHeight: 52, backgroundColor: "#fdf4f2" },
  chipsContent: { gap: 8, paddingHorizontal: 12, paddingVertical: 8 },
  chip: {
    borderWidth: 1,
    borderColor: "#7b4bd0",
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: "#fff",
  },
  chipText: { color: "#7b4bd0", fontSize: 14 },
  assignAddRow: { flexDirection: "row", gap: 8, marginTop: 8 },
  assignInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#efe4f0",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: "#2a2350",
    backgroundColor: "#fff",
  },
  assignAddBtn: {
    backgroundColor: "#7b4bd0",
    borderRadius: 10,
    paddingHorizontal: 16,
    justifyContent: "center",
  },
  assignAddBtnText: { color: "#fff", fontSize: 15, fontWeight: "600" },
  assignSubjRow: { flexDirection: "row", gap: 6, paddingVertical: 2 },
  assignSubjChip: {
    borderWidth: 1,
    borderColor: "#efe4f0",
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: "#fff",
  },
  assignSubjChipActive: { backgroundColor: "#7b4bd0", borderColor: "#7b4bd0" },
  assignSubjChipText: { fontSize: 13, color: "#6b6280" },
  assignSubjChipTextActive: { color: "#fff" },
  assignEmpty: { color: "#6b6280", fontSize: 14, marginTop: 10 },
  subjectsCount: { fontSize: 13, color: "#6b6280", fontWeight: "600" },
  schedHint: { color: "#6b6280", fontSize: 13, marginTop: 4, marginBottom: 10 },
  schedBuildRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    marginBottom: 8,
  },
  schedBuildLabel: { fontSize: 14, color: "#2a2350", fontWeight: "600" },
  schedStepper: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderWidth: 1,
    borderColor: "#efe4f0",
    borderRadius: 10,
    padding: 2,
  },
  schedStepBtn: { paddingHorizontal: 12, paddingVertical: 4 },
  schedStepBtnText: { fontSize: 18, color: "#7b4bd0", fontWeight: "700" },
  schedStepVal: {
    fontSize: 14,
    fontWeight: "700",
    color: "#2a2350",
    minWidth: 74,
    textAlign: "center",
  },
  schedBuildBtn: {
    backgroundColor: "#f3ebfd",
    borderWidth: 1,
    borderColor: "#bcd9c4",
    borderRadius: 12,
    paddingVertical: 10,
    alignItems: "center",
    marginBottom: 12,
  },
  schedBuildBtnText: { color: "#7b4bd0", fontWeight: "700", fontSize: 14 },
  schedSetupBtn: {
    backgroundColor: "#7b4bd0",
    borderRadius: 12,
    paddingVertical: 11,
    alignItems: "center",
    marginBottom: 10,
  },
  schedSetupBtnText: { color: "#fff", fontWeight: "700", fontSize: 14 },
  schedList: { gap: 6 },
  schedRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#f7f8f6",
    borderRadius: 10,
    paddingVertical: 4,
    paddingRight: 6,
    paddingLeft: 8,
    borderLeftWidth: 4,
    borderLeftColor: "#efe4f0",
  },
  schedRowNow: {
    backgroundColor: "#f3ebfd",
    borderWidth: 1,
    borderColor: "#7b4bd0",
    borderLeftWidth: 4,
  },
  schedTimeWrap: { width: 66, flexShrink: 0 },
  schedTime: { fontSize: 12, fontWeight: "700", color: "#6b6280" },
  schedNowDot: {
    fontSize: 9,
    fontWeight: "800",
    color: "#7b4bd0",
    letterSpacing: 0.4,
  },
  schedKind: { flexShrink: 0, padding: 2 },
  schedKindEmoji: { fontSize: 18 },
  schedInput: {
    flex: 1,
    minWidth: 0,
    fontSize: 14,
    color: "#2a2350",
    paddingVertical: 6,
    paddingHorizontal: 4,
  },
  schedTimer: {
    flexShrink: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    backgroundColor: "#f3ebfd",
    borderRadius: 999,
    paddingHorizontal: 4,
    paddingVertical: 2,
  },
  schedTimerBtn: { paddingHorizontal: 4, paddingVertical: 2 },
  schedTimerBtnText: { fontSize: 13, color: "#7b4bd0", fontWeight: "700" },
  schedTimerTime: {
    fontSize: 13,
    fontWeight: "700",
    color: "#7b4bd0",
    minWidth: 40,
    textAlign: "center",
  },
  schedTimerDone: { color: "#7b4bd0" },
  schedTimerClear: { paddingHorizontal: 4, paddingVertical: 2 },
  schedTimerClearText: { fontSize: 12, color: "#6b6280" },
  schedTimerStart: { flexShrink: 0, paddingHorizontal: 6, paddingVertical: 4 },
  schedTimerStartText: { fontSize: 16, opacity: 0.6 },
  schedClearRow: { marginTop: 10, alignSelf: "flex-end" },
  assignItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: "#f2e7ee",
  },
  assignCheck: {
    width: 24,
    height: 24,
    borderRadius: 7,
    borderWidth: 1.5,
    borderColor: "#7b4bd0",
    backgroundColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
  },
  assignCheckDone: { backgroundColor: "#7b4bd0" },
  assignCheckMark: { color: "#fff", fontSize: 14, fontWeight: "700" },
  assignTitle: { fontSize: 15, color: "#2a2350" },
  assignTitleDone: {
    fontSize: 15,
    color: "#9b93b3",
    textDecorationLine: "line-through",
  },
  assignMeta: { fontSize: 12.5, color: "#6b6280", marginTop: 2 },
  assignRemove: { color: "#9b93b3", fontSize: 22, paddingHorizontal: 4 },
  concernAdd: { fontSize: 12.5, color: "#9b93b3", marginTop: 5 },
  concernRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 5,
  },
  concernIcon: { fontSize: 13 },
  concernInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#efe4f0",
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    fontSize: 12.5,
    color: "#2a2350",
    backgroundColor: "#fff",
  },
  // SMART goals
  goalField: { marginTop: 10 },
  goalFieldLabel: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 5,
  },
  goalFieldLabelText: {
    flex: 1,
    fontSize: 13,
    fontWeight: "600",
    color: "#2a2350",
  },
  goalLetter: {
    width: 20,
    height: 20,
    borderRadius: 6,
    backgroundColor: "#7b4bd0",
    color: "#fff",
    fontSize: 12,
    fontWeight: "700",
    textAlign: "center",
    lineHeight: 20,
    overflow: "hidden",
  },
  goalItem: {
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: "#f2e7ee",
  },
  goalTop: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  goalTitle: { fontSize: 15.5, fontWeight: "600", color: "#2a2350" },
  goalDue: {
    fontSize: 12,
    fontWeight: "600",
    color: "#7b4bd0",
    backgroundColor: "#f3ebfd",
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 2,
    overflow: "hidden",
  },
  goalDueOver: { color: "#c0392b", backgroundColor: "#fbeae8" },
  goalProgressRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 10,
    marginLeft: 34,
  },
  goalStep: {
    width: 28,
    height: 28,
    borderRadius: 7,
    borderWidth: 1,
    borderColor: "#d9ddd5",
    backgroundColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
  },
  goalStepText: { fontSize: 18, color: "#2a2350", lineHeight: 20 },
  goalTrack: {
    flex: 1,
    height: 8,
    borderRadius: 6,
    backgroundColor: "#f2e7ee",
    overflow: "hidden",
  },
  goalFill: { height: "100%", backgroundColor: "#7b4bd0" },
  goalCount: {
    fontSize: 12.5,
    color: "#6b6280",
    minWidth: 38,
    textAlign: "right",
  },
  goalNewBtn: {
    marginTop: 12,
    paddingVertical: 11,
    borderRadius: 10,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: "#7b4bd0",
    alignItems: "center",
  },
  goalNewBtnText: { color: "#7b4bd0", fontSize: 14, fontWeight: "600" },
  goalBreakBtn: {
    marginTop: 10,
    marginLeft: 34,
    alignSelf: "flex-start",
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: "#f3ebfd",
  },
  goalBreakBtnText: { color: "#7b4bd0", fontSize: 13, fontWeight: "600" },
  goalBreakRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    marginTop: 10,
    marginLeft: 34,
  },
  goalBreakClear: { color: "#9b93b3", fontSize: 13, fontWeight: "600" },
  stepMin: { fontSize: 11.5, color: "#9b93b3", fontWeight: "600" },
  goalTasks: { marginTop: 10, marginLeft: 34 },
  goalTasksHead: {
    fontSize: 11,
    fontWeight: "700",
    color: "#6b6280",
    letterSpacing: 0.3,
    marginBottom: 4,
  },
  goalTaskRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 4,
  },
  goalTaskToggle: {
    flex: 1,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
  },
  goalTaskText: { flex: 1, fontSize: 14.5, color: "#2a2350" },
  goalTaskHelp: {
    paddingVertical: 3,
    paddingHorizontal: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#7b4bd0",
  },
  goalTaskHelpText: { color: "#7b4bd0", fontSize: 12.5, fontWeight: "600" },
  // ── A checklist step, Google Tasks style ──────────────────────────────────
  // Round tick box on the left, then title / details / day stacked beside it,
  // with a hairline between steps and nothing boxing them in.
  gtRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    paddingVertical: 9,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#e4dff0",
  },
  gtCheck: {
    width: 20,
    height: 20,
    marginTop: 2,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: "#9b93b3",
    alignItems: "center",
    justifyContent: "center",
  },
  gtCheckDone: { backgroundColor: "#7b4bd0", borderColor: "#7b4bd0" },
  gtCheckMark: { color: "#fff", fontSize: 12, fontWeight: "700", lineHeight: 14 },
  gtBody: { flex: 1, minWidth: 0 },
  gtTitleLine: { flexDirection: "row", alignItems: "center", gap: 8 },
  gtTitle: { flex: 1, fontSize: 14.5, lineHeight: 21, color: "#2a2350" },
  // Done: the title is struck through. The details line under it is already
  // grey, so it's left alone — striking that through too reads as deleted.
  gtTitleDone: {
    color: "#6b6280",
    textDecorationLine: "line-through",
  },
  gtDetail: { fontSize: 13, lineHeight: 19, color: "#6b6280", marginTop: 1 },
  // "Add details" placeholder — there, but not asking to be read.
  gtDetailEmpty: { color: "#9b93b3" },
  gtDetailInput: {
    marginTop: 2,
    paddingVertical: 2,
    fontSize: 13,
    lineHeight: 19,
    color: "#2a2350",
  },
  gtChips: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 6 },
  gtChip: {
    borderRadius: 999,
    paddingVertical: 2,
    paddingHorizontal: 9,
    backgroundColor: "#f3ebfd",
  },
  gtChipOverdue: { backgroundColor: "#fdecea" },
  gtChipText: { fontSize: 11.5, fontWeight: "600", color: "#7b4bd0" },
  gtChipTextOverdue: { color: "#c5221f" },
  studyToolsGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 8,
  },
  studyToolBtn: {
    width: "48%",
    borderWidth: 1,
    borderColor: "#7b4bd0",
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
    backgroundColor: "#fff",
  },
  studyToolBtnText: { color: "#7b4bd0", fontSize: 15, fontWeight: "600" },
  nbLabel: {
    fontSize: 12.5,
    fontWeight: "800",
    color: "#7b4bd0",
    textTransform: "uppercase",
    marginTop: 8,
    marginBottom: 4,
  },
  planBuildBtn: {
    borderWidth: 1,
    borderColor: "#7b4bd0",
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 12,
    alignItems: "center",
    backgroundColor: "#fff",
  },
  planRebuildBtn: {
    alignSelf: "flex-start",
    borderWidth: 1,
    borderColor: "#7b4bd0",
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: "#fff",
  },
  planRebuildBtnText: { color: "#7b4bd0", fontSize: 13.5, fontWeight: "600" },
  reminderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: "#f2e7ee",
  },
  reminderCheck: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: "#7b4bd0",
    backgroundColor: "#fff",
  },
  reminderTap: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  reminderText: { flex: 1, fontSize: 14, color: "#2a2350" },
  reminderChevron: { color: "#9b93b3", fontSize: 18 },
  addClassRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    paddingHorizontal: 2,
  },
  addClassLabel: { fontSize: 13.5, color: "#6b6280", flexShrink: 1 },
  addClassPlus: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: "#7b4bd0",
    alignItems: "center",
    justifyContent: "center",
  },
  addClassPlusText: { color: "#fff", fontSize: 24, lineHeight: 28 },
  classSurveyLabel: {
    fontSize: 13.5,
    fontWeight: "600",
    color: "#2a2350",
    marginTop: 10,
    marginBottom: 4,
  },
  classSurveyActions: {
    flexDirection: "row",
    gap: 8,
    justifyContent: "flex-end",
    marginTop: 14,
  },
  classSurveyCancel: {
    borderWidth: 1,
    borderColor: "#efe4f0",
    borderRadius: 10,
    paddingHorizontal: 16,
    justifyContent: "center",
  },
  classSurveyCancelText: { color: "#6b6280", fontSize: 15, fontWeight: "600" },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    padding: 12,
    paddingBottom: 28,
    borderTopWidth: 1,
    borderTopColor: "#efe4f0",
    backgroundColor: "#fdf4f2",
  },
  input: {
    flex: 1,
    fontSize: 17,
    maxHeight: 120,
    backgroundColor: "#fff",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#efe4f0",
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  sendBtn: {
    backgroundColor: "#7b4bd0",
    borderRadius: 14,
    paddingHorizontal: 20,
    paddingVertical: 14,
    minWidth: 72,
    alignItems: "center",
  },
  sendText: { color: "#fff", fontSize: 17, fontWeight: "600" },
});
