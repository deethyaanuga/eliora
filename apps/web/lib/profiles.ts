import { promises as fs } from "fs";
import path from "path";

// Server-side copy of each learner's sign-up survey answers, keyed by email.
// The app is local-first (the profile lives in localStorage), but that means a
// login from a new browser or device used to restart the questionnaire from
// scratch. Saving a copy here lets /api/profile hand the answers back on any
// device. Like lib/users.ts this is a local JSON file matching Eliora's
// no-database setup — a real deployment should move it to a database.
const FILE = path.join(process.cwd(), ".learner-profiles.json");

// The profile shape is owned by the client (LearnerProfile in app/page.tsx);
// the server just stores it verbatim per email.
type ProfileMap = Record<string, Record<string, unknown>>;

// Reject bodies that clearly aren't a survey profile so one bad client can't
// bloat the file. Real profiles are a flat object of short strings (~1 KB).
const MAX_PROFILE_BYTES = 16 * 1024;

async function readAll(): Promise<ProfileMap> {
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const data = JSON.parse(raw);
    return data && typeof data === "object" && !Array.isArray(data)
      ? (data as ProfileMap)
      : {};
  } catch {
    return {};
  }
}

export async function getProfile(
  email: string,
): Promise<Record<string, unknown> | null> {
  const all = await readAll();
  return all[email.trim().toLowerCase()] ?? null;
}

export async function saveProfile(
  email: string,
  profile: Record<string, unknown>,
): Promise<boolean> {
  if (JSON.stringify(profile).length > MAX_PROFILE_BYTES) return false;
  const all = await readAll();
  all[email.trim().toLowerCase()] = profile;
  await fs.writeFile(FILE, JSON.stringify(all, null, 2), "utf8");
  return true;
}
