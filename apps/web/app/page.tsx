"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { signIn, signOut, useSession } from "next-auth/react";
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
type EventKind = "exam" | "final" | "quiz" | "assignment" | "other";
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
  done: boolean;
};
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
  done: boolean;
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
      (c) => (c.category ?? "").toLowerCase() === r.subject.toLowerCase(),
    );
    return {
      subject: r.subject,
      required: r.required,
      planned: inCat.reduce((n, c) => n + cr(c), 0),
      earned: inCat.filter((c) => c.done).reduce((n, c) => n + cr(c), 0),
    };
  });

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
  };
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

function speak(text: string) {
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 0.95;
  window.speechSynthesis.speak(u);
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
    key: Exclude<keyof A11y, "fontScale">;
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
      </div>
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
              {(a.subject || a.due) && (
                <div style={styles.assignMeta}>
                  {a.subject}
                  {a.subject && a.due ? " · " : ""}
                  {a.due ? `due ${a.due}` : ""}
                </div>
              )}
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
            <div
              style={{
                ...styles.goalGroupHead,
                ...(grp.highlight ? styles.goalGroupHeadHighlight : {}),
              }}
            >
              {grp.title} · {inGroup.length}
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
type DailyTask = {
  title: string;
  why?: string;
  subject?: string;
  done: boolean;
};
type DailyTasksState = { date: string; tasks: DailyTask[] };
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

// Home-dashboard card: type (or tap) a topic to open a brand-new chat that
// Eliora kicks off — a beginner-friendly intro plus the first step. Suggests
// topics from the learner's class, subject folders, and weak spots.
function TopicStarter({
  profile,
  subjects,
  missed,
  busy,
  onStart,
}: {
  profile: LearnerProfile | null;
  subjects: string[];
  missed: string[];
  busy: boolean;
  onStart: (topic: string) => void;
}) {
  const [topic, setTopic] = useState("");
  const suggestions = Array.from(
    new Set(
      [
        ...(profile?.klass ? [profile.klass] : []),
        ...subjects,
        ...missed.slice(0, 3),
      ]
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ).slice(0, 5);
  const start = (t: string) => {
    const v = t.trim();
    if (!v || busy) return;
    onStart(v);
    setTopic("");
  };
  return (
    <div style={styles.card}>
      <div style={styles.cardHead}>
        <span style={styles.cardClass}>💬 Start a lesson</span>
      </div>
      <p style={{ color: "var(--muted)", margin: "2px 0 10px", fontSize: 13 }}>
        Pick a topic and I&apos;ll open a new chat and walk you through it.
      </p>
      <div style={styles.topicRow}>
        <input
          style={styles.topicInput}
          value={topic}
          placeholder="e.g. photosynthesis, quadratic equations…"
          onChange={(e) => setTopic(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") start(topic);
          }}
          disabled={busy}
        />
        <button
          style={styles.topicBtn}
          disabled={busy || !topic.trim()}
          onClick={() => start(topic)}
        >
          Start →
        </button>
      </div>
      {suggestions.length > 0 && (
        <div style={styles.topicChips}>
          {suggestions.map((s) => (
            <button
              key={s}
              style={styles.topicChip}
              disabled={busy}
              onClick={() => start(s)}
              title={`Start a lesson on ${s}`}
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Home-dashboard card: a fresh, tiny to-do list Eliora generates for TODAY from
// the learner's plan, goals, calendar, assignments, and weak spots. It refreshes
// on its own each new day; the learner can check tasks off or ask for a new set.
function DailyTasksCard({
  state,
  loading,
  onGenerate,
  onToggle,
}: {
  state: DailyTasksState | null;
  loading: boolean;
  onGenerate: () => void;
  onToggle: (i: number) => void;
}) {
  const today = localISO();
  const fresh = state?.date === today;
  const tasks = fresh ? state!.tasks : [];
  const doneCount = tasks.filter((t) => t.done).length;
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
          {tasks.map((t, i) => (
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
                <div style={t.done ? styles.assignTitleDone : styles.assignTitle}>
                  {t.title}
                </div>
                {(t.subject || t.why) && (
                  <div style={styles.assignMeta}>
                    {t.subject}
                    {t.subject && t.why ? " · " : ""}
                    {t.why}
                  </div>
                )}
              </div>
            </div>
          ))}
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
// Profile badges. Each has its own designed medallion (a gradient + emoji), a
// bit of flavor text, and the criteria to earn it. `met` is checked against the
// learner's live stats so we can show earned ones in color and the rest dimmed.
type BadgeStats = { total: number; activeDays: number; streak: number };
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
];

function badgeStats(log: Record<string, number>, streak: number): BadgeStats {
  return {
    total: Object.values(log).reduce((a, b) => a + b, 0),
    activeDays: Object.values(log).filter((v) => v > 0).length,
    streak,
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
function earnedBadgeIds(log: Record<string, number>): string[] {
  const s = badgeStats(log, computeStreak(log));
  return BADGE_DEFS.filter((b) => b.met(s)).map((b) => b.id);
}
// A Duolingo-style progress card: daily streak 🔥, total XP ⭐, this week's
// activity, and a daily-goal ring. `log` maps YYYY-MM-DD → XP earned that day.
function ProgressCard({ log }: { log: Record<string, number> }) {
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
  const stats = badgeStats(log, streak);
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
        📈 Progress over time · +{gained30} XP in 30 days
      </div>
      <svg
        viewBox={`0 0 ${GW} ${GH}`}
        preserveAspectRatio="none"
        style={styles.progGraph}
        aria-hidden
      >
        <path d={gArea} fill="var(--accent-soft)" />
        <path
          d={gLine}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={2}
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
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
}: {
  plan: FourYearPlan;
  onSetRequirement: (i: number, required: number) => void;
  onAddRequirement: (subject: string, required: number) => void;
  onRemoveRequirement: (i: number) => void;
  onSetTotalRequired: (n: number | undefined) => void;
}) {
  const [editing, setEditing] = useState(false);
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
  } = fypCredits(plan);
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
  const field = (
    label: string,
    value: string,
    set: (s: string) => void,
    placeholder: string,
    type = "text",
  ) => (
    <label style={styles.classSurveyLabel}>
      {label}
      <input
        type={type}
        style={styles.assignInput}
        value={value}
        placeholder={placeholder}
        onChange={(e) => set(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && canBuild && type !== "date") build();
        }}
      />
    </label>
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
      {field(
        "2. What are you working on or stuck on?",
        working,
        setWorking,
        "e.g. cellular respiration, word problems",
      )}
      {field(
        "3. What do you want to accomplish?",
        goal,
        setGoal,
        "e.g. be ready for the Unit 4 test",
      )}
      {field("4. By when? (optional)", deadline, setDeadline, "", "date")}
      {field(
        "5. How do you like to learn?",
        learningStyle,
        setStyle,
        "e.g. videos, practice problems, flashcards",
      )}
      {field(
        "6. How much time can you give it?",
        time,
        setTime,
        "e.g. 30 min a day, a few evenings",
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
        {plan.map((m, i) => (
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
            {m.added && onRemove && (
              <button
                style={styles.folderRemove}
                onClick={() => onRemove(i)}
                aria-label={`Remove step ${m.title}`}
              >
                ×
              </button>
            )}
          </div>
        ))}
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
      {assignments.some((a) => a.planDate && !a.done) && (
        <div style={styles.calLegend}>
          <span style={styles.calLegendItem}>
            <span style={{ ...styles.calDot, background: "#2f6f4f" }} /> due
          </span>
          <span style={styles.calLegendItem}>
            <span style={{ ...styles.calDot, background: "#d98a2b" }} /> work on
          </span>
        </div>
      )}
    </div>
  );
}

function CalendarPanel({
  events,
  assignments = [],
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
    { work: Assignment[]; events: StudyEvent[]; min: number }
  > = {};
  const bucket = (iso: string) =>
    (schedule[iso] ||= { work: [], events: [], min: 0 });
  for (const a of assignments)
    if (!a.done && a.planDate && a.planDate >= todayISO && a.planDate <= horizonISO) {
      const b = bucket(a.planDate);
      b.work.push(a);
      b.min += a.estMin ?? 0;
    }
  for (const e of events)
    if (e.date >= todayISO && e.date <= horizonISO) bucket(e.date).events.push(e);
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
    <div style={styles.tabPanel}>
        <div style={styles.modalHead}>
          <h2 style={styles.modalTitle}>Summarize notes</h2>
          {onClose && (
            <button style={styles.linkBtn} onClick={onClose}>
              Close
            </button>
          )}
        </div>

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
              <div style={styles.resultText}>{result}</div>
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
          </div>
        )}
    </div>
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
        <span style={styles.flashcardLabel}>{flipped ? "Answer" : "Term"}</span>
        <span style={styles.flashcardText}>{flipped ? card.back : card.front}</span>
        <span style={styles.flashcardHint}>tap to flip</span>
      </button>
      <div style={styles.flashNav}>
        <button style={styles.secondaryBtn} disabled={i === 0} onClick={() => go(-1)}>
          ← Prev
        </button>
        <button
          style={styles.linkBtn}
          onClick={() => onMissed(card.front)}
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
    </div>
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
}: {
  subjects: string[];
  profile: LearnerProfile | null;
  initialPrompt?: string;
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
                <div key={i} style={styles.afbLi}>
                  • <b>{it.point}</b>
                  {it.how ? ` — ${it.how}` : ""}
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

function Login() {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError("");
    if (!email.trim() || !password) {
      setError("Enter your email and password.");
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
    <main style={styles.loginPage}>
      <div style={styles.loginCard}>
        <h1 style={styles.title}>Eliora 🌱</h1>
        <p style={styles.loginIntro}>
          Your focus &amp; study coach.{" "}
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
    </main>
  );
}

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
  const SUBJECTS_KEY = `eliora-subjects::${ns}`;
  const ASSIGNMENTS_KEY = `eliora-assignments::${ns}`;
  const GOALS_KEY = `eliora-goals::${ns}`;
  const FOUR_YEAR_KEY = `eliora-four-year-plan::${ns}`;
  const REFLECTIONS_KEY = `eliora-reflections::${ns}`;
  const REFLECTION_SUMMARY_KEY = `eliora-reflection-summary::${ns}`;
  const TIME_MGMT_KEY = `eliora-timemgmt::${ns}`;
  const PROGRESS_KEY = `eliora-progress::${ns}`;
  const ROOM_KEY = `eliora-room::${ns}`;
  const A11Y_KEY = `eliora-a11y::${ns}`;
  const CHAT_FOLDERS_KEY = `eliora-chat-folders::${ns}`;
  const DAILY_KEY = `eliora-daily::${ns}`; // today's auto-generated tasks
  const BADGES_KEY = `eliora-badges::${ns}`; // badge ids already rewarded
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
  const [xpToast, setXpToast] = useState<string | null>(null);
  const [equippedRoom, setEquippedRoom] = useState("meadow"); // reward background
  // Today's tasks: a fresh short list regenerated once per day (keyed on date).
  const [dailyTasks, setDailyTasks] = useState<DailyTasksState | null>(null);
  const [dailyLoading, setDailyLoading] = useState(false);
  // Badge ids the learner has already been rewarded for (so we grant the bonus
  // XP only once, and never retroactively for badges earned before this shipped).
  const [claimedBadges, setClaimedBadges] = useState<string[]>([]);
  const [badgeCelebration, setBadgeCelebration] = useState<BadgeDef | null>(null);
  const totalXp = Object.values(progress).reduce((a, b) => a + b, 0);
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
  const [summarizingReflections, setSummarizingReflections] = useState(false);
  const [creatingReflGoals, setCreatingReflGoals] = useState(false);
  const [editing, setEditing] = useState(false);
  const [tab, setTab] = useState<
    | "home"
    | "chat"
    | "summarize"
    | "calendar"
    | "plan"
    | "study"
  >("home");
  // Sub-sections within the Plan tab, so it's not one overwhelming scroll.
  // "overview" is the main landing page that summarizes everything.
  const [planSection, setPlanSection] = useState<
    "overview" | "progress" | "week" | "goals" | "tasks" | "steps" | "fyp"
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
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
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
  const [remindersOn, setRemindersOn] = useState(false);
  const [notifSupported, setNotifSupported] = useState(false);
  const [dismissed, setDismissed] = useState<string[]>([]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recognitionRef = useRef<any>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

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
    kind: "plan" | "calendar" | "chat";
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
    else if (n < 0 && n >= -4)
      reminders.push({
        id: `fu-${e.id}`,
        icon: "🔁",
        text: `How did ${e.title} go?`,
        kind: "chat",
        chatMsg: `My ${e.kind ?? "exam"} "${e.title}" just happened. Help me reflect on how it went and plan what to do next.`,
      });
    else if (n <= -5 && n >= -10)
      reminders.push({
        id: `fix-${e.id}`,
        icon: "🔁",
        text: `Correct mistakes from ${e.title}`,
        kind: "chat",
        chatMsg: `It's about a week since my ${e.kind ?? "test"} "${e.title}". Let's go over the questions I got wrong and fix those mistakes — re-teach me and quiz me on just those.`,
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
    else if (r.kind === "chat") {
      setTab("chat");
      if (r.chatMsg) send(r.chatMsg);
    } else setTab("plan");
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

      const rawDaily = localStorage.getItem(DAILY_KEY);
      const savedDaily = rawDaily ? JSON.parse(rawDaily) : null;
      if (
        savedDaily &&
        typeof savedDaily.date === "string" &&
        Array.isArray(savedDaily.tasks)
      )
        setDailyTasks(savedDaily as DailyTasksState);

      if (localStorage.getItem(TIME_MGMT_KEY) === "1") setTimeMgmt(true);

      const rawProg = localStorage.getItem(PROGRESS_KEY);
      const savedProg = rawProg ? JSON.parse(rawProg) : null;
      if (savedProg && typeof savedProg === "object") setProgress(savedProg);

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
            ? earnedBadgeIds(savedProg)
            : [];
        setClaimedBadges(already);
        localStorage.setItem(BADGES_KEY, JSON.stringify(already));
      }

      const savedRoom = localStorage.getItem(ROOM_KEY);
      if (savedRoom) setEquippedRoom(savedRoom);

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
  // Nudge numeric progress up or down (clamped to 0..target). Auto-completes
  // the goal when it reaches the target, and reopens it if backed off.
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
    const g = goals.find((x) => x.id === id);
    if (g && !g.done) award(80, "goal achieved!"); // achieving a goal is a big win
    setGoals((prev) =>
      prev.map((x) => (x.id === id ? { ...x, done: !x.done } : x)),
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

  // Generate a fresh set of tasks for today, grounded in the learner's plan,
  // goals, calendar, assignments, and weak spots.
  const generateDailyTasks = async () => {
    if (dailyLoading) return;
    setDailyLoading(true);
    try {
      const res = await fetch("/api/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "daily",
          plan: plan.filter((m) => !m.done).map((m) => m.title),
          goals: goals.length ? goals : undefined,
          events: events.length ? events : undefined,
          assignments: assignments
            .filter((a) => !a.done)
            .map((a) => ({ title: a.title, subject: a.subject, due: a.due })),
          missed: missed.length ? missed : undefined,
          profile: profile ?? undefined,
        }),
      });
      const data = (await res.json()) as { items?: SugItem[] };
      const items = Array.isArray(data.items) ? data.items : [];
      if (items.length) {
        setDailyTasks({
          date: localISO(),
          tasks: items
            .filter((it) => it.title)
            .map((it) => ({
              title: String(it.title).trim(),
              why: it.why || undefined,
              subject: it.subject || undefined,
              done: false,
            })),
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

  // Persist progress XP log.
  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
    } catch {
      /* ignore */
    }
  }, [progress, loaded]);

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
    const fresh = earnedBadgeIds(progress).filter(
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
  }, [progress, claimedBadges, loaded]);

  // Persist the equipped study-room reward.
  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(ROOM_KEY, equippedRoom);
    } catch {
      /* ignore */
    }
  }, [equippedRoom, loaded]);

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
      `I want to work on ${topic}. Can you help me get started — a quick, ` +
        `beginner-friendly intro and the first small step to take?`,
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
      "I just took a quiz and got some questions wrong. Make me a short, simple " +
        "study guide focused ONLY on these — re-teach each one in a fresh way, " +
        "then give me 2 quick practice questions:\n" +
        detail,
    );
  }

  async function send(override?: string, opts?: { hidden?: boolean }) {
    const text = (typeof override === "string" ? override : input).trim();
    if (!text || busy) return;

    const userMsg: Message = { role: "user", content: text };
    // The model always sees the user/kickoff message; for a silent auto-build
    // (opts.hidden) we don't render it as a user bubble — only the reply shows.
    const apiMessages: Message[] = [...messages, userMsg];
    const visible: Message[] = opts?.hidden ? [...messages] : apiMessages;
    setMessages([...visible, { role: "assistant", content: "" }]);
    if (typeof override !== "string") setInput("");
    setBusy(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Send role+text history plus the profile and current plan for context.
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
          fourYearPlan: fourYearPlan ?? undefined,
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
        if (evt.type === "fourYearPlan") {
          const item = (evt as { item?: unknown }).item;
          if (item) setFourYearPlan(normalizeFourYearPlan(item));
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
          content: "Sorry, I couldn't reach the server. Please try again.",
        };
        return copy;
      });
    } finally {
      setBusy(false);
    }
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
              ["summarize", "📝 Notes"],
              ["calendar", "📅 Calendar"],
              ["plan", "🎯 Plan"],
              ["study", "📋 Study"],
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
          <button
            style={styles.sideNavItem}
            onClick={() => {
              setShowA11y(true);
              setSidebarOpen(false);
            }}
          >
            ⚙️ Settings
          </button>
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
            aria-label="Accessibility settings"
            title="Accessibility"
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
            <DailyTasksCard
              state={dailyTasks}
              loading={dailyLoading}
              onGenerate={generateDailyTasks}
              onToggle={toggleDailyTask}
            />
            <TopicStarter
              profile={profile}
              subjects={subjects}
              missed={missed}
              busy={busy || !!pendingKickoff}
              onStart={startTopicChat}
            />
            <ProgressCard log={progress} />
            <RewardsCard
              totalXp={totalXp}
              equipped={equippedRoom}
              onEquip={setEquippedRoom}
            />
            <div className="eliora-home-actions" style={styles.homeActions}>
              {(
                [
                  ["💬", "New chat", "Talk through anything", () => newChat()],
                  ["📝", "Summarize notes", "Notes → study set", () => setTab("summarize")],
                  ["🎯", "My plan", "See your next step", () => setTab("plan")],
                  ["🗺️", "4-year plan", "Map your path", () => setTab("plan")],
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

      {tab === "summarize" && (
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

      {tab === "calendar" && (
        <div style={styles.studyScroll}>
          <CalendarPanel
            events={events}
            assignments={assignments}
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
                ["progress", "📊 Progress"],
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
              <ProgressCard log={progress} />
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

          {planSection === "progress" && (
            <>
              <DailyRecap
                log={progress}
                assignments={assignments}
                events={events}
              />
              <WeeklyRecap
                log={progress}
                plan={plan}
                goals={goals}
                assignments={assignments}
                fourYearPlan={fourYearPlan}
              />
              <ProgressCard log={progress} />
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
                const pct = totalItems
                  ? Math.round((done / totalItems) * 100)
                  : 0;
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
                                    style={{
                                      ...styles.areaFill,
                                      width: `${p}%`,
                                    }}
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
            </>
          )}

          {planSection === "week" && (
            <>
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
                  <PlanPanel
                    plan={plan}
                    onToggle={togglePlan}
                    onAdd={addMilestone}
                    onRemove={removeMilestone}
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
          <AssignmentFeedback
            subjects={subjects}
            profile={profile}
            initialPrompt={feedbackSeed}
          />
        </div>
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
                : busy
                  ? "…"
                  : ""}
            </div>
            {m.role === "assistant" && a11y.readAloud && m.content && (
              <button
                style={styles.speakBtn}
                onClick={() => speak(m.content)}
                aria-label="Read this message aloud"
              >
                🔊 Read aloud
              </button>
            )}
            {m.videos && m.videos.length > 0 && <VideoCards videos={m.videos} />}
            {m.flashcards && m.flashcards.length > 0 && (
              <FlashcardDeck cards={m.flashcards} onMissed={addMissed} />
            )}
            {m.quiz && m.quiz.length > 0 && (
              <QuizView
                quiz={m.quiz}
                onMissed={addMissed}
                onStudyGuide={studyGuideFromQuiz}
              />
            )}
          </div>
        ))}
      </div>

      <div style={styles.composer}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
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
        <button onClick={() => send()} disabled={busy} style={styles.sendBtn}>
          {busy ? "…" : "Send"}
        </button>
      </div>
        </>
      )}
      </main>
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
  progGraph: {
    width: "100%",
    height: 70,
    display: "block",
    borderRadius: 8,
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
  assignRemove: {
    flexShrink: 0,
    background: "transparent",
    border: "none",
    color: "var(--muted)",
    fontSize: 20,
    lineHeight: 1,
    cursor: "pointer",
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
    padding: "7px 0",
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: "var(--border)",
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
  goalGroup: { marginTop: 4 },
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
    fontSize: 11.5,
    fontWeight: 800,
    color: "var(--accent)",
    textTransform: "uppercase",
    letterSpacing: 0.4,
    marginTop: 8,
    marginBottom: 1,
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
    fontSize: 13,
    fontWeight: 800,
    letterSpacing: 0.3,
    color: "#fff",
    background: "var(--accent)",
    padding: "4px 10px",
    borderRadius: 999,
    marginTop: 2,
    marginBottom: 4,
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
    paddingBottom: 6,
    margin: "0 -2px",
  },
  fypGrid: {
    display: "flex",
    alignItems: "flex-start",
    border: "1px solid var(--border)",
    borderRadius: 12,
    overflow: "hidden",
    minWidth: "min-content",
  },
  fypGridCol: {
    flex: "1 0 260px",
    minWidth: 260,
    borderLeft: "1px solid var(--border)",
  },
  fypGridHead: {
    background: "var(--accent-soft)",
    padding: "13px 16px",
    borderBottom: "1px solid var(--border)",
  },
  fypGridYear: {
    fontSize: 18,
    fontWeight: 700,
    color: "var(--assistant-text)",
  },
  fypGridSub: {
    fontSize: 13,
    color: "var(--muted)",
    marginTop: 3,
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
    fontSize: 12,
    fontWeight: 700,
    color: "var(--muted)",
    textTransform: "uppercase",
    letterSpacing: 0.4,
    padding: "9px 16px 4px",
    background: "var(--assistant-bubble)",
  },
  fypGridCell: {
    padding: "12px 16px",
    borderTop: "1px solid var(--border)",
  },
  fypGridCheck: {
    display: "flex",
    alignItems: "flex-start",
    gap: 9,
    width: "100%",
    background: "none",
    border: "none",
    padding: 0,
    textAlign: "left",
    cursor: "pointer",
    fontSize: 16,
    lineHeight: 1.35,
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
