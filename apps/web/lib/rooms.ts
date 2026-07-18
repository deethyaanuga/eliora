import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";
import {
  TOGETHER_CODE_ALPHABET,
  TOGETHER_CODE_LENGTH,
  TOGETHER_FOCUS_SEC,
  TOGETHER_PRESENCE_MS,
  type TogetherRoom,
  type TogetherTimer,
} from "@eliora/shared";

// Where Study Together rooms live. Like lib/users.ts and lib/notifications.ts,
// this is a local JSON file matching Eliora's no-database setup — NOT meant for
// production scale; a real multiplayer deployment should move rooms to a real
// datastore (and swap polling for websockets). Clients poll GET /api/rooms/[code]
// a few times a second; every write goes through here.
const FILE = path.join(process.cwd(), ".study-rooms.json");

// Rooms with no present members for this long are swept on the next write, so
// the file doesn't grow forever. Generous vs. the presence window so a room
// survives everyone briefly closing the tab.
const ROOM_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
// Keep only the most recent messages per room.
const MAX_MESSAGES = 200;

async function readAll(): Promise<TogetherRoom[]> {
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

// Atomic write: every member polls a few times a second and each poll rewrites
// the whole file, so writes collide constantly. Write to a temp file then rename
// (atomic on POSIX) so a concurrent reader never sees a half-written file.
async function writeAll(rooms: TogetherRoom[]): Promise<void> {
  const tmp = `${FILE}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(rooms), "utf8");
  await fs.rename(tmp, FILE);
}

// In-process write lock. Atomic writes stop readers seeing torn files, but two
// overlapping read-modify-write cycles would still lose an update (both read the
// same state, the second write clobbers the first). Serialize every mutation
// through one promise chain so they run one at a time. This assumes a single
// server process (Eliora's local-first setup) — a real multi-process deployment
// would need a datastore with its own atomicity.
let chain: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// Read the file, let `fn` mutate it, then write it back — all under the lock so
// no two mutations interleave. `fn` returns the value the caller wants.
function mutate<T>(fn: (rooms: TogetherRoom[]) => T | Promise<T>): Promise<T> {
  return withLock(async () => {
    const rooms = sweep(await readAll(), Date.now());
    const result = await fn(rooms);
    await writeAll(rooms);
    return result;
  });
}

// Drop rooms whose last activity (heartbeat or message) is older than the TTL.
function sweep(rooms: TogetherRoom[], now: number): TogetherRoom[] {
  return rooms.filter((r) => {
    const lastSeen = r.members.reduce((m, x) => Math.max(m, x.lastSeen), 0);
    const lastMsg = r.messages.reduce((m, x) => Math.max(m, x.at), 0);
    return now - Math.max(r.createdAt, lastSeen, lastMsg) < ROOM_TTL_MS;
  });
}

function randomCode(): string {
  const bytes = crypto.randomBytes(TOGETHER_CODE_LENGTH);
  let out = "";
  for (let i = 0; i < TOGETHER_CODE_LENGTH; i++) {
    out += TOGETHER_CODE_ALPHABET[bytes[i] % TOGETHER_CODE_ALPHABET.length];
  }
  return out;
}

function cleanName(name: unknown, fallback = "Guest"): string {
  const n = typeof name === "string" ? name.trim() : "";
  return (n || fallback).slice(0, 40);
}

function idleTimer(): TogetherTimer {
  return { mode: "idle", running: false, durationSec: TOGETHER_FOCUS_SEC };
}

// Every mutation runs through mutate(), which sweeps, applies the change, and
// writes atomically under the in-process lock — so concurrent polls, messages,
// and timer changes never lose each other's updates.

export function createRoom(input: {
  name: string;
  topic?: string;
  memberId: string;
  memberName: string;
}): Promise<TogetherRoom> {
  return mutate((rooms) => {
    const now = Date.now();
    // Find a code not already in use.
    let code = randomCode();
    const taken = new Set(rooms.map((r) => r.code));
    while (taken.has(code)) code = randomCode();

    const room: TogetherRoom = {
      code,
      name: cleanName(input.name, "Study room"),
      topic:
        typeof input.topic === "string"
          ? input.topic.trim().slice(0, 120) || undefined
          : undefined,
      createdAt: now,
      timer: idleTimer(),
      members: [
        { id: input.memberId, name: cleanName(input.memberName), lastSeen: now },
      ],
      messages: [],
    };
    rooms.push(room);
    return room;
  });
}

// Join by code (or return an existing room the member already belongs to).
// Returns null if no such room exists.
export function joinRoom(input: {
  code: string;
  memberId: string;
  memberName: string;
}): Promise<TogetherRoom | null> {
  return mutate((rooms) => {
    const now = Date.now();
    const room = rooms.find((r) => r.code === input.code.trim().toUpperCase());
    if (!room) return null;
    const existing = room.members.find((m) => m.id === input.memberId);
    if (existing) {
      existing.name = cleanName(input.memberName);
      existing.lastSeen = now;
    } else {
      room.members.push({
        id: input.memberId,
        name: cleanName(input.memberName),
        lastSeen: now,
      });
    }
    return room;
  });
}

// Poll + heartbeat in one call: refresh the member's lastSeen and return the
// room. This is what clients hit on their polling interval. Returns null if the
// room has expired or never existed.
export function touchRoom(
  code: string,
  memberId: string,
  memberName?: string,
): Promise<TogetherRoom | null> {
  return mutate((rooms) => {
    const now = Date.now();
    const room = rooms.find((r) => r.code === code.trim().toUpperCase());
    if (!room) return null;
    const member = room.members.find((m) => m.id === memberId);
    if (member) {
      member.lastSeen = now;
      if (memberName) member.name = cleanName(memberName);
    } else if (memberName) {
      room.members.push({
        id: memberId,
        name: cleanName(memberName),
        lastSeen: now,
      });
    }
    return room;
  });
}

export function postMessage(
  code: string,
  memberId: string,
  name: string,
  text: string,
): Promise<TogetherRoom | null> {
  const clean = text.trim().slice(0, 500);
  if (!clean) return touchRoom(code, memberId, name);
  return mutate((rooms) => {
    const now = Date.now();
    const room = rooms.find((r) => r.code === code.trim().toUpperCase());
    if (!room) return null;
    const member = room.members.find((m) => m.id === memberId);
    if (member) member.lastSeen = now;
    room.messages.push({
      id: crypto.randomUUID(),
      memberId,
      name: cleanName(name),
      text: clean,
      at: now,
    });
    if (room.messages.length > MAX_MESSAGES) {
      room.messages = room.messages.slice(-MAX_MESSAGES);
    }
    return room;
  });
}

export type TimerAction =
  | { kind: "start"; mode: "focus" | "break"; durationSec: number }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "reset" };

// Apply a shared-timer action. The timer is stored as a phase + start time so
// every client derives the same countdown from the server clock.
export function updateTimer(
  code: string,
  memberId: string,
  name: string,
  action: TimerAction,
): Promise<TogetherRoom | null> {
  return mutate((rooms) => {
    const now = Date.now();
    const room = rooms.find((r) => r.code === code.trim().toUpperCase());
    if (!room) return null;
    const member = room.members.find((m) => m.id === memberId);
    if (member) member.lastSeen = now;

    const by = cleanName(name);
    const t = room.timer;
    switch (action.kind) {
      case "start":
        room.timer = {
          mode: action.mode,
          running: true,
          startedAt: now,
          durationSec: Math.max(30, Math.min(3600, Math.round(action.durationSec))),
          updatedBy: by,
        };
        break;
      case "pause":
        if (t.running && t.startedAt) {
          const elapsed = Math.floor((now - t.startedAt) / 1000);
          room.timer = {
            ...t,
            running: false,
            remainingSec: Math.max(0, t.durationSec - elapsed),
            updatedBy: by,
          };
        }
        break;
      case "resume":
        if (!t.running && t.mode !== "idle") {
          const left = t.remainingSec ?? t.durationSec;
          room.timer = {
            mode: t.mode,
            running: true,
            startedAt: now,
            durationSec: left,
            updatedBy: by,
          };
        }
        break;
      case "reset":
        room.timer = { ...idleTimer(), updatedBy: by };
        break;
    }
    return room;
  });
}

// Remove a member on explicit leave (presence timeout also handles this, but an
// explicit leave makes the room empty out immediately).
export function leaveRoom(code: string, memberId: string): Promise<void> {
  return mutate((rooms) => {
    const room = rooms.find((r) => r.code === code.trim().toUpperCase());
    if (room) room.members = room.members.filter((m) => m.id !== memberId);
  });
}

// Utility for callers/UI that want the presence window constant server-side.
export { TOGETHER_PRESENCE_MS };
