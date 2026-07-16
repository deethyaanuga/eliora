import { auth } from "@/auth";
import {
  deriveWeakTopics,
  percentToLetter,
  type AssignmentGrade,
  type CourseGrade,
} from "@eliora/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Pull the signed-in student's grades from a school platform and return them in
// Eliora's normalized shape, plus the weak topics derived from them (ready to
// merge into `eliora-missed`). Google Classroom is the first — and so far only —
// provider: it rides the existing NextAuth Google login, so no extra connect
// step or token storage is needed. Canvas / PowerSchool adapters slot in here
// behind the same response shape.

const CLASSROOM = "https://classroom.googleapis.com/v1";

type GClassCourse = { id: string; name?: string; section?: string };
type GClassCourseWork = {
  id: string;
  title?: string;
  maxPoints?: number;
  topicId?: string;
  dueDate?: { year?: number; month?: number; day?: number };
};
type GClassTopic = { topicId: string; name?: string };
type GClassSubmission = {
  courseWorkId?: string;
  assignedGrade?: number;
  draftGrade?: number;
  state?: string; // NEW | CREATED | TURNED_IN | RETURNED | RECLAIMED_BY_STUDENT
  late?: boolean;
};

async function gget<T>(
  path: string,
  token: string,
): Promise<T> {
  const res = await fetch(`${CLASSROOM}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const err = new Error(`Classroom ${res.status}`) as Error & {
      status: number;
    };
    err.status = res.status;
    throw err;
  }
  return (await res.json()) as T;
}

function dueToISO(due?: GClassCourseWork["dueDate"]): string | undefined {
  if (!due?.year || !due.month || !due.day) return undefined;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${due.year}-${p(due.month)}-${p(due.day)}`;
}

// Turn one Google Classroom course into a normalized CourseGrade.
async function fetchCourseGrade(
  course: GClassCourse,
  token: string,
): Promise<CourseGrade> {
  const [workRes, topicRes, subRes] = await Promise.all([
    gget<{ courseWork?: GClassCourseWork[] }>(
      `/courses/${course.id}/courseWork?pageSize=100`,
      token,
    ).catch(() => ({ courseWork: [] })),
    gget<{ topic?: GClassTopic[] }>(
      `/courses/${course.id}/topics?pageSize=100`,
      token,
    ).catch(() => ({ topic: [] })),
    // The `-` wildcard returns submissions across all coursework in the course.
    gget<{ studentSubmissions?: GClassSubmission[] }>(
      `/courses/${course.id}/courseWork/-/studentSubmissions?userId=me&pageSize=200`,
      token,
    ).catch(() => ({ studentSubmissions: [] })),
  ]);

  const workById = new Map(
    (workRes.courseWork ?? []).map((w) => [w.id, w]),
  );
  const topicById = new Map(
    (topicRes.topic ?? []).map((t) => [t.topicId, t.name ?? ""]),
  );

  const assignments: AssignmentGrade[] = [];
  let earned = 0;
  let possible = 0;

  for (const sub of subRes.studentSubmissions ?? []) {
    const work = sub.courseWorkId
      ? workById.get(sub.courseWorkId)
      : undefined;
    if (!work) continue;
    const grade = sub.assignedGrade ?? sub.draftGrade;
    const maxScore = work.maxPoints;
    const percentage =
      typeof grade === "number" && typeof maxScore === "number" && maxScore > 0
        ? (grade / maxScore) * 100
        : undefined;
    // "Missing" = past due, still not turned in.
    const dueISO = dueToISO(work.dueDate);
    const notSubmitted =
      sub.state === "NEW" || sub.state === "CREATED" || sub.state === "RECLAIMED_BY_STUDENT";
    const missing = Boolean(
      notSubmitted && dueISO && dueISO < new Date().toISOString().slice(0, 10),
    );

    if (typeof percentage === "number") {
      earned += grade as number;
      possible += maxScore as number;
    }

    assignments.push({
      id: work.id,
      title: work.title ?? "Untitled",
      score: typeof grade === "number" ? grade : undefined,
      maxScore,
      percentage,
      dueDate: dueISO,
      category: work.topicId ? topicById.get(work.topicId) || undefined : undefined,
      late: sub.late,
      missing,
    });
  }

  const overallPercent = possible > 0 ? (earned / possible) * 100 : undefined;

  return {
    provider: "google-classroom",
    courseId: course.id,
    courseName: course.name ?? course.section ?? "Course",
    overallPercent,
    letterGrade: percentToLetter(overallPercent),
    assignments,
  };
}

export async function GET() {
  const session = await auth();
  const token = (session as { accessToken?: string } | null)?.accessToken;
  const provider = (session as { authProvider?: string } | null)?.authProvider;

  if (!session) {
    return Response.json({ error: "Please sign in first." }, { status: 401 });
  }
  if (provider !== "google" || !token) {
    return Response.json(
      {
        error:
          "Grade sync needs a Google sign-in. Sign in with Google to connect " +
          "your Classroom account.",
        needsGoogle: true,
      },
      { status: 400 },
    );
  }

  try {
    const courseRes = await gget<{ courses?: GClassCourse[] }>(
      "/courses?courseStates=ACTIVE&studentId=me&pageSize=50",
      token,
    );
    const courses = courseRes.courses ?? [];
    const grades = await Promise.all(
      courses.map((c) => fetchCourseGrade(c, token)),
    );
    const weakTopics = deriveWeakTopics(grades);

    return Response.json({
      provider: "google-classroom",
      syncedAt: new Date().toISOString(),
      courses: grades,
      weakTopics,
    });
  } catch (err) {
    const status = (err as { status?: number })?.status;
    if (status === 401 || status === 403) {
      return Response.json(
        {
          error:
            "Google didn't grant access to Classroom. Sign out and back in " +
            "with Google, and approve the Classroom permissions.",
          needsGoogle: true,
        },
        { status: 400 },
      );
    }
    return Response.json(
      { error: "Couldn't reach Google Classroom. Please try again." },
      { status: 502 },
    );
  }
}
