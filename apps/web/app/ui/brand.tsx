// Eliora's brand marks, shared by the app shell and the standalone sign-up page.
// Kept out of page.tsx because a Next.js route file can't cleanly export helpers
// alongside its default component.

// The display face for the app's big headings — Fraunces, loaded in layout.tsx
// via next/font (which sets --font-display on <html>). The fallback keeps the
// headings readable if the variable is ever missing.
export const DISPLAY_FONT = 'var(--font-display, "Fraunces", Georgia, serif)';

// The Eliora mark: the logo's lightbulb over an open book. Drawn inline (rather
// than an <img>) so the ink and the glass pick up the live theme tokens — the
// gold stays gold, but everything structural follows dark mode and the alternate
// themes. `size` is the box in px; the art scales inside a 48-unit viewBox.
export function ElioraMark({ size = 28 }: { size?: number }) {
  // Gradient ids have to be unique per size or a second, smaller instance on the
  // page inherits the first one's coordinates.
  const uid = `eliora-mark-${size}`;
  return (
    <svg
      className="eliora-mark"
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={`${uid}-glass`} x1="0.5" y1="0" x2="0.5" y2="1">
          <stop offset="0" stopColor="#fff3cd" />
          <stop offset="1" stopColor="var(--bulb, #f7c14b)" />
        </linearGradient>
      </defs>
      {/* rays — the logo's burst above the bulb */}
      <g
        stroke="var(--bulb, #f7c14b)"
        strokeWidth="2"
        strokeLinecap="round"
        opacity="0.9"
      >
        <path d="M24 2v3.6" />
        <path d="M11.6 6.4l2 2.8" />
        <path d="M36.4 6.4l-2 2.8" />
        <path d="M4.2 17.2l3.4 1.1" />
        <path d="M43.8 17.2l-3.4 1.1" />
      </g>
      {/* bulb glass */}
      <path
        d="M24 7.4c5.3 0 9.4 4.1 9.4 9.2 0 3.6-1.9 5.6-3.3 7.2-1 1.1-1.6 1.9-1.6 3H19.5c0-1.1-.6-1.9-1.6-3-1.4-1.6-3.3-3.6-3.3-7.2 0-5.1 4.1-9.2 9.4-9.2z"
        fill={`url(#${uid}-glass)`}
      />
      {/* filament */}
      <path
        d="M21 16.4l3 3.6 3-3.6"
        stroke="var(--text)"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M24 20v3.8"
        stroke="var(--text)"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      {/* screw base */}
      <rect
        x="20.4"
        y="28"
        width="7.2"
        height="2.6"
        rx="1.3"
        fill="var(--accent)"
      />
      {/* open book — the pages take the wordmark's violet→pink pair */}
      <path
        d="M24 36.2c-2.9-2.5-6.7-3.4-11-3.4L5.4 40c5.3 0 12.8.7 18.6 4.1V36.2z"
        fill="var(--accent)"
        opacity="0.9"
      />
      <path
        d="M24 36.2c2.9-2.5 6.7-3.4 11-3.4L42.6 40c-5.3 0-12.8.7-18.6 4.1V36.2z"
        fill="var(--accent-2)"
        opacity="0.9"
      />
    </svg>
  );
}

// The wordmark on its own: "Eliora" in the display face, filled with the brand
// gradient (see .eliora-wordmark in globals.css).
export function ElioraWordmark({
  size = 27,
  style,
}: {
  // `"inherit"` lets the wordmark ride the surrounding heading's size, which is
  // what the responsive clamp()-based hero titles want.
  size?: number | string;
  style?: React.CSSProperties;
}) {
  return (
    <span
      className="eliora-wordmark"
      style={{
        fontFamily: DISPLAY_FONT,
        fontSize: size,
        fontWeight: 700,
        letterSpacing: "-0.02em",
        lineHeight: 1.15,
        ...style,
      }}
    >
      Eliora
    </span>
  );
}
