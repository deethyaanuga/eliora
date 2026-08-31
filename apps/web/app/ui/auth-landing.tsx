"use client";

// The signed-out landing page.
//
//   Left  — the form. Fixed to the viewport and completely static: it never
//           moves, never reflows, and nothing on the right side can disturb it.
//           A Log in / Sign up toggle swaps which fields it shows — the product
//           demo lives entirely in the showcase panel, not in the form.
//   Right — a product demo that plays as you scroll. The panel is `sticky`
//           inside a tall track, so the page scrolls but the mockup stays put
//           and only its contents swap between slides. Hovering the panel
//           auto-cycles the slides for people who never scroll.
//
// The slides are the real feature mockups from app/ui/landing-demos.tsx — inert
// markup, no real data, no API calls. Only the form talks to the server
// (/api/signup, then a credentials sign-in).

import { useCallback, useEffect, useRef, useState } from "react";
import { signIn } from "next-auth/react";
import { DISPLAY_FONT, ElioraMark, ElioraWordmark } from "@/app/ui/brand";
import { DEMO_SLIDES, demoStyles } from "@/app/ui/landing-demos";

export type AuthMode = "login" | "signup";

// How long a slide holds before the hover autoplay advances.
const HOVER_MS = 2800;

// How much scroll each slide owns. A full viewport each would make nine
// features a ~8000px page, so they get a much shorter slice — the whole page
// is then under four screens, and a slide still holds for a beat before the
// next one takes over.
const SLIDE_VH = 40;

export default function AuthLanding({
  initialMode = "login",
  showBack = false,
}: {
  initialMode?: AuthMode;
  showBack?: boolean;
}) {
  const slides = DEMO_SLIDES;
  const trackRef = useRef<HTMLDivElement | null>(null);

  // Two independent drivers for the same panel: the scroll position, and the
  // hover autoplay. Hover wins while the pointer is inside the panel; on leave
  // we fall straight back to whatever the scroll position says.
  const [scrollIndex, setScrollIndex] = useState(0);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const active = hoverIndex ?? scrollIndex;

  // globals.css pins html/body to height:100% because the app shell is a
  // fixed-height flex layout that scrolls its own panes. The landing is the one
  // page that scrolls the document itself — without releasing that, the track
  // overflows a viewport-height root and the sticky panel never advances.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("su-scrollable");
    return () => root.classList.remove("su-scrollable");
  }, []);

  // --- scroll driver -------------------------------------------------------
  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;

    let frame = 0;
    const read = () => {
      frame = 0;
      const rect = track.getBoundingClientRect();
      // Distance the sticky panel can travel before the track scrolls past.
      const travel = rect.height - window.innerHeight;
      const p = travel > 0 ? Math.min(1, Math.max(0, -rect.top / travel)) : 0;
      // Even slices, so each slide owns the same stretch of the scroll.
      const idx = Math.min(slides.length - 1, Math.floor(p * slides.length));
      setScrollIndex((prev) => (prev === idx ? prev : idx));
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(read);
    };

    // Hidden tabs don't run rAF, so a scroll there would leave `frame` set and
    // every later scroll coalesced into a callback that never comes. Drop the
    // pending frame and re-read whenever the tab comes back.
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
      read();
    };

    read();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [slides.length]);

  // --- hover autoplay ------------------------------------------------------
  // Starts from whatever is on screen so the first hover step is never a jump
  // backwards. Respects prefers-reduced-motion by simply not cycling.
  const enter = useCallback(() => {
    if (
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    )
      return;
    setHoverIndex((h) => h ?? scrollIndex);
  }, [scrollIndex]);

  useEffect(() => {
    if (hoverIndex === null) return;
    const id = window.setInterval(
      () => setHoverIndex((h) => ((h ?? 0) + 1) % slides.length),
      HOVER_MS,
    );
    return () => window.clearInterval(id);
    // Only re-arm when hover starts/stops, not on every tick — the interval
    // advances itself via the functional update above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hoverIndex === null, slides.length]);

  // Dots jump the page to the middle of that slide's slice of the track, so the
  // scroll driver above reads back the same index we just asked for.
  function goTo(i: number) {
    setHoverIndex(null);
    const track = trackRef.current;
    if (!track) return;
    const travel = track.offsetHeight - window.innerHeight;
    if (travel <= 0) return; // stacked layout — nothing to scroll through
    const top = window.scrollY + track.getBoundingClientRect().top;
    window.scrollTo({
      top: top + ((i + 0.5) / slides.length) * travel,
      behavior: "smooth",
    });
  }

  return (
    <main className="su-root">
      <style>{CSS}</style>

      {/* ---------------- left: the form. fixed, static, never animates ------ */}
      <aside className="su-left">
        <AuthForm initialMode={initialMode} showBack={showBack} />
      </aside>

      {/* ---------------- right: the scroll-driven demo panel ---------------- */}
      <div className="su-right">
        <div
          className="su-track"
          ref={trackRef}
          // The track grows with the list, so adding a feature adds scroll.
          style={{ height: `${slides.length * SLIDE_VH}vh` }}
        >
          <div
            className="su-stage"
            onMouseEnter={enter}
            onMouseLeave={() => setHoverIndex(null)}
          >
            <div className="su-stageInner">
              <div className="su-frame">
                <div className="su-chrome">
                  <span className="su-dotR" />
                  <span className="su-dotY" />
                  <span className="su-dotG" />
                  <div className="su-urlbar">eliora.app</div>
                </div>

                <div className="su-screen">
                  {slides.map((s, i) => (
                    <div
                      key={s.title}
                      className={`su-slide${i === active ? " is-active" : ""}`}
                      aria-hidden={i !== active}
                    >
                      {/* Stacked layout only: down there every slide is on
                          screen at once, so the shared caption block below
                          can't say which mockup it belongs to — each slide
                          carries its own instead. Hidden on desktop. */}
                      <div className="su-capInline">
                        <span className="su-eyebrow">
                          <span aria-hidden>{s.emoji}</span> {s.title}
                        </span>
                        <h2 className="su-headline">{s.caption}</h2>
                      </div>
                      {/* Same body chrome the demos were drawn for. */}
                      <div className="su-body" style={demoStyles.cardBody}>
                        {s.render()}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="su-caption" aria-live="polite">
                {slides.map((s, i) => (
                  <div
                    key={s.title}
                    className={`su-cap${i === active ? " is-active" : ""}`}
                    aria-hidden={i !== active}
                  >
                    <span className="su-eyebrow">
                      <span aria-hidden>{s.emoji}</span> {s.title}
                    </span>
                    <h2 className="su-headline">{s.caption}</h2>
                  </div>
                ))}
              </div>

              <div className="su-dots" role="tablist" aria-label="Feature slides">
                {slides.map((s, i) => (
                  <button
                    key={s.title}
                    role="tab"
                    aria-selected={i === active}
                    aria-label={s.title}
                    className={`su-dot${i === active ? " is-active" : ""}`}
                    onClick={() => goTo(i)}
                  >
                    <span className="su-dotFill" />
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}

/* ============================ the form ==================================== */

function AuthForm({
  initialMode,
  showBack,
}: {
  initialMode: AuthMode;
  showBack?: boolean;
}) {
  const [mode, setMode] = useState<AuthMode>(initialMode);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const signup = mode === "signup";

  // Switching tabs drops the signup-only field and any stale error, so neither
  // view inherits the other's state.
  function switchMode(m: AuthMode) {
    setMode(m);
    setName("");
    setError("");
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!email.trim() || !password) {
      setError("Enter your email and password.");
      return;
    }
    if (signup && password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }
    setBusy(true);
    try {
      if (signup) {
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
          signup
            ? "Account created, but sign-in failed — try logging in."
            : "Wrong email or password.",
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

  // Password strength is advisory only — the server is the one that enforces
  // the 6-character floor, and it only applies while signing up.
  const strength = scorePassword(password);

  // Direct visits to /signup have no in-app history to return to, so fall
  // back to the landing page instead of leaving the site.
  function goBack() {
    if (window.history.length > 1) window.history.back();
    else window.location.href = "/";
  }

  return (
    <form className="su-form" onSubmit={submit} noValidate>
      {showBack && (
        <button type="button" className="su-back" onClick={goBack}>
          <span aria-hidden>←</span> Back
        </button>
      )}
      <span className="su-lockup">
        <ElioraMark size={30} />
        <ElioraWordmark size={26} />
      </span>

      <div className="su-tabs" role="tablist">
        {(["login", "signup"] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            className={`su-tab${mode === m ? " is-active" : ""}`}
            onClick={() => switchMode(m)}
          >
            {m === "login" ? "Log in" : "Sign up"}
          </button>
        ))}
      </div>

      <div className="su-formHead">
        <h1 className="su-title">
          {signup ? "Create your account" : "Welcome back"}
        </h1>
        <p className="su-lede">
          {signup
            ? "Free to start. Your plan, chats and progress save automatically."
            : "Log in to pick up where you left off."}
        </p>
      </div>

      <div className="su-social">
        <button
          type="button"
          className="su-oauth"
          onClick={() => signIn("google", { callbackUrl: "/" })}
        >
          <GoogleGlyph />
          Continue with Google
        </button>
      </div>

      <div className="su-or">
        <span>
          {signup ? "or sign up with email" : "or log in with email"}
        </span>
      </div>

      {signup && (
        <label className="su-field">
          <span className="su-label">Name</span>
          <input
            className="su-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Optional"
            autoComplete="name"
          />
        </label>
      )}

      <label className="su-field">
        <span className="su-label">Email</span>
        <input
          className="su-input"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@school.edu"
          autoComplete="email"
          required
        />
      </label>

      <label className="su-field">
        <span className="su-label">Password</span>
        <div className="su-inputWrap">
          <input
            className="su-input"
            type={show ? "text" : "password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={signup ? "At least 6 characters" : "Your password"}
            autoComplete={signup ? "new-password" : "current-password"}
            required
          />
          <button
            type="button"
            className="su-peek"
            onClick={() => setShow((s) => !s)}
            aria-label={show ? "Hide password" : "Show password"}
          >
            {show ? "Hide" : "Show"}
          </button>
        </div>
        {signup && (
          <span className="su-meter" aria-hidden>
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className={`su-meterBar${strength > i ? " is-on" : ""}`}
                data-level={strength}
              />
            ))}
          </span>
        )}
      </label>

      {error && (
        <p className="su-error" role="alert">
          {error}
        </p>
      )}

      <button className="su-submit" disabled={busy} type="submit">
        {busy
          ? signup
            ? "Creating your account…"
            : "Logging you in…"
          : signup
            ? "Create account"
            : "Log in"}
      </button>

      {signup && (
        <p className="su-fine">
          By continuing you agree to Eliora&apos;s Terms and Privacy Policy.
        </p>
      )}
      <p className="su-alt">
        {signup ? "Already have an account? " : "New to Eliora? "}
        <button
          type="button"
          className="su-altLink"
          onClick={() => switchMode(signup ? "login" : "signup")}
        >
          {signup ? "Log in" : "Create an account"}
        </button>
      </p>
    </form>
  );
}

function scorePassword(pw: string) {
  if (!pw) return 0;
  let s = 0;
  if (pw.length >= 6) s++;
  if (pw.length >= 10 && /[^a-zA-Z]/.test(pw)) s++;
  if (pw.length >= 14 || (/[A-Z]/.test(pw) && /\d/.test(pw) && /[^\w]/.test(pw)))
    s++;
  return s;
}

function GoogleGlyph() {
  return (
    <svg width="17" height="17" viewBox="0 0 48 48" aria-hidden focusable="false">
      <path
        fill="#4285F4"
        d="M45.1 24.5c0-1.6-.1-3.2-.4-4.7H24v8.9h11.8c-.5 2.7-2 5.1-4.4 6.6v5.5h7.1c4.2-3.8 6.6-9.5 6.6-16.3z"
      />
      <path
        fill="#34A853"
        d="M24 46c6 0 11-2 14.5-5.2l-7.1-5.5c-2 1.3-4.5 2.1-7.4 2.1-5.7 0-10.6-3.9-12.3-9.1H4.3v5.7C7.8 41.1 15.3 46 24 46z"
      />
      <path
        fill="#FBBC05"
        d="M11.7 28.3c-.4-1.3-.7-2.7-.7-4.3s.3-3 .7-4.3v-5.7H4.3A22 22 0 0 0 2 24c0 3.6.9 6.9 2.3 9.9l7.4-5.6z"
      />
      <path
        fill="#EA4335"
        d="M24 10.6c3.2 0 6.1 1.1 8.4 3.3l6.3-6.3C34.9 4 30 2 24 2 15.3 2 7.8 6.9 4.3 14l7.4 5.7c1.7-5.2 6.6-9.1 12.3-9.1z"
      />
    </svg>
  );
}

/* ============================ styles ====================================== */
// Scoped by the `su-` prefix and shipped with the component so nothing here
// leaks into the app shell's global sheet. The slide mockups bring their own
// inline styles from app/ui/landing-demos.tsx.

const CSS = `
/* Set on <html> while the landing is mounted — see the effect in AuthLanding. */
html.su-scrollable, html.su-scrollable body { height: auto; }

.su-root { min-height: 100vh; background: var(--bg); color: var(--text); }

/* ---- left: fixed and static ---- */
.su-left {
  position: fixed; top: 0; left: 0; bottom: 0; width: 46%;
  display: flex; align-items: center; justify-content: center;
  padding: 32px 40px; box-sizing: border-box;
  background: var(--surface);
  border-right: 1px solid var(--border);
  overflow-y: auto;
  z-index: 2;
}
.su-form { width: 100%; max-width: 360px; display: flex; flex-direction: column; gap: 14px; }
.su-back {
  align-self: flex-start; display: inline-flex; align-items: center; gap: 6px;
  margin-bottom: 2px; padding: 6px 10px 6px 6px; border: 0; border-radius: 9px;
  background: none; color: var(--muted);
  font: inherit; font-size: 13.5px; font-weight: 600; cursor: pointer;
  transition: color .15s ease, background .15s ease;
}
.su-back:hover { color: var(--accent); background: var(--accent-soft); }
.su-lockup { display: inline-flex; align-items: center; gap: 8px; margin-bottom: 2px; }
.su-formHead { display: flex; flex-direction: column; gap: 6px; }
.su-title { font-family: ${DISPLAY_FONT}; font-size: 30px; font-weight: 700; letter-spacing: -0.02em; margin: 0; }
.su-lede { margin: 0; color: var(--muted); font-size: 14px; line-height: 1.5; }

/* ---- log in / sign up toggle ---- */
.su-tabs {
  display: flex; gap: 4px; padding: 4px;
  background: var(--elevated); border: 1px solid var(--border); border-radius: 12px;
}
.su-tab {
  flex: 1; padding: 8px 12px; border: 0; border-radius: 9px;
  background: transparent; color: var(--muted);
  font: inherit; font-size: 14px; font-weight: 600; cursor: pointer;
  transition: background .15s ease, color .15s ease;
}
.su-tab:hover { color: var(--text); }
.su-tab.is-active { background: var(--surface); color: var(--text); box-shadow: 0 1px 3px rgba(42,35,80,.12); }

.su-social { display: flex; flex-direction: column; gap: 8px; }
.su-oauth {
  display: flex; align-items: center; justify-content: center; gap: 10px;
  width: 100%; padding: 11px 16px; border-radius: 12px;
  border: 1px solid var(--border-strong); background: var(--surface);
  color: var(--text); font-size: 14.5px; font-weight: 600; cursor: pointer;
  transition: background .15s ease, border-color .15s ease, transform .12s ease;
}
.su-oauth:hover { background: var(--accent-soft); border-color: var(--accent); }
.su-oauth:active { transform: translateY(1px); }

.su-or { display: flex; align-items: center; gap: 12px; color: var(--muted); font-size: 12px; }
.su-or::before, .su-or::after { content: ""; flex: 1; height: 1px; background: var(--border); }

.su-field { display: flex; flex-direction: column; gap: 6px; }
.su-label { font-size: 12.5px; font-weight: 600; color: var(--muted); }
.su-inputWrap { position: relative; display: flex; }
.su-input {
  width: 100%; box-sizing: border-box; font: inherit; font-size: 14.5px;
  padding: 11px 14px; border-radius: 12px;
  border: 1px solid var(--border-strong); background: var(--bg); color: var(--text);
  outline: none; transition: border-color .15s ease, box-shadow .15s ease;
}
.su-input::placeholder { color: color-mix(in srgb, var(--muted) 65%, transparent); }
.su-input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent); }
.su-inputWrap .su-input { padding-right: 62px; }
.su-peek {
  position: absolute; right: 6px; top: 50%; transform: translateY(-50%);
  border: 0; background: transparent; color: var(--muted);
  font-size: 12.5px; font-weight: 600; cursor: pointer; padding: 6px 8px; border-radius: 8px;
}
.su-peek:hover { color: var(--accent); background: var(--accent-soft); }

.su-meter { display: flex; gap: 4px; margin-top: 2px; }
.su-meterBar { flex: 1; height: 3px; border-radius: 2px; background: var(--border); transition: background .2s ease; }
.su-meterBar.is-on { background: var(--warning); }
.su-meterBar.is-on[data-level="3"] { background: var(--success); }

.su-error { margin: 0; color: var(--destructive, #b3261e); font-size: 13px; }
.su-submit {
  width: 100%; padding: 12px 16px; border-radius: 12px; border: 0;
  background: var(--brand-gradient); color: #fff;
  font-size: 15px; font-weight: 700; cursor: pointer;
  transition: filter .15s ease, transform .12s ease;
}
.su-submit:hover:not(:disabled) { filter: brightness(1.06); }
.su-submit:active:not(:disabled) { transform: translateY(1px); }
.su-submit:disabled { opacity: .65; cursor: default; }

.su-fine { margin: 0; font-size: 11.5px; color: var(--muted); line-height: 1.5; }
.su-alt { margin: 0; font-size: 13.5px; color: var(--muted); }
.su-altLink {
  border: 0; background: none; padding: 0; font: inherit;
  color: var(--accent); font-weight: 600; cursor: pointer;
}
.su-altLink:hover { text-decoration: underline; }

/* ---- right: tall track, sticky stage ---- */
.su-right { margin-left: 46%; }
.su-track { position: relative; }
.su-stage {
  position: sticky; top: 0; height: 100vh;
  display: flex; align-items: center; justify-content: center;
  padding: 40px; box-sizing: border-box;
  background:
    radial-gradient(90% 60% at 50% 0%, color-mix(in srgb, var(--accent) 12%, transparent), transparent 70%),
    var(--bg);
  overflow: hidden;
}
.su-stageInner { width: 100%; max-width: 620px; display: flex; flex-direction: column; gap: 22px; }

.su-frame {
  border: 1px solid var(--border); border-radius: 16px; overflow: hidden;
  background: var(--surface); box-shadow: 0 24px 60px -28px rgba(42,35,80,.45);
}
.su-chrome {
  display: flex; align-items: center; gap: 6px; padding: 9px 12px;
  border-bottom: 1px solid var(--border); background: var(--elevated);
}
.su-dotR, .su-dotY, .su-dotG { width: 9px; height: 9px; border-radius: 50%; }
.su-dotR { background: #ff5f57; } .su-dotY { background: #febc2e; } .su-dotG { background: #28c840; }
.su-urlbar {
  flex: 1; margin-left: 8px; text-align: center; font-size: 11px; color: var(--muted);
  background: var(--bg); border-radius: 6px; padding: 3px 8px;
}

/* The screen holds every slide stacked; only the active one is painted. */
.su-screen { position: relative; height: 340px; }
.su-slide {
  position: absolute; inset: 0; padding: 14px; box-sizing: border-box;
  opacity: 0; transform: translateY(14px) scale(.985);
  transition: opacity .45s ease, transform .45s cubic-bezier(.22,.85,.3,1);
  pointer-events: none;
  overflow: hidden;
}
.su-slide.is-active { opacity: 1; transform: none; pointer-events: auto; }
.su-body { height: 100%; }
/* Stacked-layout only — the sticky layout captions the active slide below the
   browser frame instead. See the media query at the bottom. */
.su-capInline { display: none; }

.su-caption { position: relative; min-height: 92px; }
.su-cap {
  position: absolute; inset: 0; display: flex; flex-direction: column; gap: 8px;
  opacity: 0; transform: translateY(10px);
  transition: opacity .4s ease .06s, transform .4s ease .06s;
}
.su-cap.is-active { opacity: 1; transform: none; }
.su-eyebrow {
  font-size: 11px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase;
  color: var(--accent);
}
.su-headline {
  margin: 0; font-family: ${DISPLAY_FONT}; font-size: 25px; font-weight: 700;
  letter-spacing: -.02em; line-height: 1.25; max-width: 30ch;
}

.su-dots { display: flex; gap: 6px; }
.su-dot {
  flex: 1; max-width: 44px; height: 4px; padding: 0; border: 0; border-radius: 3px;
  background: var(--border-strong); cursor: pointer; overflow: hidden;
}
.su-dotFill { display: block; height: 100%; width: 0; background: var(--accent); border-radius: 3px; }
.su-dot.is-active .su-dotFill { width: 100%; transition: width .35s ease; }

/* ---- stacked layout: the fixed/sticky mechanic doesn't apply below 900px ---- */
@media (max-width: 900px) {
  .su-left {
    position: static; width: auto; border-right: 0;
    border-bottom: 1px solid var(--border); padding: 32px 20px 40px;
  }
  .su-right { margin-left: 0; }
  .su-track { height: auto !important; }
  .su-stage { position: static; height: auto; padding: 28px 16px 40px; }
  .su-screen { height: auto; }
  .su-slide { position: relative !important; inset: auto !important; opacity: 1 !important; transform: none !important; pointer-events: auto !important; }
  .su-slide + .su-slide { border-top: 1px solid var(--border); }
  /* Stacked, every slide is on screen at once, so the fixed 320px stage the
     sticky layout needs would add ~180px of dead space under each mockup.
     Let them size to their content instead — nine cards, no padding out. */
  .su-screen > .su-slide { height: auto; }
  .su-body { height: auto; }
  /* Each mockup gets its own headline sitting right on top of it; the shared
     caption block underneath would just be nine orphaned headlines in a row. */
  .su-slide { padding: 20px 14px 22px; }
  .su-capInline { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
  .su-capInline .su-headline { font-size: 19px; max-width: 26ch; }
  .su-caption { display: none; }
  .su-dots { display: none; }
  .su-urlbar { display: none; }
}

@media (prefers-reduced-motion: reduce) {
  .su-slide, .su-cap { transition-duration: .01ms; }
}
`;
