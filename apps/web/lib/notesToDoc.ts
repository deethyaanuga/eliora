// Convert an Eliora note into Google Docs API batchUpdate requests so the note
// arrives in Google Docs with real formatting — not a wall of plain text.
//
// The Notes workspace stores notes in a small markdown dialect (see
// renderNoteMarkdown / renderNoteInline in app/page.tsx):
//   Blocks:  # / ## / ###  headings, "- " / "* " bullets, "1. " numbered lists.
//   Inline:  **bold**, ==color:text== highlights, [[wiki links]].
// We translate each of those into the Docs equivalent: named heading styles,
// list bullets, bold runs, and background-color (highlighter) runs.
//
// Index math: a fresh doc starts with one empty paragraph, so body content is
// inserted at index 1. Every character — including each newline — advances the
// index by one. We insert all the text in one request, then layer styling on
// top; none of updateParagraphStyle / createParagraphBullets / updateTextStyle
// changes the document length, so all ranges computed from the inserted text
// stay valid regardless of order.

export type NoteDocInput = {
  title: string;
  template?: "free" | "cornell" | "canvas";
  body: string;
  cue?: string;
  summary?: string;
};

// Highlighter colors, matched to NOTE_HIGHLIGHTS in app/page.tsx.
const HIGHLIGHTS: Record<string, string> = {
  yellow: "#fdf0a6",
  green: "#c3e8cb",
  blue: "#c2dcf7",
  pink: "#f8c9dd",
  orange: "#ffd9ac",
};

type Run = { text: string; bold?: boolean; highlight?: string };
type NamedStyle =
  | "TITLE"
  | "HEADING_1"
  | "HEADING_2"
  | "HEADING_3"
  | "NORMAL_TEXT";
type Para = { runs: Run[]; style?: NamedStyle; bullet?: "bullet" | "number" };

// #fdf0a6 -> { red, green, blue } in the 0..1 range Docs expects.
function hexToRgb(hex: string): { red: number; green: number; blue: number } {
  const h = hex.replace("#", "");
  return {
    red: parseInt(h.slice(0, 2), 16) / 255,
    green: parseInt(h.slice(2, 4), 16) / 255,
    blue: parseInt(h.slice(4, 6), 16) / 255,
  };
}

// Split one line of body text into styled runs. Mirrors renderNoteInline's regex
// so the doc highlights exactly what the app preview highlights. Wiki [[links]]
// have no Docs equivalent, so we keep the title as bold text.
function parseRuns(text: string): Run[] {
  const runs: Run[] = [];
  text.split(/(\*\*[^*]+\*\*|==[^=]+==|\[\[[^\]]+\]\])/g).forEach((part) => {
    if (!part) return;
    let m: RegExpMatchArray | null;
    if ((m = part.match(/^\*\*([^*]+)\*\*$/))) {
      runs.push({ text: m[1], bold: true });
    } else if ((m = part.match(/^==([^=]+)==$/))) {
      const inner = m[1];
      const cm = inner.match(/^(yellow|green|blue|pink|orange):([\s\S]+)$/);
      const color = cm ? cm[1] : "yellow";
      const label = cm ? cm[2] : inner;
      runs.push({ text: label, highlight: HIGHLIGHTS[color] });
    } else if ((m = part.match(/^\[\[([^\]]+)\]\]$/))) {
      runs.push({ text: m[1].trim(), bold: true });
    } else {
      runs.push({ text: part });
    }
  });
  return runs;
}

// Split a markdown block into paragraphs. Mirrors renderNoteMarkdown.
function parseParas(md: string): Para[] {
  const paras: Para[] = [];
  md.split("\n").forEach((raw) => {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) {
      paras.push({ runs: [] });
      return;
    }
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^(#{1,3})\s+(.*)$/))) {
      const lvl = m[1].length;
      paras.push({
        style: (`HEADING_${lvl}` as NamedStyle),
        runs: parseRuns(m[2]),
      });
    } else if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
      paras.push({ bullet: "bullet", runs: parseRuns(m[1]) });
    } else if ((m = line.match(/^\s*\d+\.\s+(.*)$/))) {
      paras.push({ bullet: "number", runs: parseRuns(m[1]) });
    } else {
      paras.push({ runs: parseRuns(line) });
    }
  });
  return paras;
}

// Lay out the full document as an ordered list of paragraphs. The note title
// becomes the doc's Title style; Cornell notes get labeled Cue / Notes / Summary
// sections so the three columns survive the trip into a linear document.
function layout(note: NoteDocInput): Para[] {
  const paras: Para[] = [];
  const title = note.title.trim() || "Untitled note";
  paras.push({ style: "TITLE", runs: [{ text: title }] });

  const heading = (text: string): Para => ({
    style: "HEADING_2",
    runs: [{ text }],
  });

  if (note.template === "cornell") {
    if (note.cue?.trim()) {
      paras.push(heading("Cues / Questions"));
      paras.push(...parseParas(note.cue));
    }
    paras.push(heading("Notes"));
    paras.push(...parseParas(note.body));
    if (note.summary?.trim()) {
      paras.push(heading("Summary"));
      paras.push(...parseParas(note.summary));
    }
  } else {
    paras.push(...parseParas(note.body));
  }
  return paras;
}

// Build the { text, requests } pair to send to the Docs API: one insertText to
// lay down all the characters, then styling requests keyed to their indices.
export function buildDocRequests(note: NoteDocInput): {
  text: string;
  requests: unknown[];
} {
  const paras = layout(note);
  const requests: unknown[] = [];
  const meta: { start: number; para: Para; len: number }[] = [];

  let text = "";
  let index = 1; // body content starts after the doc's initial position
  for (const para of paras) {
    const plain = para.runs.map((r) => r.text).join("");
    meta.push({ start: index, para, len: plain.length });
    text += plain + "\n";
    index += plain.length + 1;
  }

  requests.push({ insertText: { location: { index: 1 }, text } });

  for (const { start, para, len } of meta) {
    const end = start + len + 1; // include the paragraph's trailing newline

    if (para.style && para.style !== "NORMAL_TEXT") {
      requests.push({
        updateParagraphStyle: {
          range: { startIndex: start, endIndex: end },
          paragraphStyle: { namedStyleType: para.style },
          fields: "namedStyleType",
        },
      });
    }

    if (para.bullet) {
      requests.push({
        createParagraphBullets: {
          range: { startIndex: start, endIndex: end },
          bulletPreset:
            para.bullet === "number"
              ? "NUMBERED_DECIMAL_ALPHA_ROMAN"
              : "BULLET_DISC_CIRCLE_SQUARE",
        },
      });
    }

    let offset = start;
    for (const run of para.runs) {
      const runLen = run.text.length;
      if (runLen > 0 && (run.bold || run.highlight)) {
        const textStyle: Record<string, unknown> = {};
        const fields: string[] = [];
        if (run.bold) {
          textStyle.bold = true;
          fields.push("bold");
        }
        if (run.highlight) {
          textStyle.backgroundColor = {
            color: { rgbColor: hexToRgb(run.highlight) },
          };
          fields.push("backgroundColor");
        }
        requests.push({
          updateTextStyle: {
            range: { startIndex: offset, endIndex: offset + runLen },
            textStyle,
            fields: fields.join(","),
          },
        });
      }
      offset += runLen;
    }
  }

  return { text, requests };
}
