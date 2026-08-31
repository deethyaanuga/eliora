import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";
import {
  FOLDER_CODE_ALPHABET,
  FOLDER_CODE_LENGTH,
  FOLDER_ITEM_KINDS,
  type FolderItem,
  type FolderItemKind,
  type SharedFolder,
} from "@eliora/shared";

// Where shared folders live. Like lib/doubts.ts and lib/notifications.ts, this
// is a local JSON file matching Eliora's no-database setup — NOT meant for
// production scale; a real multi-user deployment should move folders to a real
// datastore (and swap polling for websockets). Clients poll GET
// /api/folders/[code] every few seconds; every write goes through here.
const FILE = path.join(process.cwd(), ".shared-folders.json");

// A folder is meant to last a term — friends share it for a whole class. We
// still sweep so the file can't grow forever, but only after a long stretch
// with no activity from anyone.
const FOLDER_TTL_MS = 180 * 24 * 60 * 60 * 1000; // ~6 months
// Cap items per folder so one runaway client can't bloat the file.
const MAX_ITEMS = 300;

async function readAll(): Promise<SharedFolder[]> {
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

// Atomic write: every member polls a few times a second and each poll can
// rewrite the whole file, so writes collide. Write to a temp file then rename
// (atomic on POSIX) so a concurrent reader never sees a half-written file.
async function writeAll(folders: SharedFolder[]): Promise<void> {
  const tmp = `${FILE}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(folders), "utf8");
  await fs.rename(tmp, FILE);
}

// In-process write lock. Atomic writes stop torn reads, but two overlapping
// read-modify-write cycles would still lose an update. Serialize every mutation
// through one promise chain so they run one at a time. Assumes a single server
// process (Eliora's local-first setup).
let chain: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// Read the file, let `fn` mutate it, then write it back — all under the lock.
function mutate<T>(fn: (folders: SharedFolder[]) => T | Promise<T>): Promise<T> {
  return withLock(async () => {
    const folders = sweep(await readAll(), Date.now());
    const result = await fn(folders);
    await writeAll(folders);
    return result;
  });
}

// Drop folders whose most recent activity (creation, heartbeat, or item edit)
// is older than the TTL.
function sweep(folders: SharedFolder[], now: number): SharedFolder[] {
  return folders.filter((f) => {
    const lastSeen = f.members.reduce((m, x) => Math.max(m, x.lastSeen), 0);
    const lastItem = f.items.reduce((m, x) => Math.max(m, x.updatedAt), 0);
    return now - Math.max(f.createdAt, lastSeen, lastItem) < FOLDER_TTL_MS;
  });
}

function randomCode(): string {
  const bytes = crypto.randomBytes(FOLDER_CODE_LENGTH);
  let out = "";
  for (let i = 0; i < FOLDER_CODE_LENGTH; i++) {
    out += FOLDER_CODE_ALPHABET[bytes[i] % FOLDER_CODE_ALPHABET.length];
  }
  return out;
}

function cleanName(name: unknown, fallback = "Guest"): string {
  const n = typeof name === "string" ? name.trim() : "";
  return (n || fallback).slice(0, 40);
}

function find(folders: SharedFolder[], code: string): SharedFolder | undefined {
  return folders.find((f) => f.code === code.trim().toUpperCase());
}

// Bump a member's heartbeat (or add them if they arrived via a share link they
// hadn't formally joined). Returns the member so callers can attribute edits.
function touchMember(
  folder: SharedFolder,
  memberId: string,
  name: string | undefined,
  now: number,
) {
  const existing = folder.members.find((m) => m.id === memberId);
  if (existing) {
    existing.lastSeen = now;
    if (name) existing.name = cleanName(name);
    return existing;
  }
  const member = { id: memberId, name: cleanName(name), lastSeen: now };
  folder.members.push(member);
  return member;
}

// ---- Item shaping ----------------------------------------------------------

type ItemInput = {
  kind?: string;
  title?: string;
  subject?: string;
  due?: string;
  details?: string;
};

function cleanKind(kind: unknown): FolderItemKind {
  return FOLDER_ITEM_KINDS.includes(kind as FolderItemKind)
    ? (kind as FolderItemKind)
    : "assignment";
}

// Only accept YYYY-MM-DD; anything else becomes undefined so ordering stays sane.
function cleanDue(due: unknown): string | undefined {
  return typeof due === "string" && /^\d{4}-\d{2}-\d{2}$/.test(due.trim())
    ? due.trim()
    : undefined;
}

function trimTo(value: unknown, max: number): string | undefined {
  const v = typeof value === "string" ? value.trim() : "";
  return v ? v.slice(0, max) : undefined;
}

// ---- Public API ------------------------------------------------------------

export function createFolder(input: {
  name: string;
  memberId: string;
  memberName: string;
}): Promise<SharedFolder> {
  return mutate((folders) => {
    const now = Date.now();
    let code = randomCode();
    const taken = new Set(folders.map((f) => f.code));
    while (taken.has(code)) code = randomCode();

    const folder: SharedFolder = {
      code,
      name: cleanName(input.name, "Shared folder"),
      createdAt: now,
      members: [
        { id: input.memberId, name: cleanName(input.memberName), lastSeen: now },
      ],
      items: [],
    };
    folders.push(folder);
    return folder;
  });
}

// Join by code (or refresh membership if already in). Returns null if no such
// folder exists.
export function joinFolder(input: {
  code: string;
  memberId: string;
  memberName: string;
}): Promise<SharedFolder | null> {
  return mutate((folders) => {
    const folder = find(folders, input.code);
    if (!folder) return null;
    touchMember(folder, input.memberId, input.memberName, Date.now());
    return folder;
  });
}

// Poll + heartbeat: refresh the member's lastSeen and return the folder. Null
// if the folder has expired or never existed.
export function touchFolder(
  code: string,
  memberId: string,
  memberName?: string,
): Promise<SharedFolder | null> {
  return mutate((folders) => {
    const folder = find(folders, code);
    if (!folder) return null;
    if (memberId) touchMember(folder, memberId, memberName, Date.now());
    return folder;
  });
}

export function addItem(
  code: string,
  memberId: string,
  name: string,
  input: ItemInput,
): Promise<SharedFolder | null> {
  return mutate((folders) => {
    const folder = find(folders, code);
    if (!folder) return null;
    const now = Date.now();
    const member = touchMember(folder, memberId, name, now);
    const title = trimTo(input.title, 160);
    if (!title) return folder; // ignore empty adds
    if (folder.items.length >= MAX_ITEMS) {
      // Full: drop the oldest done item to make room, else refuse silently.
      const oldestDone = folder.items
        .filter((i) => i.done)
        .sort((a, b) => a.updatedAt - b.updatedAt)[0];
      if (oldestDone) {
        folder.items = folder.items.filter((i) => i.id !== oldestDone.id);
      } else {
        return folder;
      }
    }
    const item: FolderItem = {
      id: crypto.randomUUID(),
      kind: cleanKind(input.kind),
      title,
      subject: trimTo(input.subject, 60),
      due: cleanDue(input.due),
      details: trimTo(input.details, 600),
      done: false,
      addedBy: member.name,
      addedById: memberId,
      createdAt: now,
      updatedAt: now,
    };
    folder.items.push(item);
    return folder;
  });
}

// Patch a single item — used for toggling done and inline edits. Only provided
// fields change. Returns the folder (unchanged if the item is gone).
export function updateItem(
  code: string,
  memberId: string,
  name: string,
  itemId: string,
  patch: { done?: boolean } & ItemInput,
): Promise<SharedFolder | null> {
  return mutate((folders) => {
    const folder = find(folders, code);
    if (!folder) return null;
    const now = Date.now();
    touchMember(folder, memberId, name, now);
    const item = folder.items.find((i) => i.id === itemId);
    if (!item) return folder;
    if (typeof patch.done === "boolean") item.done = patch.done;
    if (patch.kind !== undefined) item.kind = cleanKind(patch.kind);
    if (patch.title !== undefined) {
      const t = trimTo(patch.title, 160);
      if (t) item.title = t;
    }
    if (patch.subject !== undefined) item.subject = trimTo(patch.subject, 60);
    if (patch.due !== undefined) item.due = cleanDue(patch.due);
    if (patch.details !== undefined) item.details = trimTo(patch.details, 600);
    item.updatedAt = now;
    return folder;
  });
}

export function removeItem(
  code: string,
  memberId: string,
  name: string,
  itemId: string,
): Promise<SharedFolder | null> {
  return mutate((folders) => {
    const folder = find(folders, code);
    if (!folder) return null;
    touchMember(folder, memberId, name, Date.now());
    folder.items = folder.items.filter((i) => i.id !== itemId);
    return folder;
  });
}

export function renameFolder(
  code: string,
  memberId: string,
  name: string,
  newName: string,
): Promise<SharedFolder | null> {
  return mutate((folders) => {
    const folder = find(folders, code);
    if (!folder) return null;
    touchMember(folder, memberId, name, Date.now());
    const clean = cleanName(newName, folder.name);
    folder.name = clean;
    return folder;
  });
}

// Remove a member on explicit leave. The folder itself lives on for the others
// (and survives everyone leaving until the TTL sweep).
export function leaveFolder(code: string, memberId: string): Promise<void> {
  return mutate((folders) => {
    const folder = find(folders, code);
    if (folder) folder.members = folder.members.filter((m) => m.id !== memberId);
  });
}
