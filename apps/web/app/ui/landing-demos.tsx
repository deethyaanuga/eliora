"use client";

// Self-contained mock previews of each Eliora feature, shown to signed-out
// visitors so they can see what the app does before making an account. Nothing
// here is real: no props, no API calls, every value is hard-coded. The only
// interactive bit is DemoDailyTasks, which lets you tick its fake checkboxes.
//
// DEMO_SLIDES is the single list of features a visitor sees. The auth landing
// (app/ui/auth-landing.tsx) drives its scrolling panel straight off it, so
// adding a feature here adds it to the landing page.

import { useState } from "react";
import { DISPLAY_FONT } from "@/app/ui/brand";

export const demoStyles: Record<string, React.CSSProperties> = {
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
  heroTitle: {
    margin: 0,
    fontSize: 48,
    lineHeight: 1.1,
    fontFamily: DISPLAY_FONT,
    gap: 14,
  },
  // The logo's "A LIGHT OF LEARNING" line, sitting under the wordmark.
  heroKicker: {
    margin: "-8px 0 0",
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: "0.18em",
    textTransform: "uppercase",
    color: "var(--muted)",
  },
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
  // The scroll-snap strip plus its arrows; the strip itself is styled by
  // .eliora-slides in globals.css (snap points and hidden scrollbar).
  slideFrame: {
    position: "relative",
    marginTop: 8,
    // Room for the arrows, which sit just outside the strip on wide screens.
    padding: "0 4px",
  },
  slideArrow: {
    position: "absolute",
    top: "50%",
    transform: "translateY(-50%)",
    zIndex: 2,
    width: 40,
    height: 40,
    borderRadius: 999,
    border: "1px solid var(--border)",
    background: "var(--surface)",
    color: "var(--text)",
    fontSize: 22,
    lineHeight: 1,
    cursor: "pointer",
    boxShadow: "0 2px 10px rgba(0,0,0,0.12)",
  },
  slideArrowLeft: { left: -12 },
  slideArrowRight: { right: -12 },
  slideArrowOff: { opacity: 0, pointerEvents: "none" },
  dots: {
    display: "flex",
    justifyContent: "center",
    gap: 8,
    marginTop: 14,
  },
  dot: {
    width: 8,
    height: 8,
    padding: 0,
    borderRadius: 999,
    border: "none",
    background: "var(--border-strong)",
    cursor: "pointer",
    transition: "width 160ms ease, background 160ms ease",
  },
  dotOn: { width: 22, background: "var(--accent)" },
  card: {
    display: "flex",
    flexDirection: "column",
    gap: 12,
    padding: 18,
    borderRadius: 16,
    border: "1px solid var(--border)",
    background: "var(--surface)",
    width: "100%",
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
    color: "var(--primary-foreground)",
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

export function DemoCard({
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

export function DemoChat() {
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

export function DemoDailyTasks() {
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

export function DemoSchedule() {
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

export function DemoGoals() {
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

export function DemoCalendar() {
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

export function DemoFlashcards() {
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

export function DemoFourYear() {
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

export function DemoVideos() {
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

// One entry per slide in the landing strip — order is the order visitors see.
export const DEMO_SLIDES: {
  emoji: string;
  title: string;
  caption: string;
  render: () => React.ReactNode;
}[] = [
  {
    emoji: "💬",
    title: "AI study coach",
    caption: "Chat through what's stressing you and get a concrete plan back.",
    render: () => <DemoChat />,
  },
  {
    emoji: "✅",
    title: "Daily tasks",
    caption: "Three small wins a day, tuned to your plan and energy.",
    render: () => <DemoDailyTasks />,
  },
  {
    emoji: "🗓️",
    title: "Weekly schedule",
    caption: "Study blocks, breaks, and classes laid out hour by hour.",
    render: () => <DemoSchedule />,
  },
  {
    emoji: "🎯",
    title: "SMART goals",
    caption: "Big goals broken into steps you can actually check off.",
    render: () => <DemoGoals />,
  },
  {
    emoji: "⏳",
    title: "Exam countdowns",
    caption: "A calendar that keeps deadlines visible before they sneak up.",
    render: () => <DemoCalendar />,
  },
  {
    emoji: "📇",
    title: "Summaries, flashcards & quizzes",
    caption: "Paste notes or a YouTube link — get a summary you can study from.",
    render: () => <DemoFlashcards />,
  },
  {
    emoji: "🎓",
    title: "Four-year plan",
    caption: "Map courses to your dream school with a live GPA projection.",
    render: () => <DemoFourYear />,
  },
  {
    emoji: "📺",
    title: "Video study feed",
    caption: "Curated videos matched to the topics in your plan.",
    render: () => <DemoVideos />,
  },
];
