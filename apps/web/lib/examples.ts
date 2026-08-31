import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";
import type { StudentExample } from "@eliora/shared";

// Where anonymized peer examples live. Like lib/folders.ts and lib/users.ts,
// this is a local JSON file matching Eliora's no-database setup — NOT meant for
// production scale; a real cross-user deployment should move this to a shared
// datastore. Eliora searches this bank (find_student_examples) to show the
// learner how OTHER students worked through a similar problem, and appends to it
// (save_student_example) after helping someone, so the bank grows over time.
const FILE = path.join(process.cwd(), ".student-examples.json");

// Cap the file so it can't grow forever; oldest contributions drop first.
const MAX_EXAMPLES = 500;
// Default number of matches Eliora gets back for one search.
const DEFAULT_LIMIT = 3;
// Minimum relevance to be shown at all. A lone weight-1 prose-word overlap (an
// incidental word appearing in a longer field) is noise; require at least a
// topic/subject hit, a tag hit, or two prose hits.
const MIN_SCORE = 2;

// A small curated, fully anonymized starter set so the bank is never empty on
// day one. These are ALWAYS part of the search corpus (never overwritten), and
// learner-contributed examples are stored separately in FILE and added on top.
const SEED_EXAMPLES: StudentExample[] = [
  {
    id: "seed-two-step-equations",
    subject: "Algebra 1",
    topic: "solving two-step equations",
    problem: "Stuck on equations like 3x + 5 = 20 — unsure which step comes first.",
    approach:
      "Undo the operations in reverse order: subtract the added number from both sides first (get 3x = 15), then divide both sides by the coefficient (x = 5). Checked the answer by plugging it back in.",
    tags: ["equations", "solving for x", "inverse operations", "math"],
    createdAt: "2026-01-05T00:00:00.000Z",
  },
  {
    id: "seed-photosynthesis",
    subject: "Biology",
    topic: "photosynthesis inputs and outputs",
    problem: "Kept mixing up what goes in vs. what comes out of photosynthesis.",
    approach:
      "Made a tiny 'in → out' chart: in = carbon dioxide + water + light; out = glucose + oxygen. Tied it to a plant 'eating light to make sugar' so the direction stuck, then quizzed with flashcards.",
    tags: ["photosynthesis", "cells", "biology", "inputs outputs"],
    createdAt: "2026-01-06T00:00:00.000Z",
  },
  {
    id: "seed-thesis-statement",
    subject: "English",
    topic: "writing a thesis statement",
    problem: "Thesis kept being too vague — just restating the prompt.",
    approach:
      "Turned the prompt into a question, wrote a one-sentence answer, then added 'because…' with two specific reasons. That because-clause became the roadmap for the body paragraphs.",
    tags: ["thesis", "essay", "writing", "argument"],
    createdAt: "2026-01-07T00:00:00.000Z",
  },
  {
    id: "seed-fraction-addition",
    subject: "Math",
    topic: "adding fractions with unlike denominators",
    problem: "Added the tops and bottoms straight across (1/2 + 1/3 = 2/5).",
    approach:
      "Found a common denominator first by listing multiples (6), rewrote each fraction over 6 (3/6 + 2/6), then added only the numerators to get 5/6. Bottom stays the same.",
    tags: ["fractions", "denominators", "adding", "math"],
    createdAt: "2026-01-08T00:00:00.000Z",
  },
  {
    id: "seed-balancing-equations",
    subject: "Chemistry",
    topic: "balancing chemical equations",
    problem: "Changed subscripts to balance atoms instead of using coefficients.",
    approach:
      "Left the formulas alone and only added coefficients in front. Counted each element on both sides in a little tally, adjusted one coefficient at a time, saving hydrogen and oxygen for last.",
    tags: ["balancing", "equations", "chemistry", "coefficients"],
    createdAt: "2026-01-09T00:00:00.000Z",
  },
];

async function readStored(): Promise<StudentExample[]> {
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? (data as StudentExample[]) : [];
  } catch {
    return [];
  }
}

async function writeStored(examples: StudentExample[]): Promise<void> {
  await fs.writeFile(FILE, JSON.stringify(examples), "utf8");
}

// Split a string into lowercased word tokens for keyword matching.
function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 2);
}

// The searchable text of one example, weighted so topic/subject/tags count more
// than the longer prose fields.
function scoreExample(ex: StudentExample, queryTokens: Set<string>): number {
  if (queryTokens.size === 0) return 0;
  let score = 0;
  const bump = (text: string | undefined, weight: number) => {
    if (!text) return;
    for (const t of new Set(tokenize(text))) {
      if (queryTokens.has(t)) score += weight;
    }
  };
  bump(ex.topic, 3);
  bump(ex.subject, 3);
  bump((ex.tags ?? []).join(" "), 2);
  bump(ex.problem, 1);
  bump(ex.approach, 1);
  return score;
}

// Find the anonymized peer examples most relevant to a topic (optionally scoped
// to a subject). Searches the seed set plus every learner-contributed example.
export async function findExamples(
  topic: string,
  subject?: string,
  limit = DEFAULT_LIMIT,
): Promise<StudentExample[]> {
  const query = `${topic ?? ""} ${subject ?? ""}`.trim();
  const queryTokens = new Set(tokenize(query));
  if (queryTokens.size === 0) return [];

  const corpus = [...SEED_EXAMPLES, ...(await readStored())];
  return corpus
    .map((ex) => ({ ex, score: scoreExample(ex, queryTokens) }))
    .filter((s) => s.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Math.min(5, limit)))
    .map((s) => s.ex);
}

function clean(s: unknown, max: number): string {
  return typeof s === "string" ? s.trim().slice(0, max) : "";
}

// Append a new anonymized example contributed after helping a learner. Dedupes
// against existing stored examples (same subject+topic+problem) and caps the
// file. Returns the saved example, or null if it was too thin to keep.
export async function saveExample(input: {
  topic?: unknown;
  problem?: unknown;
  approach?: unknown;
  subject?: unknown;
  tags?: unknown;
}): Promise<StudentExample | null> {
  const topic = clean(input.topic, 120);
  const problem = clean(input.problem, 400);
  const approach = clean(input.approach, 600);
  if (!topic || !problem || !approach) return null;

  const subject = clean(input.subject, 80) || undefined;
  const tags = Array.isArray(input.tags)
    ? Array.from(
        new Set(
          input.tags
            .map((t) => clean(t, 40).toLowerCase())
            .filter((t) => t.length > 0),
        ),
      ).slice(0, 8)
    : undefined;

  const stored = await readStored();
  const key = (e: { subject?: string; topic: string; problem: string }) =>
    `${(e.subject ?? "").toLowerCase()}|${e.topic.toLowerCase()}|${e.problem.toLowerCase()}`;
  const newKey = key({ subject, topic, problem });
  if (stored.some((e) => key(e) === newKey)) {
    // Already have essentially this example — don't pile up duplicates.
    return stored.find((e) => key(e) === newKey) ?? null;
  }

  const example: StudentExample = {
    id: crypto.randomUUID(),
    subject,
    topic,
    problem,
    approach,
    tags: tags && tags.length ? tags : undefined,
    createdAt: new Date().toISOString(),
  };
  stored.push(example);
  // Keep only the most recent contributions if we're over the cap.
  const trimmed =
    stored.length > MAX_EXAMPLES ? stored.slice(-MAX_EXAMPLES) : stored;
  await writeStored(trimmed);
  return example;
}
