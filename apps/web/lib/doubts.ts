import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";
import {
  DOUBT_BODY_MAX,
  DOUBT_CODE_ALPHABET,
  DOUBT_CODE_LENGTH,
  DOUBT_GLOBAL_SCOPE,
  DOUBT_MAX_DEPTH,
  DOUBT_REPLY_MAX,
  DOUBT_TITLE_MAX,
  DOUBT_WORK_MAX,
  normalizeDoubtKind,
  normalizeDoubtScope,
  type Doubt,
  type DoubtGroup,
  type DoubtReply,
  type DoubtVoteValue,
} from "@eliora/shared";

// Where the doubts board lives. Like lib/folders.ts and lib/users.ts this is a
// local JSON file matching Eliora's no-database setup — NOT meant for
// production scale; a real multi-user deployment should move this to a real
// datastore (and swap polling for websockets). Clients poll GET /api/doubts
// every few seconds; every write goes through here.
const FILE = path.join(process.cwd(), ".doubts.json");

// A doubt is meant to stay useful — someone hitting the same wall next month
// should still find the answer. We sweep only after a long stretch with no
// activity so the file can't grow forever.
const DOUBT_TTL_MS = 180 * 24 * 60 * 60 * 1000; // ~6 months
// Caps so one runaway client can't bloat the file.
const MAX_DOUBTS_PER_SCOPE = 500;
const MAX_REPLIES_PER_DOUBT = 300;

// The whole board in one record: groups (join codes) plus every doubt across
// every scope. Kept as one file so a create-group-then-post round trip can't
// half-succeed across two files.
type Store = { groups: DoubtGroup[]; doubts: Doubt[] };

const EMPTY: Store = { groups: [], doubts: [] };

async function readStore(): Promise<Store> {
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const data = JSON.parse(raw) as Partial<Store>;
    return {
      groups: Array.isArray(data?.groups) ? data.groups : [],
      doubts: Array.isArray(data?.doubts) ? data.doubts : [],
    };
  } catch {
    return { ...EMPTY };
  }
}

// Atomic write: clients poll every few seconds and each write rewrites the
// whole file, so writes collide. Write to a temp file then rename (atomic on
// POSIX) so a concurrent reader never sees a half-written file.
async function writeStore(store: Store): Promise<void> {
  const tmp = `${FILE}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(store), "utf8");
  await fs.rename(tmp, FILE);
}

// In-process write lock. Atomic writes stop torn reads, but two overlapping
// read-modify-write cycles would still lose an update (both read the same
// state, the second write clobbers the first). Serialize every mutation through
// one promise chain. Assumes a single server process (Eliora's local-first
// setup) — a real multi-process deployment needs a datastore with its own
// atomicity.
let chain: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// Read the store, let `fn` mutate it, then write it back — all under the lock
// so no two mutations interleave.
function mutate<T>(fn: (store: Store) => T | Promise<T>): Promise<T> {
  return withLock(async () => {
    const store = sweep(await readStore(), Date.now());
    const result = await fn(store);
    await writeStore(store);
    return result;
  });
}

// Read-only counterpart to mutate(). Reading the feed is by far the most common
// operation — every client polls it every few seconds — so it must not write.
// (An earlier version routed reads through mutate() to refresh presence, which
// rewrote the whole file on every poll from every member.)
function query<T>(fn: (store: Store) => T): Promise<T> {
  return withLock(async () => fn(sweep(await readStore(), Date.now())));
}

// Drop doubts and groups that nobody has touched in a very long time. A group
// counts as active if anyone has joined, been seen, or posted in it — reads
// don't bump presence, so the doubts themselves are what keep it alive.
function sweep(store: Store, now: number): Store {
  const alive = (d: Doubt): boolean => {
    const lastReply = d.replies.reduce((m, r) => Math.max(m, r.at), 0);
    return now - Math.max(d.createdAt, lastReply) < DOUBT_TTL_MS;
  };
  store.doubts = store.doubts.filter(alive);
  const activeScopes = new Set(store.doubts.map((d) => d.scope));
  store.groups = store.groups.filter((g) => {
    if (activeScopes.has(g.code)) return true;
    const lastSeen = g.members.reduce((m, x) => Math.max(m, x.lastSeen), 0);
    return now - Math.max(g.createdAt, lastSeen) < DOUBT_TTL_MS;
  });
  return store;
}

function randomCode(): string {
  const bytes = crypto.randomBytes(DOUBT_CODE_LENGTH);
  let out = "";
  for (let i = 0; i < DOUBT_CODE_LENGTH; i++) {
    out += DOUBT_CODE_ALPHABET[bytes[i] % DOUBT_CODE_ALPHABET.length];
  }
  return out;
}

function cleanName(name: unknown, fallback = "Guest"): string {
  const n = typeof name === "string" ? name.trim() : "";
  return (n || fallback).slice(0, 40);
}

function cleanText(text: unknown, max: number): string {
  return typeof text === "string" ? text.trim().slice(0, max) : "";
}

// Optional free-text field: empty becomes undefined so it's absent from the
// JSON rather than stored as "".
function optionalText(text: unknown, max: number): string | undefined {
  return cleanText(text, max) || undefined;
}

function touchGroupMember(
  group: DoubtGroup,
  memberId: string,
  name: string | undefined,
  now: number,
): void {
  const existing = group.members.find((m) => m.id === memberId);
  if (existing) {
    existing.lastSeen = now;
    if (name) existing.name = cleanName(name);
    return;
  }
  group.members.push({ id: memberId, name: cleanName(name), lastSeen: now });
}

// ---- Groups ----------------------------------------------------------------

export function createGroup(input: {
  name: string;
  memberId: string;
  memberName: string;
}): Promise<DoubtGroup> {
  return mutate((store) => {
    const now = Date.now();
    let code = randomCode();
    const taken = new Set(store.groups.map((g) => g.code));
    while (taken.has(code)) code = randomCode();

    const group: DoubtGroup = {
      code,
      name: cleanName(input.name, "Study group"),
      createdAt: now,
      members: [
        { id: input.memberId, name: cleanName(input.memberName), lastSeen: now },
      ],
    };
    store.groups.push(group);
    return group;
  });
}

// Join by code. Returns null if no such group exists — the caller turns that
// into a 404 so the UI can say "no group with that code".
export function joinGroup(input: {
  code: string;
  memberId: string;
  memberName: string;
}): Promise<DoubtGroup | null> {
  return mutate((store) => {
    const now = Date.now();
    const code = input.code.trim().toUpperCase();
    const group = store.groups.find((g) => g.code === code);
    if (!group) return null;
    touchGroupMember(group, input.memberId, input.memberName, now);
    return group;
  });
}

// ---- Reading the feed ------------------------------------------------------

export interface DoubtFeed {
  scope: string;
  group: DoubtGroup | null; // null for the global feed
  doubts: Doubt[];
}

// Every doubt in scope. Returns null when a group scope names a group that
// doesn't exist, so the client can drop a stale saved code instead of polling
// forever. Deliberately read-only — a doubts board has no live presence to
// maintain, so polling costs nothing but a file read.
export function readFeed(scope: string): Promise<DoubtFeed | null> {
  const normalized = normalizeDoubtScope(scope);
  if (!normalized) return Promise.resolve(null);
  return query((store) => {
    if (
      normalized !== DOUBT_GLOBAL_SCOPE &&
      !store.groups.some((g) => g.code === normalized)
    ) {
      return null;
    }
    return feedOf(store, normalized);
  });
}

// Every mutation below returns the whole in-scope feed rather than just the
// changed record, so the client can adopt fresh state in one round trip and
// feel instant between polls.
function feedOf(store: Store, scope: string): DoubtFeed {
  return {
    scope,
    group:
      scope === DOUBT_GLOBAL_SCOPE
        ? null
        : (store.groups.find((g) => g.code === scope) ?? null),
    doubts: store.doubts.filter((d) => d.scope === scope),
  };
}

// Resolve a scope and confirm it exists, running `fn` only if so. Any missing
// group or malformed scope collapses to null → 404 at the route.
function inScope<T>(
  scope: string,
  fn: (store: Store, scope: string) => T | null,
): Promise<T | null> {
  const normalized = normalizeDoubtScope(scope);
  if (!normalized) return Promise.resolve(null);
  return mutate((store) => {
    if (
      normalized !== DOUBT_GLOBAL_SCOPE &&
      !store.groups.some((g) => g.code === normalized)
    ) {
      return null;
    }
    return fn(store, normalized);
  });
}

// ---- Posting ---------------------------------------------------------------

// Posts a question ("stuck on this") or a solved write-up ("here's the problem
// and how I got past it") — same record, same feed, `kind` telling them apart.
// A fix must actually carry the fix, so `work` is required when kind is
// "solved" (the route turns the null into a message).
export function askDoubt(input: {
  scope: string;
  authorId: string;
  authorName: string;
  title: string;
  body: string;
  kind?: string;
  subject?: string;
  work?: string;
}): Promise<DoubtFeed | null> {
  return inScope(input.scope, (store, scope) => {
    const title = cleanText(input.title, DOUBT_TITLE_MAX);
    if (!title) return null;
    const kind = normalizeDoubtKind(input.kind);
    const work = optionalText(input.work, DOUBT_WORK_MAX);
    if (kind === "solved" && !work) return null;
    const doubt: Doubt = {
      id: crypto.randomUUID(),
      scope,
      kind,
      authorId: input.authorId,
      authorName: cleanName(input.authorName),
      subject: optionalText(input.subject, 40),
      title,
      body: cleanText(input.body, DOUBT_BODY_MAX),
      work,
      createdAt: Date.now(),
      votes: {},
      replies: [],
    };
    store.doubts.push(doubt);

    // Trim the oldest doubts in this scope if it has grown past the cap.
    const inThisScope = store.doubts.filter((d) => d.scope === scope);
    if (inThisScope.length > MAX_DOUBTS_PER_SCOPE) {
      const drop = new Set(
        [...inThisScope]
          .sort((a, b) => a.createdAt - b.createdAt)
          .slice(0, inThisScope.length - MAX_DOUBTS_PER_SCOPE)
          .map((d) => d.id),
      );
      store.doubts = store.doubts.filter((d) => !drop.has(d.id));
    }
    return feedOf(store, scope);
  });
}

// Depth of a reply if it were hung off `parentId`, used to clamp nesting.
function depthOf(doubt: Doubt, parentId: string | undefined): number {
  let depth = 0;
  let cursor = parentId;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const parent = doubt.replies.find((r) => r.id === cursor);
    if (!parent) break;
    depth += 1;
    cursor = parent.parentId;
  }
  return depth;
}

export function replyToDoubt(input: {
  scope: string;
  doubtId: string;
  parentId?: string;
  authorId: string;
  authorName: string;
  text: string;
  work?: string;
}): Promise<DoubtFeed | null> {
  return inScope(input.scope, (store, scope) => {
    const doubt = store.doubts.find(
      (d) => d.id === input.doubtId && d.scope === scope,
    );
    if (!doubt) return null;
    const text = cleanText(input.text, DOUBT_REPLY_MAX);
    const work = optionalText(input.work, DOUBT_WORK_MAX);
    // A reply that's *only* working-out is fine — showing the steps is the
    // point of the board — but an entirely empty one isn't.
    if (!text && !work) return null;

    // Clamp nesting: past the max depth, hang the reply off its grandparent's
    // level instead of indenting further.
    let parentId =
      input.parentId && doubt.replies.some((r) => r.id === input.parentId)
        ? input.parentId
        : undefined;
    while (parentId && depthOf(doubt, parentId) >= DOUBT_MAX_DEPTH) {
      parentId = doubt.replies.find((r) => r.id === parentId)?.parentId;
    }

    const reply: DoubtReply = {
      id: crypto.randomUUID(),
      parentId,
      authorId: input.authorId,
      authorName: cleanName(input.authorName),
      text,
      work,
      at: Date.now(),
      votes: {},
    };
    doubt.replies.push(reply);
    if (doubt.replies.length > MAX_REPLIES_PER_DOUBT) {
      doubt.replies = doubt.replies.slice(-MAX_REPLIES_PER_DOUBT);
    }
    return feedOf(store, scope);
  });
}

// ---- Votes, accepting, deleting --------------------------------------------

// Vote on a doubt (no replyId) or a reply. Voting the same way twice clears the
// vote, like Reddit's toggle. You can't vote on your own post.
export function voteOnDoubt(input: {
  scope: string;
  doubtId: string;
  replyId?: string;
  memberId: string;
  value: DoubtVoteValue;
}): Promise<DoubtFeed | null> {
  return inScope(input.scope, (store, scope) => {
    const doubt = store.doubts.find(
      (d) => d.id === input.doubtId && d.scope === scope,
    );
    if (!doubt) return null;
    const target = input.replyId
      ? doubt.replies.find((r) => r.id === input.replyId)
      : doubt;
    if (!target) return null;
    const authorId = "authorId" in target ? target.authorId : "";
    if (authorId === input.memberId) return feedOf(store, scope);

    if (target.votes[input.memberId] === input.value) {
      delete target.votes[input.memberId];
    } else {
      target.votes[input.memberId] = input.value;
    }
    return feedOf(store, scope);
  });
}

// Only the asker can mark which reply unstuck them; marking the same one again
// clears it.
export function acceptDoubtReply(input: {
  scope: string;
  doubtId: string;
  replyId: string;
  memberId: string;
}): Promise<DoubtFeed | null> {
  return inScope(input.scope, (store, scope) => {
    const doubt = store.doubts.find(
      (d) => d.id === input.doubtId && d.scope === scope,
    );
    if (!doubt) return null;
    if (doubt.authorId !== input.memberId) return feedOf(store, scope);
    if (!doubt.replies.some((r) => r.id === input.replyId)) return feedOf(store, scope);
    doubt.solvedReplyId =
      doubt.solvedReplyId === input.replyId ? undefined : input.replyId;
    return feedOf(store, scope);
  });
}

// Delete your own doubt, or your own reply. A deleted reply's children are
// re-parented to its parent so the rest of the thread survives.
export function deleteDoubt(input: {
  scope: string;
  doubtId: string;
  replyId?: string;
  memberId: string;
}): Promise<DoubtFeed | null> {
  return inScope(input.scope, (store, scope) => {
    const doubt = store.doubts.find(
      (d) => d.id === input.doubtId && d.scope === scope,
    );
    if (!doubt) return null;

    if (!input.replyId) {
      if (doubt.authorId !== input.memberId) return feedOf(store, scope);
      store.doubts = store.doubts.filter((d) => d.id !== doubt.id);
      return feedOf(store, scope);
    }

    const reply = doubt.replies.find((r) => r.id === input.replyId);
    if (!reply || reply.authorId !== input.memberId) return feedOf(store, scope);
    for (const child of doubt.replies) {
      if (child.parentId === reply.id) child.parentId = reply.parentId;
    }
    doubt.replies = doubt.replies.filter((r) => r.id !== reply.id);
    if (doubt.solvedReplyId === reply.id) doubt.solvedReplyId = undefined;
    return feedOf(store, scope);
  });
}
