import { useEffect, useRef, useState } from "react";
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
import Constants from "expo-constants";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system";
import * as Speech from "expo-speech";
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
type Flashcard = { front: string; back: string };
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
type EventKind = "exam" | "final" | "quiz" | "assignment" | "other";
type StudyEvent = { id: string; title: string; date: string; kind?: EventKind };
type Assignment = {
  id: string;
  title: string;
  subject?: string;
  due?: string;
  concern?: string; // what the learner is worried about / stuck on
  done: boolean;
};
// A SMART goal the learner sets (Specific, Measurable, Achievable, Relevant,
// Time-bound). Only `specific` is required; `target`/`current` drive a progress bar.
type GoalTask = { title: string; done: boolean };
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

const API_BASE_URL: string =
  (Constants.expoConfig?.extra?.apiBaseUrl as string) ?? "http://localhost:3000";

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
const KINDS: EventKind[] = ["exam", "final", "quiz", "assignment", "other"];
const KIND_COLOR: Record<EventKind, string> = {
  exam: "#b8742a",
  final: "#c0392b",
  quiz: "#2f6f8f",
  assignment: "#5b6660",
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
  { key: "study", emoji: "📚", label: "Study", color: "#2f6f4f" },
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
        placeholderTextColor="#9aa39d"
        returnKeyType="done"
      />
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
}: {
  assignments: Assignment[];
  subjects: string[];
  onAdd: (a: { title: string; subject?: string; due?: string }) => void;
  onToggle: (id: string) => void;
  onSetConcern: (id: string, concern: string) => void;
  onRemove: (id: string) => void;
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
          placeholderTextColor="#9aa39d"
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
        placeholderTextColor="#9aa39d"
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
        placeholderTextColor="#9aa39d"
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
                  <View key={i} style={styles.goalTaskRow}>
                    <TouchableOpacity
                      style={styles.goalTaskToggle}
                      onPress={() => onToggleTask(g.id, i)}
                    >
                      <View
                        style={[styles.checkbox, t.done && styles.checkboxOn]}
                      >
                        {t.done && <Text style={styles.checkmark}>✓</Text>}
                      </View>
                      <Text
                        style={[
                          styles.goalTaskText,
                          t.done && styles.assignTitleDone,
                        ]}
                      >
                        {t.title}
                      </Text>
                    </TouchableOpacity>
                    {!t.done && (
                      <TouchableOpacity
                        style={styles.goalTaskHelp}
                        onPress={() => onHelpTask(g, t.title)}
                      >
                        <Text style={styles.goalTaskHelpText}>Help</Text>
                      </TouchableOpacity>
                    )}
                  </View>
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
        placeholderTextColor="#9aa39d"
      />
      <Text style={styles.classSurveyLabel}>
        What do you struggle with in this class?
      </Text>
      <TextInput
        style={styles.assignInput}
        value={struggles}
        onChangeText={setStruggles}
        placeholder="e.g. balancing equations, word problems"
        placeholderTextColor="#9aa39d"
      />
      <Text style={styles.classSurveyLabel}>What do you want to get done?</Text>
      <TextInput
        style={styles.assignInput}
        value={goal}
        onChangeText={setGoal}
        placeholder="e.g. pass the unit test Friday"
        placeholderTextColor="#9aa39d"
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
            placeholderTextColor="#9aa39d"
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
    if (a.due) (dotsByDate[a.due] ||= []).push("#2f6f4f");
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
            placeholderTextColor="#8a938d"
          />
          <TextInput
            style={styles.calInput}
            value={date}
            onChangeText={setDate}
            placeholder="Date — YYYY-MM-DD"
            placeholderTextColor="#8a938d"
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
    "summary" | "studyguide" | "flashcards" | "quiz"
  >("summary");
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
        body: JSON.stringify({ ...src, output, profile }),
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
              placeholderTextColor="#8a938d"
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
                placeholderTextColor="#8a938d"
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
        <Text style={styles.flashcardLabel}>{flipped ? "ANSWER" : "TERM"}</Text>
        <Text style={styles.flashcardText}>{flipped ? card.back : card.front}</Text>
        <Text style={styles.flashcardHint}>tap to flip</Text>
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
    const detail = wrong
      .map(
        (q) =>
          `- ${q.topic || q.question}: correct answer is "${
            q.options[q.answerIndex]
          }"${q.explanation ? ` — ${q.explanation}` : ""}`,
      )
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
            else if (picked) bg = "#eef1ee";
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
          placeholderTextColor="#9aa39d"
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
      `Hi${name} 🌱 Thanks for sharing all that — I've got your info for ` +
      `${p.klass.trim()}. Want me to build your learning plan and find a few ` +
      `study videos to get started?`,
  };
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
        placeholderTextColor="#8a938d"
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
        <Text style={styles.formTitle}>Welcome to Eliora 🌱</Text>
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

        {field(
          "What grade or year are you currently in?",
          gradeYear,
          setGradeYear,
          "e.g. 10th grade, sophomore, Year 11",
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
  generating,
}: {
  schedule: DaySchedule | null;
  onSet: (hour: number, patch: Partial<ScheduleBlock>) => void;
  onClear: () => void;
  homeHour: number;
  onSetHomeHour: (h: number) => void;
  onGenerate: () => void;
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
          <ActivityIndicator color="#2f6f4f" />
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
                { borderLeftColor: hasText ? kind.color : "#d9ddd8" },
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
                placeholderTextColor="#9aa39d"
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
  const [editing, setEditing] = useState(false);
  const [summarizing, setSummarizing] = useState(false);
  const [tab, setTab] = useState<"chat" | "study" | "calendar" | "plan">("chat");
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
  const generateStudySchedule = async () => {
    if (generatingSchedule) return;
    setGeneratingSchedule(true);
    try {
      const res = await fetch(`${API_BASE_URL}/api/suggest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "schedule",
          homeHour,
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
            `Hi${name} 🌱 Thanks for sharing all that — give me a sec to look ` +
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
      "I just took a quiz and got some questions wrong. Make me a short, simple " +
        "study guide focused ONLY on these — re-teach each one in a fresh way, " +
        "then give me 2 quick practice questions:\n" +
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
      let flashcards: Flashcard[] | undefined;
      let quiz: QuizQuestion[] | undefined;

      const applyEvent = (line: string) => {
        if (!line.trim()) return;
        let evt: {
          type: string;
          value?: string;
          items?: Video[] | IncomingMilestone[] | Flashcard[] | QuizQuestion[];
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
        else if (evt.type === "flashcards")
          flashcards = (evt.items as Flashcard[]) ?? [];
        else if (evt.type === "quiz") quiz = (evt.items as QuizQuestion[]) ?? [];
        setMessages((prev) => {
          const copy = [...prev];
          copy[copy.length - 1] = {
            role: "assistant",
            content: acc,
            videos: videos.length ? [...videos] : undefined,
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
          <Text style={styles.viewTabText}>📝 Notes</Text>
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
          />
          <ScheduleCard
            schedule={schedule}
            onSet={setScheduleBlock}
            onClear={clearSchedule}
            homeHour={homeHour}
            onSetHomeHour={setHomeHour}
            onGenerate={generateStudySchedule}
            generating={generatingSchedule}
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
              <PlanPanel
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
              <Text style={{ color: "#5b6660", marginVertical: 8 }}>
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
              <Text style={{ color: "#5b6660", marginTop: 12, marginBottom: 4 }}>
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
                  ["🃏 Flashcards", "Make me flashcards to study."],
                  ["📝 Quiz me", "Quiz me on what I'm learning."],
                  ["📚 Study guide", "Make me a study guide for what I should review."],
                  ["🎬 Study videos", "Recommend me a few study videos for my class."],
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
        </ScrollView>
      ) : tab === "calendar" ? (
        <ScrollView contentContainerStyle={styles.studyScroll}>
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
              placeholderTextColor="#8a938d"
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
                placeholderTextColor="#8a938d"
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
              <Text
                style={item.role === "user" ? styles.userText : styles.assistantText}
              >
                {item.content ? renderContent(item.content) : busy ? "…" : ""}
              </Text>
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
          placeholderTextColor="#8a938d"
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
  container: { flex: 1, backgroundColor: "#f7f5f0" },
  // Sign-up form
  formScroll: { padding: 20, paddingTop: 64, paddingBottom: 48, gap: 16 },
  formTitle: { fontSize: 26, fontWeight: "700", color: "#2f6f4f" },
  formIntro: { fontSize: 16, color: "#5b6660", lineHeight: 22 },
  field: { gap: 6 },
  fieldLabel: { fontSize: 16, fontWeight: "600", color: "#1c2421" },
  choiceBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#d9ddd8",
    backgroundColor: "#fff",
    marginTop: 8,
  },
  choiceBtnSelected: { borderColor: "#2f6f4f", backgroundColor: "#eef4f0" },
  choiceRadio: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1.5,
    borderColor: "#2f6f4f",
    backgroundColor: "#fff",
  },
  choiceRadioSelected: { backgroundColor: "#2f6f4f" },
  choiceText: { flex: 1, fontSize: 15, color: "#1c2421" },
  choiceHint: { fontWeight: "400", fontSize: 13, color: "#5b6660" },
  choiceCheckbox: {
    width: 18,
    height: 18,
    borderRadius: 5,
    borderWidth: 1.5,
    borderColor: "#2f6f4f",
    backgroundColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
  },
  choiceCheckboxSelected: { backgroundColor: "#2f6f4f" },
  choiceCheckMark: { color: "#fff", fontSize: 12, fontWeight: "700", lineHeight: 14 },
  formInput: {
    fontSize: 17,
    backgroundColor: "#fff",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#d9ddd8",
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  formTextarea: { minHeight: 64, textAlignVertical: "top" },
  formActions: { flexDirection: "row", justifyContent: "flex-end", gap: 10, marginTop: 8 },
  primaryBtn: {
    backgroundColor: "#2f6f4f",
    borderRadius: 14,
    paddingHorizontal: 22,
    paddingVertical: 14,
  },
  primaryBtnDisabled: { opacity: 0.5 },
  primaryBtnText: { color: "#fff", fontSize: 17, fontWeight: "600" },
  secondaryBtn: {
    borderWidth: 1,
    borderColor: "#d9ddd8",
    borderRadius: 14,
    paddingHorizontal: 22,
    paddingVertical: 14,
  },
  secondaryBtnText: { color: "#5b6660", fontSize: 17 },
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
    borderColor: "#d9ddd8",
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: "center",
  },
  tabActive: { backgroundColor: "#2f6f4f", borderColor: "#2f6f4f" },
  tabText: { fontSize: 15, color: "#5b6660" },
  tabTextActive: { color: "#fff", fontWeight: "600" },
  resultBox: {
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#d9ddd8",
    borderRadius: 12,
    padding: 14,
    gap: 12,
  },
  resultText: { fontSize: 16, lineHeight: 24, color: "#1c2421" },
  outputRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  outChip: {
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#d9ddd8",
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  outChipActive: { backgroundColor: "#2f6f4f", borderColor: "#2f6f4f" },
  outChipText: { fontSize: 13, color: "#5b6660" },
  outChipTextActive: { color: "#fff", fontWeight: "600" },
  // Chat header
  header: {
    paddingTop: 64,
    paddingHorizontal: 20,
    paddingBottom: 8,
    flexDirection: "row",
    alignItems: "flex-start",
  },
  title: { fontSize: 28, fontWeight: "700", color: "#2f6f4f" },
  subtitle: { fontSize: 15, color: "#5b6660", marginTop: 2 },
  headerBtns: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    gap: 8,
    marginTop: 4,
  },
  ghostBtn: {
    borderWidth: 1,
    borderColor: "#2f6f4f",
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  ghostBtnText: { color: "#2f6f4f", fontSize: 13, fontWeight: "600" },
  timerDisplay: {
    fontSize: 72,
    fontWeight: "700",
    textAlign: "center",
    color: "#2f6f4f",
    marginVertical: 8,
  },
  timerDone: {
    textAlign: "center",
    fontSize: 17,
    color: "#1c2421",
    marginBottom: 4,
  },
  // Focus garden
  coins: { fontSize: 16, fontWeight: "700", color: "#2f6f4f" },
  scene: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#d9ddd8",
    minHeight: 150,
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    padding: 16,
    marginBottom: 4,
  },
  sceneFlower: { fontSize: 60 },
  sceneNote: { fontSize: 15, color: "#5b6660", textAlign: "center" },
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
  locName: { flex: 1, fontSize: 15, fontWeight: "600", color: "#1c2421" },
  locCurrent: { fontSize: 13, fontWeight: "700", color: "#2f6f4f" },
  smallGhost: {
    borderWidth: 1,
    borderColor: "#2f6f4f",
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  smallGhostText: { color: "#2f6f4f", fontSize: 13 },
  levelChip: {
    backgroundColor: "#2f6f4f",
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
  customLabel: { fontSize: 14, color: "#5b6660" },
  customInput: {
    width: 70,
    fontSize: 15,
    backgroundColor: "#fff",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#d9ddd8",
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
    backgroundColor: "#2f6f4f",
    borderRadius: 12,
    padding: 12,
    marginBottom: 4,
  },
  achToastText: { color: "#fff", fontSize: 15, fontWeight: "600" },
  fbCard: {
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#d9ddd8",
    borderRadius: 14,
    padding: 16,
    marginBottom: 10,
    gap: 8,
  },
  fbTitle: { fontSize: 17, fontWeight: "700", color: "#2f6f4f" },
  fbSub: { fontSize: 15, color: "#1c2421" },
  fbInput: {
    borderWidth: 1,
    borderColor: "#c7cdc5",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: "#1c2421",
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
    borderColor: "#d9ddd8",
    backgroundColor: "#e7efe8",
  },
  fbMoodText: { fontSize: 14, fontWeight: "600", color: "#1c2421" },
  fbSkip: { color: "#5b6660", fontSize: 14, marginTop: 2 },
  achItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#d9ddd8",
    borderRadius: 12,
    padding: 10,
    marginBottom: 6,
  },
  achEmoji: { fontSize: 22 },
  achName: { fontSize: 14, fontWeight: "600", color: "#1c2421" },
  // Profile card
  card: {
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#d9ddd8",
    borderRadius: 14,
    padding: 12,
  },
  cardHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  cardClass: { flex: 1, fontWeight: "700", fontSize: 16, color: "#2f6f4f" },
  linkBtn: {
    color: "#2f6f4f",
    fontSize: 14,
    textDecorationLine: "underline",
  },
  cardRow: { fontSize: 14, color: "#1c2421", marginTop: 6 },
  cardLabel: { color: "#5b6660" },
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
  folderText: { fontSize: 14, color: "#1c2421" },
  folderRemove: { fontSize: 14, color: "#8a938d" },
  // Plan panel
  plan: {
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#d9ddd8",
    borderRadius: 14,
    padding: 12,
  },
  planHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  planTitle: { fontWeight: "700", fontSize: 16, color: "#1c2421" },
  planCount: { fontSize: 14, color: "#5b6660" },
  progressTrack: {
    height: 8,
    borderRadius: 6,
    backgroundColor: "#eef1ee",
    marginVertical: 10,
    overflow: "hidden",
  },
  progressFill: { height: "100%", backgroundColor: "#2f6f4f", borderRadius: 6 },
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
    borderColor: "#2f6f4f",
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxOn: { backgroundColor: "#2f6f4f" },
  checkboxCheckpoint: { borderColor: "#b8742a" },
  checkboxOnCheckpoint: { backgroundColor: "#b8742a", borderColor: "#b8742a" },
  checkmark: { color: "#fff", fontSize: 14, lineHeight: 16 },
  planItemText: { flex: 1, fontSize: 15, color: "#1c2421", lineHeight: 21 },
  planItemDone: { textDecorationLine: "line-through", color: "#8a938d" },
  checkpointBadge: { color: "#b8742a", fontWeight: "700", fontSize: 12 },
  // Calendar
  calForm: { gap: 8, marginVertical: 10 },
  calInput: {
    fontSize: 15,
    backgroundColor: "#fff",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#d9ddd8",
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  kindRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  kindChip: {
    borderWidth: 1,
    borderColor: "#d9ddd8",
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  kindChipText: { fontSize: 13, color: "#5b6660", textTransform: "capitalize" },
  calAddBtn: {
    backgroundColor: "#2f6f4f",
    borderRadius: 10,
    paddingVertical: 11,
    alignItems: "center",
  },
  calAddBtnText: { color: "#fff", fontSize: 15, fontWeight: "600" },
  calEmpty: { fontSize: 14, color: "#5b6660", marginTop: 8 },
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
    borderColor: "#d9ddd8",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#fff",
  },
  calNavBtnText: { fontSize: 20, color: "#2f6f4f", lineHeight: 22 },
  calMonthLabel: { fontSize: 15, fontWeight: "700", color: "#1c2421" },
  calWeekRow: { flexDirection: "row", marginBottom: 4 },
  calWeekday: {
    width: "14.28%",
    textAlign: "center",
    fontSize: 11,
    fontWeight: "600",
    color: "#5b6660",
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
  calBoxToday: { borderColor: "#2f6f4f", borderWidth: 2 },
  calBoxNum: { fontSize: 13, color: "#1c2421" },
  calBoxNumToday: { color: "#2f6f4f", fontWeight: "700" },
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
  calDate: { width: 52, fontWeight: "600", fontSize: 14, color: "#1c2421" },
  calTitle: { flex: 1, fontSize: 14, color: "#1c2421" },
  calCountdown: { fontSize: 13, color: "#5b6660" },
  calRemove: { fontSize: 20, color: "#8a938d", paddingHorizontal: 4 },
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
    borderColor: "#d9ddd8",
    borderRadius: 12,
    paddingVertical: 9,
    paddingHorizontal: 14,
    alignItems: "center",
  },
  viewTabActive: { backgroundColor: "#2f6f4f", borderColor: "#2f6f4f" },
  viewTabText: { fontSize: 11, fontWeight: "600", color: "#5b6660" },
  viewTabTextActive: { color: "#fff" },
  studyScroll: { padding: 16, gap: 12 },
  planStrip: {
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#2f6f4f",
    borderRadius: 14,
    padding: 12,
  },
  planStripHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 6,
  },
  planStripLabel: { fontSize: 14, fontWeight: "700", color: "#2f6f4f" },
  planStripNext: { flexDirection: "row", alignItems: "center", gap: 10 },
  planStripCheck: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: "#2f6f4f",
  },
  planStripNextText: { flex: 1, fontSize: 15, color: "#1c2421" },
  planStripNextLabel: { color: "#5b6660", fontWeight: "600" },
  planStripDone: { fontSize: 15, color: "#1c2421" },
  chatTabs: { maxHeight: 48, backgroundColor: "#f7f5f0" },
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
    borderColor: "#d9ddd8",
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  chatTabActive: { borderColor: "#2f6f4f", backgroundColor: "#eef1ee" },
  chatTabLabel: { fontSize: 13, color: "#5b6660" },
  chatTabLabelActive: { color: "#1c2421", fontWeight: "600" },
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
  renameTitle: { fontSize: 17, fontWeight: "700", color: "#1c2421" },
  renameInput: {
    borderWidth: 1,
    borderColor: "#2f6f4f",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 11,
    fontSize: 16,
    color: "#1c2421",
  },
  renameActions: { flexDirection: "row", justifyContent: "flex-end", gap: 10 },
  renameCancel: { paddingHorizontal: 16, paddingVertical: 10, justifyContent: "center" },
  renameCancelText: { color: "#5b6660", fontSize: 15, fontWeight: "600" },
  renameSave: {
    backgroundColor: "#2f6f4f",
    borderRadius: 10,
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  renameSaveText: { color: "#fff", fontSize: 15, fontWeight: "600" },
  renameSubLabel: {
    fontSize: 12,
    fontWeight: "700",
    color: "#5b6660",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 4,
  },
  folderPickRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  folderPick: {
    borderWidth: 1,
    borderColor: "#d9ddd8",
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 7,
    backgroundColor: "#fff",
  },
  folderPickActive: { backgroundColor: "#eef4f0", borderColor: "#2f6f4f" },
  folderPickText: { fontSize: 13, color: "#1c2421" },
  folderPickTextActive: { color: "#2f6f4f", fontWeight: "600" },
  newFolderRow: { flexDirection: "row", gap: 8 },
  newFolderInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#d9ddd8",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 14,
    color: "#1c2421",
  },
  newFolderBtn: {
    backgroundColor: "#2f6f4f",
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
    borderColor: "#d9ddd8",
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 5,
    backgroundColor: "#fff",
  },
  folderChipActive: { backgroundColor: "#2f6f4f", borderColor: "#2f6f4f" },
  folderChipText: { fontSize: 12.5, color: "#5b6660" },
  folderChipTextActive: { color: "#fff", fontWeight: "600" },
  chatTabClose: { fontSize: 13, color: "#8a938d" },
  chatTabNew: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "#2f6f4f",
    alignItems: "center",
    justifyContent: "center",
  },
  chatTabNewText: { color: "#fff", fontSize: 18, lineHeight: 20 },
  list: { padding: 16, gap: 12 },
  bubble: { maxWidth: "85%", padding: 14, borderRadius: 18 },
  userBubble: { alignSelf: "flex-end", backgroundColor: "#2f6f4f" },
  assistantBubble: { alignSelf: "flex-start", backgroundColor: "#eef1ee" },
  userText: { color: "#fff", fontSize: 17, lineHeight: 24 },
  assistantText: { color: "#1c2421", fontSize: 17, lineHeight: 24 },
  link: { color: "#2f6f4f", textDecorationLine: "underline" },
  speakBtn: {
    borderWidth: 1,
    borderColor: "#d9ddd8",
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 4,
    alignSelf: "flex-start",
  },
  speakBtnText: { color: "#2f6f4f", fontSize: 13 },
  videoWrap: { flexDirection: "row", flexWrap: "wrap", gap: 10, maxWidth: "90%" },
  videoCard: {
    width: 150,
    backgroundColor: "#fff",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#d9ddd8",
    overflow: "hidden",
  },
  videoThumb: { width: "100%", height: 84, backgroundColor: "#e3e7e2" },
  videoMeta: { padding: 8 },
  videoTitle: { fontSize: 13, fontWeight: "600", color: "#1c2421", lineHeight: 17 },
  videoChannel: { fontSize: 11, color: "#5b6660", marginTop: 4 },
  // Study tools (flashcards + quiz)
  toolBox: {
    maxWidth: "90%",
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#d9ddd8",
    borderRadius: 14,
    padding: 14,
  },
  toolHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  toolTitle: { fontWeight: "700", fontSize: 16, color: "#1c2421" },
  flashcard: {
    minHeight: 120,
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: "#eef1ee",
    borderWidth: 1,
    borderColor: "#d9ddd8",
    borderRadius: 12,
    padding: 16,
  },
  flashcardLabel: { fontSize: 11, letterSpacing: 1, color: "#5b6660" },
  flashcardText: {
    fontSize: 19,
    fontWeight: "600",
    color: "#1c2421",
    textAlign: "center",
  },
  flashcardHint: { fontSize: 12, color: "#8a938d" },
  flashNav: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 10,
  },
  smallBtn: {
    borderWidth: 1,
    borderColor: "#d9ddd8",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  smallBtnText: { color: "#1c2421", fontSize: 14 },
  quizQ: { fontWeight: "600", fontSize: 16, marginBottom: 6, color: "#1c2421" },
  quizOpt: {
    borderWidth: 1,
    borderColor: "#d9ddd8",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 6,
  },
  quizOptText: { fontSize: 15, color: "#1c2421" },
  quizExplain: { fontSize: 14, color: "#5b6660", marginTop: 4 },
  quizDone: { fontSize: 15, color: "#1c2421", marginTop: 8, fontWeight: "600" },
  // Quick-action chips
  chips: { maxHeight: 52, backgroundColor: "#f7f5f0" },
  chipsContent: { gap: 8, paddingHorizontal: 12, paddingVertical: 8 },
  chip: {
    borderWidth: 1,
    borderColor: "#2f6f4f",
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: "#fff",
  },
  chipText: { color: "#2f6f4f", fontSize: 14 },
  assignAddRow: { flexDirection: "row", gap: 8, marginTop: 8 },
  assignInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#d9ddd8",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: "#1c2421",
    backgroundColor: "#fff",
  },
  assignAddBtn: {
    backgroundColor: "#2f6f4f",
    borderRadius: 10,
    paddingHorizontal: 16,
    justifyContent: "center",
  },
  assignAddBtnText: { color: "#fff", fontSize: 15, fontWeight: "600" },
  assignSubjRow: { flexDirection: "row", gap: 6, paddingVertical: 2 },
  assignSubjChip: {
    borderWidth: 1,
    borderColor: "#d9ddd8",
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: "#fff",
  },
  assignSubjChipActive: { backgroundColor: "#2f6f4f", borderColor: "#2f6f4f" },
  assignSubjChipText: { fontSize: 13, color: "#5b6660" },
  assignSubjChipTextActive: { color: "#fff" },
  assignEmpty: { color: "#5b6660", fontSize: 14, marginTop: 10 },
  subjectsCount: { fontSize: 13, color: "#5b6660", fontWeight: "600" },
  schedHint: { color: "#5b6660", fontSize: 13, marginTop: 4, marginBottom: 10 },
  schedBuildRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    marginBottom: 8,
  },
  schedBuildLabel: { fontSize: 14, color: "#1c2421", fontWeight: "600" },
  schedStepper: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderWidth: 1,
    borderColor: "#d9ddd8",
    borderRadius: 10,
    padding: 2,
  },
  schedStepBtn: { paddingHorizontal: 12, paddingVertical: 4 },
  schedStepBtnText: { fontSize: 18, color: "#2f6f4f", fontWeight: "700" },
  schedStepVal: {
    fontSize: 14,
    fontWeight: "700",
    color: "#1c2421",
    minWidth: 74,
    textAlign: "center",
  },
  schedBuildBtn: {
    backgroundColor: "#eaf3ec",
    borderWidth: 1,
    borderColor: "#bcd9c4",
    borderRadius: 12,
    paddingVertical: 10,
    alignItems: "center",
    marginBottom: 12,
  },
  schedBuildBtnText: { color: "#2f6f4f", fontWeight: "700", fontSize: 14 },
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
    borderLeftColor: "#d9ddd8",
  },
  schedRowNow: {
    backgroundColor: "#eaf3ec",
    borderWidth: 1,
    borderColor: "#2f6f4f",
    borderLeftWidth: 4,
  },
  schedTimeWrap: { width: 66, flexShrink: 0 },
  schedTime: { fontSize: 12, fontWeight: "700", color: "#5b6660" },
  schedNowDot: {
    fontSize: 9,
    fontWeight: "800",
    color: "#2f6f4f",
    letterSpacing: 0.4,
  },
  schedKind: { flexShrink: 0, padding: 2 },
  schedKindEmoji: { fontSize: 18 },
  schedInput: {
    flex: 1,
    minWidth: 0,
    fontSize: 14,
    color: "#1c2421",
    paddingVertical: 6,
    paddingHorizontal: 4,
  },
  schedTimer: {
    flexShrink: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    backgroundColor: "#eaf3ec",
    borderRadius: 999,
    paddingHorizontal: 4,
    paddingVertical: 2,
  },
  schedTimerBtn: { paddingHorizontal: 4, paddingVertical: 2 },
  schedTimerBtnText: { fontSize: 13, color: "#2f6f4f", fontWeight: "700" },
  schedTimerTime: {
    fontSize: 13,
    fontWeight: "700",
    color: "#2f6f4f",
    minWidth: 40,
    textAlign: "center",
  },
  schedTimerDone: { color: "#2f6f4f" },
  schedTimerClear: { paddingHorizontal: 4, paddingVertical: 2 },
  schedTimerClearText: { fontSize: 12, color: "#5b6660" },
  schedTimerStart: { flexShrink: 0, paddingHorizontal: 6, paddingVertical: 4 },
  schedTimerStartText: { fontSize: 16, opacity: 0.6 },
  schedClearRow: { marginTop: 10, alignSelf: "flex-end" },
  assignItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: "#eceae3",
  },
  assignCheck: {
    width: 24,
    height: 24,
    borderRadius: 7,
    borderWidth: 1.5,
    borderColor: "#2f6f4f",
    backgroundColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
  },
  assignCheckDone: { backgroundColor: "#2f6f4f" },
  assignCheckMark: { color: "#fff", fontSize: 14, fontWeight: "700" },
  assignTitle: { fontSize: 15, color: "#1c2421" },
  assignTitleDone: {
    fontSize: 15,
    color: "#9aa39d",
    textDecorationLine: "line-through",
  },
  assignMeta: { fontSize: 12.5, color: "#5b6660", marginTop: 2 },
  assignRemove: { color: "#9aa39d", fontSize: 22, paddingHorizontal: 4 },
  concernAdd: { fontSize: 12.5, color: "#9aa39d", marginTop: 5 },
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
    borderColor: "#d9ddd8",
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    fontSize: 12.5,
    color: "#1c2421",
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
    color: "#1c2421",
  },
  goalLetter: {
    width: 20,
    height: 20,
    borderRadius: 6,
    backgroundColor: "#2f6f4f",
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
    borderTopColor: "#eceae3",
  },
  goalTop: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  goalTitle: { fontSize: 15.5, fontWeight: "600", color: "#1c2421" },
  goalDue: {
    fontSize: 12,
    fontWeight: "600",
    color: "#2f6f4f",
    backgroundColor: "#eef4f0",
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
  goalStepText: { fontSize: 18, color: "#1c2421", lineHeight: 20 },
  goalTrack: {
    flex: 1,
    height: 8,
    borderRadius: 6,
    backgroundColor: "#eceae3",
    overflow: "hidden",
  },
  goalFill: { height: "100%", backgroundColor: "#2f6f4f" },
  goalCount: {
    fontSize: 12.5,
    color: "#5b6660",
    minWidth: 38,
    textAlign: "right",
  },
  goalNewBtn: {
    marginTop: 12,
    paddingVertical: 11,
    borderRadius: 10,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: "#2f6f4f",
    alignItems: "center",
  },
  goalNewBtnText: { color: "#2f6f4f", fontSize: 14, fontWeight: "600" },
  goalBreakBtn: {
    marginTop: 10,
    marginLeft: 34,
    alignSelf: "flex-start",
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: "#e7efe8",
  },
  goalBreakBtnText: { color: "#2f6f4f", fontSize: 13, fontWeight: "600" },
  goalTasks: { marginTop: 10, marginLeft: 34 },
  goalTasksHead: {
    fontSize: 11,
    fontWeight: "700",
    color: "#5b6660",
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
  goalTaskText: { flex: 1, fontSize: 14.5, color: "#1c2421" },
  goalTaskHelp: {
    paddingVertical: 3,
    paddingHorizontal: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#2f6f4f",
  },
  goalTaskHelpText: { color: "#2f6f4f", fontSize: 12.5, fontWeight: "600" },
  studyToolsGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 8,
  },
  studyToolBtn: {
    width: "48%",
    borderWidth: 1,
    borderColor: "#2f6f4f",
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
    backgroundColor: "#fff",
  },
  studyToolBtnText: { color: "#2f6f4f", fontSize: 15, fontWeight: "600" },
  planBuildBtn: {
    borderWidth: 1,
    borderColor: "#2f6f4f",
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 12,
    alignItems: "center",
    backgroundColor: "#fff",
  },
  planRebuildBtn: {
    alignSelf: "flex-start",
    borderWidth: 1,
    borderColor: "#2f6f4f",
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: "#fff",
  },
  planRebuildBtnText: { color: "#2f6f4f", fontSize: 13.5, fontWeight: "600" },
  reminderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: "#eceae3",
  },
  reminderCheck: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: "#2f6f4f",
    backgroundColor: "#fff",
  },
  reminderTap: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  reminderText: { flex: 1, fontSize: 14, color: "#1c2421" },
  reminderChevron: { color: "#9aa39d", fontSize: 18 },
  addClassRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    paddingHorizontal: 2,
  },
  addClassLabel: { fontSize: 13.5, color: "#5b6660", flexShrink: 1 },
  addClassPlus: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: "#2f6f4f",
    alignItems: "center",
    justifyContent: "center",
  },
  addClassPlusText: { color: "#fff", fontSize: 24, lineHeight: 28 },
  classSurveyLabel: {
    fontSize: 13.5,
    fontWeight: "600",
    color: "#1c2421",
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
    borderColor: "#d9ddd8",
    borderRadius: 10,
    paddingHorizontal: 16,
    justifyContent: "center",
  },
  classSurveyCancelText: { color: "#5b6660", fontSize: 15, fontWeight: "600" },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    padding: 12,
    paddingBottom: 28,
    borderTopWidth: 1,
    borderTopColor: "#d9ddd8",
    backgroundColor: "#f7f5f0",
  },
  input: {
    flex: 1,
    fontSize: 17,
    maxHeight: 120,
    backgroundColor: "#fff",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#d9ddd8",
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  sendBtn: {
    backgroundColor: "#2f6f4f",
    borderRadius: 14,
    paddingHorizontal: 20,
    paddingVertical: 14,
    minWidth: 72,
    alignItems: "center",
  },
  sendText: { color: "#fff", fontSize: 17, fontWeight: "600" },
});
