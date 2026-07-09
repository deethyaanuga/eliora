# Eliora 🌱

A **focus & study coach chatbot built for ADD/ADHD** (and others who find it hard
to start, focus, or follow through). Eliora makes starting easy, breaks work into
tiny next steps, keeps the learner focused with a built-in timer, and tracks
progress — all in a warm, low-pressure, plain-spoken voice.

Powered by OpenAI (`gpt-4o` — set in `packages/shared/src/index.ts`).

## ADHD-first design

- **Make starting easy** — Eliora shrinks the first step until it feels too easy.
- **One tiny step at a time** — no overwhelming to-do walls.
- **Focus garden** — a Forest-style game: a flower grows while you focus, finishing
  a sprint earns coins and plants the flower, and coins unlock new locations
  (Garden, Café, Beach, Forest, Library). Pomodoro sprints (15/25 min) + breaks.
- **Externalize everything** — plan, checkpoints, and calendar so nothing has to
  be held in the head.
- **No shame** — distraction and missed sessions are normal; Eliora just shrinks
  the next step and restarts.
- Read-aloud, dyslexia-friendly font, high contrast, and reduced motion for
  comfort and co-occurring differences.

## Structure

```
eliora/
├─ packages/shared/        # System prompt + shared types (server-side only)
├─ apps/web/               # Next.js web app + /api/chat (Claude-powered)
└─ apps/mobile/            # Expo (React Native) app — talks to the same API
```

The Eliora **system prompt** lives in `packages/shared/src/index.ts` and is used
only by the web API route. Both clients (web + mobile) just POST the message
history to `/api/chat`; they never see the prompt.

## Prerequisites

- Node.js 18+
- An OpenAI API key → https://platform.openai.com/api-keys
- For mobile: the [Expo Go](https://expo.dev/go) app, or an iOS/Android simulator

## 1. Install

```bash
npm install
```

## 2. Add your API key(s)

```bash
cp apps/web/.env.local.example apps/web/.env.local
# then edit apps/web/.env.local and set OPENAI_API_KEY=sk-...
```

**Optional — real study videos.** Set `YOUTUBE_API_KEY` to let Eliora recommend
actual YouTube videos (via a server-side tool that calls the YouTube Data API v3).
Get a key from the Google Cloud Console (enable "YouTube Data API v3", create an
API key). Without it, Eliora falls back to YouTube search links, which always work.

## 3. Run the web app (also serves the API)

```bash
npm run web
```

Open http://localhost:3000 and start chatting with Eliora.

## 4. Run the mobile app

The mobile app calls the web app's `/api/chat`, so keep the web app running.

```bash
npm run mobile
```

- **Simulator:** `http://localhost:3000` works out of the box.
- **Physical device (Expo Go):** edit `apps/mobile/app.json` →
  `expo.extra.apiBaseUrl` to your computer's LAN IP, e.g. `http://192.168.1.20:3000`.

The mobile app streams replies token-by-token (via `expo/fetch`) and shows
recommended study videos as tappable thumbnail cards, just like the web app.

## Customizing Eliora

- **Personality / behavior:** edit `ELIORA_SYSTEM_PROMPT` in
  `packages/shared/src/index.ts`.
- **Model:** edit `ELIORA_MODEL` in the same file.
- **Response length:** `max_tokens` in `apps/web/app/api/chat/route.ts`.

## Accessibility

Eliora is built to be friendly for many kinds of learning differences. The ♿
**Accessibility** panel (web) toggles, app-wide and saved on the device:

- Dyslexia-friendly font + extra letter spacing
- Larger text
- Extra line / word spacing
- High contrast
- Reduced motion
- **Read aloud** — a 🔊 button on Eliora's messages (text-to-speech)

On mobile, every Eliora message has a 🔊 **Read aloud** button (`expo-speech`), and
the app honors the device's system text-size, bold-text, and contrast settings.
Eliora's system prompt also instructs it to adapt to dyslexia, ADHD, dyscalculia,
memory/processing differences, and anxiety — plain words, tiny steps, and
interest-based examples.

## Sign-up survey

New users complete a short **sign-up form** (the survey): name, class, what they
struggle with, how they like to learn, interests, and what's worked before. Only
the class is required. This profile is saved on the device and sent with every
chat request, so Eliora skips the in-chat onboarding and goes straight to building
a plan. **Edit info** reopens the form; **New chat** clears the conversation but
keeps the profile.

## Profile card & learning plan

The chat shows a **profile card** (class, name, and expandable details) with an
Edit button. When Eliora builds a plan it calls a `save_plan` tool; the app
renders it as a **checklist with a progress bar**. Tap a milestone to mark it
done — progress is saved on the device, and the current plan (with what's checked
off) is sent back to Eliora so it can track progress and suggest the next step.

The plan includes **checkpoints** (marked 🚩) — review/quiz steps placed between
learning milestones. When the learner reaches one, Eliora asks a few quick
questions to check understanding and gives feedback before moving on.

## Study tools (flashcards, quizzes, revision, study guides)

Quick-action chips above the message box: **🃏 Flashcards**, **📝 Quiz me**,
**📚 Study guide**, **💡 Suggestions**.

- **Flashcards** — Eliora calls `make_flashcards`; the app shows flip cards. Tap
  "Still learning" to mark a card for revision.
- **Quizzes** — Eliora calls `make_quiz` (multiple choice). The app grades it,
  shows explanations, and records the topics you got wrong.
- **Revision** — missed topics are saved (`eliora-missed`) and sent with every
  request, so Eliora re-teaches and re-quizzes your weak spots first.
- **Study guides** — short, scannable guides written in your learning style and
  tied to your interests, focused on what you need to review.
- **Suggestions** — concrete next steps, ADHD-friendly (one thing at a time).

## Summarize (notes / video / docs)

A **Summarize** button opens a tool that turns study material into simple notes
(overview → key points → self-check questions), tailored to the learner:

- **Notes / text** — paste anything.
- **Video** — paste a YouTube link; the server fetches the transcript and
  summarizes it (falls back to asking for the transcript if captions are missing).
- **Doc** — upload a PDF or image (sent to Claude) or a text/markdown file.

Powered by a separate `/api/summarize` endpoint. Summaries can be added straight
into the chat so Eliora can build on them.

## Calendar

A **calendar** panel tracks important dates (exams, finals, quizzes, assignments)
with a countdown for each. Add dates manually, or just tell Eliora ("my final is
June 3") — it saves them via an `add_event` tool. Upcoming dates are sent with
each request so Eliora plans backward from them, scheduling review and checkpoints
before each exam.

## Persistence

The profile, plan, and conversation are saved on the device so Eliora remembers
the learner between visits — `localStorage` on web, `AsyncStorage` on mobile.

## Next steps (not yet built)

- Move history/profile to a database so it syncs across devices.
- Structured plan/milestone tracking with progress bars.
- Accounts / auth.
- Dyslexia-friendly font toggle and high-contrast mode in the UI.
