import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";

// A tiny local credentials store for email sign-up. Users are kept in a JSON
// file next to the app with scrypt-hashed passwords. This matches Eliora's
// local-first, no-database setup — it is NOT meant for production scale; a real
// deployment should move these to a database.
const FILE = path.join(process.cwd(), ".auth-users.json");

type StoredUser = {
  email: string;
  name?: string;
  salt: string;
  passwordHash: string;
};

async function readAll(): Promise<StoredUser[]> {
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function writeAll(users: StoredUser[]): Promise<void> {
  await fs.writeFile(FILE, JSON.stringify(users, null, 2), "utf8");
}

function hash(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export async function createUser(
  email: string,
  password: string,
  name?: string,
): Promise<void> {
  const e = email.trim().toLowerCase();
  const users = await readAll();
  if (users.some((u) => u.email === e)) {
    throw new Error("exists");
  }
  const salt = crypto.randomBytes(16).toString("hex");
  users.push({ email: e, name: name?.trim() || undefined, salt, passwordHash: hash(password, salt) });
  await writeAll(users);
}

export async function verifyUser(
  email: string,
  password: string,
): Promise<{ id: string; email: string; name: string } | null> {
  const e = email.trim().toLowerCase();
  const users = await readAll();
  const u = users.find((x) => x.email === e);
  if (!u) return null;
  if (!safeEqual(hash(password, u.salt), u.passwordHash)) return null;
  return { id: e, email: e, name: u.name ?? e.split("@")[0] };
}
