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
// Sections, not one blob. The note is laid out as a short list of named
// sections (title / body, or title / cue / notes / summary for Cornell) and
// each one is wrapped in a Docs *named range* — "eliora:notes" and friends.
// The first sync creates the doc; every sync after that reads the named ranges
// back, compares each section's current text, and rewrites only the sections
// that actually changed. So a student who edits their summary keeps the
// comments, images, and hand-edits they added elsewhere in the doc.
//
// Index math: a fresh doc starts with one empty paragraph, so body content is
// inserted at index 1. Every character — including each newline — advances the
// index by one. On create we insert all the text in one request and then layer
// styling on top; none of updateParagraphStyle / createParagraphBullets /
// updateTextStyle changes the document length, so ranges stay valid regardless
// of order. On update we rewrite sections *bottom-up*, so an edit that changes
// one section's length can't invalidate the indices of the sections above it.

export type NoteDocInput = {
  title: string;
  template?: "free" | "cornell" | "canvas";
  body: string;
  cue?: string;
  summary?: string;
};

// Named ranges are shared with anything else the student puts in the doc, so
// prefix ours to keep them ours.
const RANGE_PREFIX = "eliora:";

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
type Section = { key: string; label: string; paras: Para[] };

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

// Lay the note out as named sections. The note title becomes the doc's Title
// style; Cornell notes get labeled Cue / Notes / Summary sections so the three
// columns survive the trip into a linear document.
//
// Cornell headings are emitted even when their column is empty: a section that
// exists in the doc from day one can be filled in later and still sync into its
// own slot, instead of having to be spliced in between the student's edits.
function sections(note: NoteDocInput): Section[] {
  const title = note.title.trim() || "Untitled note";
  const heading = (text: string): Para => ({
    style: "HEADING_2",
    runs: [{ text }],
  });

  const out: Section[] = [
    { key: "title", label: "Title", paras: [{ style: "TITLE", runs: [{ text: title }] }] },
  ];

  if (note.template === "cornell") {
    out.push({
      key: "cue",
      label: "Cues / Questions",
      paras: [heading("Cues / Questions"), ...parseParas(note.cue || "")],
    });
    out.push({
      key: "notes",
      label: "Notes",
      paras: [heading("Notes"), ...parseParas(note.body)],
    });
    out.push({
      key: "summary",
      label: "Summary",
      paras: [heading("Summary"), ...parseParas(note.summary || "")],
    });
  } else {
    out.push({ key: "body", label: "Notes", paras: parseParas(note.body) });
  }
  return out;
}

// Render one section's characters plus the styling requests that decorate them,
// as if the section starts at `start`. `reset` clears formatting first — needed
// when the section is replacing older content whose paragraph marks may still
// carry a heading style, a bullet, or a highlight.
function renderSection(
  sec: Section,
  start: number,
  reset: boolean,
): { text: string; requests: unknown[] } {
  const metas: { start: number; para: Para; len: number }[] = [];
  let text = "";
  let index = start;
  for (const para of sec.paras) {
    const plain = para.runs.map((r) => r.text).join("");
    metas.push({ start: index, para, len: plain.length });
    text += plain + "\n";
    index += plain.length + 1;
  }
  const secEnd = start + text.length;
  const requests: unknown[] = [];

  if (reset) {
    const range = { startIndex: start, endIndex: secEnd };
    requests.push({
      updateTextStyle: {
        range,
        textStyle: { bold: false, backgroundColor: {} },
        fields: "bold,backgroundColor",
      },
    });
    requests.push({
      updateParagraphStyle: {
        range,
        paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
        fields: "namedStyleType",
      },
    });
    requests.push({ deleteParagraphBullets: { range } });
  }

  for (const { start: pStart, para, len } of metas) {
    const end = pStart + len + 1; // include the paragraph's trailing newline

    if (para.style && para.style !== "NORMAL_TEXT") {
      requests.push({
        updateParagraphStyle: {
          range: { startIndex: pStart, endIndex: end },
          paragraphStyle: { namedStyleType: para.style },
          fields: "namedStyleType",
        },
      });
    }

    if (para.bullet) {
      requests.push({
        createParagraphBullets: {
          range: { startIndex: pStart, endIndex: end },
          bulletPreset:
            para.bullet === "number"
              ? "NUMBERED_DECIMAL_ALPHA_ROMAN"
              : "BULLET_DISC_CIRCLE_SQUARE",
        },
      });
    }

    let offset = pStart;
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

// First sync: fill a freshly created (empty) doc and stamp a named range around
// each section so later syncs can find them again.
export function buildCreateRequests(note: NoteDocInput): {
  text: string;
  requests: unknown[];
} {
  const styleReqs: unknown[] = [];
  const rangeReqs: unknown[] = [];
  let text = "";
  let index = 1; // body content starts after the doc's initial position

  for (const sec of sections(note)) {
    const r = renderSection(sec, index, false);
    text += r.text;
    styleReqs.push(...r.requests);
    rangeReqs.push({
      createNamedRange: {
        name: RANGE_PREFIX + sec.key,
        range: { startIndex: index, endIndex: index + r.text.length },
      },
    });
    index += r.text.length;
  }

  return {
    text,
    requests: [
      { insertText: { location: { index: 1 }, text } },
      ...styleReqs,
      ...rangeReqs,
    ],
  };
}

// The slice of the Docs `documents.get` response we actually read.
type DocsRange = { startIndex?: number; endIndex?: number };
export type DocsDocument = {
  body?: { content?: { paragraph?: { elements?: unknown[] } }[] };
  namedRanges?: Record<
    string,
    { namedRanges?: { namedRangeId?: string; ranges?: DocsRange[] }[] }
  >;
};

// Rebuild the document's text indexed by character position, so we can read
// back exactly what currently sits inside a section's named range.
function docChars(doc: DocsDocument): string[] {
  const chars: string[] = [];
  for (const el of doc.body?.content || []) {
    for (const pe of el.paragraph?.elements || []) {
      const e = pe as {
        startIndex?: number;
        textRun?: { content?: string };
      };
      const content = e.textRun?.content;
      if (typeof content !== "string" || typeof e.startIndex !== "number") {
        continue;
      }
      for (let i = 0; i < content.length; i++) chars[e.startIndex + i] = content[i];
    }
  }
  return chars;
}

function sliceChars(chars: string[], start: number, end: number): string {
  let out = "";
  for (let i = start; i < end; i++) out += chars[i] ?? "";
  return out;
}

// Re-sync into an existing doc. Returns the requests needed to bring only the
// changed sections up to date, plus the labels of the sections being rewritten
// so the UI can say what it touched.
//
// `relink: true` means the doc no longer carries our named ranges (a student
// deleted a chunk, or the doc predates section syncing) — there's nothing safe
// to line up against, so the caller should start a fresh doc rather than guess
// where the sections went.
export function buildUpdateRequests(
  note: NoteDocInput,
  doc: DocsDocument,
): { requests: unknown[]; changed: string[]; relink: boolean } {
  const secs = sections(note);
  const chars = docChars(doc);

  // Resolve every section's current span up front; one missing range means the
  // whole mapping is untrustworthy.
  const spans: { sec: Section; id: string; start: number; end: number }[] = [];
  for (const sec of secs) {
    const group = doc.namedRanges?.[RANGE_PREFIX + sec.key]?.namedRanges?.[0];
    const ranges = (group?.ranges || []).filter(
      (r): r is { startIndex: number; endIndex: number } =>
        typeof r.startIndex === "number" && typeof r.endIndex === "number",
    );
    if (!group?.namedRangeId || !ranges.length) {
      return { requests: [], changed: [], relink: true };
    }
    spans.push({
      sec,
      id: group.namedRangeId,
      start: Math.min(...ranges.map((r) => r.startIndex)),
      end: Math.max(...ranges.map((r) => r.endIndex)),
    });
  }

  const requests: unknown[] = [];
  const changed: string[] = [];

  // Bottom-up: rewriting a section changes the indices of everything below it,
  // so edit the lowest section first and the ones above keep the indices we
  // read from the fetched doc.
  for (const { sec, id, start, end } of [...spans].sort((a, b) => b.start - a.start)) {
    const { text, requests: styleReqs } = renderSection(sec, start, true);
    if (sliceChars(chars, start, end) === text) continue; // untouched section
    changed.push(sec.label);

    // Drop the range before the content: a named range whose text is fully
    // replaced can be dropped by Docs anyway, so we always restamp it.
    requests.push({ deleteNamedRange: { namedRangeId: id } });

    // Keep the section's final newline so the paragraph after it doesn't get
    // merged in; the replacement text supplies everything up to that newline.
    if (end - 1 > start) {
      requests.push({
        deleteContentRange: { range: { startIndex: start, endIndex: end - 1 } },
      });
    }
    const inserted = text.slice(0, -1);
    if (inserted) {
      requests.push({ insertText: { location: { index: start }, text: inserted } });
    }
    requests.push(...styleReqs);
    requests.push({
      createNamedRange: {
        name: RANGE_PREFIX + sec.key,
        range: { startIndex: start, endIndex: start + text.length },
      },
    });
  }

  return { requests, changed, relink: false };
}
