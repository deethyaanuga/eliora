import OpenAI from "openai";
import {
  ELIORA_SUMMARY_MODEL,
  fourYearPlanPrompt,
  type CourseLevel,
  type FourYearPlan,
  type LearnerProfile,
} from "@eliora/shared";

// Generates a full year-by-year academic roadmap toward a destination (a college,
// major, or career). Returns { plan: FourYearPlan }. Forces a tool call so the
// output is always a clean structured plan (no model variance about formatting).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAKE_PLAN_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "make_four_year_plan",
    description: "Return the 4-year academic roadmap toward the destination.",
    parameters: {
      type: "object",
      properties: {
        destination: {
          type: "string",
          description: "Where it's all headed — a college, major, or career.",
        },
        years: {
          type: "array",
          description: "Exactly 4 years, in order.",
          items: {
            type: "object",
            properties: {
              label: {
                type: "string",
                description:
                  "Year label, e.g. 'Freshman — Grade 9' or 'Year 1'.",
              },
              courses: {
                type: "array",
                description: "4–7 courses that build toward the destination.",
                items: {
                  type: "object",
                  properties: {
                    title: { type: "string" },
                    note: {
                      type: "string",
                      description: "Short why/level note (optional).",
                    },
                    credits: {
                      type: "number",
                      description: "Credit value toward graduation (e.g. 1, 0.5).",
                    },
                    category: {
                      type: "string",
                      description:
                        "Requirement area it counts toward (English, Math, Science, Social Studies, World Language, PE/Health, Arts, Elective, Career/Technical).",
                    },
                    level: {
                      type: "string",
                      enum: ["Regular", "Honors", "AP/IB", "College"],
                      description:
                        "Course rigor level (feeds weighted GPA). Default Regular; use Honors/AP where it fits.",
                    },
                    grade: {
                      type: "string",
                      description:
                        "Letter grade earned (e.g. 'A', 'B+') — ONLY for courses already completed (from a transcript). Leave empty otherwise.",
                    },
                    done: {
                      type: "boolean",
                      description:
                        "True if the student has ALREADY completed this course (e.g. it appears on an uploaded transcript).",
                    },
                  },
                  required: ["title"],
                },
              },
              milestones: {
                type: "array",
                description:
                  "2–4 key non-course milestones that year (tests, clubs, projects, applications), INCLUDING one checkpoint (checkpoint:true) review/reflection point.",
                items: {
                  type: "object",
                  properties: {
                    title: { type: "string" },
                    checkpoint: {
                      type: "boolean",
                      description:
                        "True for a review/reflection checkpoint (one per year).",
                    },
                  },
                  required: ["title"],
                },
              },
            },
            required: ["label", "courses"],
          },
        },
        requirements: {
          type: "array",
          description:
            "Graduation credit requirements by subject area (use the learner's school requirements if given, else typical US high-school ones).",
          items: {
            type: "object",
            properties: {
              subject: { type: "string" },
              required: {
                type: "number",
                description: "Credits needed in this subject to graduate.",
              },
            },
            required: ["subject", "required"],
          },
        },
        totalRequired: {
          type: "number",
          description: "Total credits needed to graduate.",
        },
      },
      required: ["destination", "years"],
    },
  },
};

type RawCourse = {
  title?: unknown;
  note?: unknown;
  credits?: unknown;
  category?: unknown;
  level?: unknown;
  grade?: unknown;
  done?: unknown;
};

const LEVELS = ["Regular", "Honors", "AP/IB", "College"];
const level = (v: unknown): CourseLevel | undefined => {
  const s = typeof v === "string" ? v.trim() : "";
  return LEVELS.includes(s) ? (s as CourseLevel) : undefined;
};
const grade = (v: unknown): string | undefined => {
  const s = typeof v === "string" ? v.trim().toUpperCase() : "";
  return /^[A-D][+-]?$|^F$/.test(s) ? s : undefined;
};
type RawYear = { label?: unknown; courses?: unknown; milestones?: unknown };
type RawReq = { subject?: unknown; required?: unknown };

type UploadDoc = { base64?: string; mediaType?: string; name?: string };
type FourYearPlanRequest = {
  destination?: string; // the target career (where the roadmap leads)
  classes?: string; // classes the learner is taking now / wants to take
  grade?: string; // current grade/year to anchor the labels
  strengths?: string; // favorite subjects / what they're good at
  interests?: string; // hobbies, clubs, activities
  afterPlan?: string; // after high school: college + major, trade, work…
  notes?: string; // anything else / constraints
  requirements?: string; // pasted graduation credit requirements
  catalog?: string; // pasted course catalog
  docs?: UploadDoc[]; // uploaded school docs (catalog / requirements / transcript)
  profile?: LearnerProfile;
};

const num = (v: unknown): number | undefined =>
  typeof v === "number" && isFinite(v) && v >= 0 ? v : undefined;

// Coerce the model's tool arguments into a clean FourYearPlan.
function normalize(
  args: {
    destination?: unknown;
    years?: unknown;
    requirements?: unknown;
    totalRequired?: unknown;
  },
  fallbackDest: string,
): FourYearPlan {
  const years = (Array.isArray(args.years) ? (args.years as RawYear[]) : [])
    .filter((y) => String(y?.label ?? "").trim())
    .slice(0, 4)
    .map((y) => ({
      label: String(y.label).trim(),
      courses: (Array.isArray(y.courses) ? (y.courses as RawCourse[]) : [])
        .filter((c) => String(c?.title ?? "").trim())
        .map((c) => ({
          title: String(c.title).trim(),
          note: c.note ? String(c.note).trim() || undefined : undefined,
          credits: num(c.credits),
          category: c.category
            ? String(c.category).trim() || undefined
            : undefined,
          level: level(c.level),
          grade: grade(c.grade),
          done: c.done === true || undefined,
        })),
      milestones: (Array.isArray(y.milestones) ? y.milestones : [])
        .map((m: unknown) => {
          if (typeof m === "string") return { title: m.trim() };
          const mm = (m ?? {}) as { title?: unknown; checkpoint?: unknown };
          return {
            title: String(mm.title ?? "").trim(),
            checkpoint: mm.checkpoint === true || undefined,
          };
        })
        .filter((m: { title: string }) => m.title.length > 0),
    }));
  const requirements = (
    Array.isArray(args.requirements) ? (args.requirements as RawReq[]) : []
  )
    .filter((r) => String(r?.subject ?? "").trim() && num(r?.required) != null)
    .map((r) => ({ subject: String(r.subject).trim(), required: num(r.required)! }));
  return {
    destination: String(args.destination ?? fallbackDest ?? "").trim(),
    years,
    requirements: requirements.length ? requirements : undefined,
    totalRequired: num(args.totalRequired),
  };
}

export async function POST(req: Request) {
  let body: FourYearPlanRequest;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const destination = (body.destination ?? "").trim();
  if (!destination) {
    return Response.json({ error: "missing_destination" }, { status: 400 });
  }

  const grade =
    (body.grade ?? "").trim() || (body.profile?.gradeYear ?? "").trim();
  // Classes the learner gave, falling back to what their profile says they study.
  const classes =
    (body.classes ?? "").trim() ||
    (body.profile?.subjectsStudying ?? "").trim() ||
    (body.profile?.klass ?? "").trim();
  const interests =
    (body.interests ?? "").trim() ||
    (body.profile?.interests ?? "").trim() ||
    (body.profile?.hobbies ?? "").trim();
  const detail = [
    `Target career (where this roadmap should lead): ${destination}`,
    classes ? `Classes they're taking now / want to take: ${classes}` : "",
    grade ? `Current grade / year they're starting from: ${grade}` : "",
    (body.strengths ?? "").trim()
      ? `Favorite subjects / strengths: ${body.strengths!.trim()}`
      : "",
    interests ? `Interests, clubs & activities: ${interests}` : "",
    (body.afterPlan ?? "").trim()
      ? `Plan after high school (college/major, trade, or work): ${body.afterPlan!.trim()}`
      : "",
    (body.notes ?? "").trim()
      ? `Other things to consider: ${body.notes!.trim()}`
      : "",
    body.profile?.mainGoal?.trim()
      ? `Main goal: ${body.profile.mainGoal.trim()}`
      : "",
    (body.requirements ?? "").trim()
      ? `THEIR SCHOOL'S GRADUATION CREDIT REQUIREMENTS (use these exact categories/numbers):\n${body.requirements!.trim()}`
      : "",
    (body.catalog ?? "").trim()
      ? `THEIR SCHOOL'S COURSE CATALOG (pick real courses + credit values from this):\n${body.catalog!.trim()}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  // Uploaded school docs (course catalog / graduation requirements / transcript)
  // → attach as file/image/text blocks so the model reads them directly.
  const docs = (Array.isArray(body.docs) ? body.docs : [])
    .filter((d) => d && (d.base64 || "").length)
    .slice(0, 4);
  type UserContent =
    OpenAI.Chat.Completions.ChatCompletionUserMessageParam["content"];
  let userContent: UserContent = detail;
  if (docs.length) {
    const parts: Exclude<UserContent, string> = [
      {
        type: "text",
        text:
          detail +
          "\n\nATTACHED are the learner's real school documents (course catalog, " +
          "graduation credit requirements, and/or transcript). USE THEM as the " +
          "source of truth: pull the exact credit requirements and course names/" +
          "credit values, ALIGN the plan so its credits meet those requirements, " +
          "and if a transcript shows courses already completed, mark those courses " +
          "done (they count as earned credits) and don't re-add them.",
      },
    ];
    for (const d of docs) {
      const media = d.mediaType ?? "";
      if (media === "application/pdf") {
        parts.push({
          type: "file",
          file: {
            filename: d.name || "school-doc.pdf",
            file_data: `data:application/pdf;base64,${d.base64}`,
          },
        });
      } else if (media.startsWith("image/")) {
        parts.push({
          type: "image_url",
          image_url: { url: `data:${media};base64,${d.base64}` },
        });
      } else {
        // Text-ish file — decode and include inline.
        try {
          const text = Buffer.from(d.base64 || "", "base64").toString("utf8");
          if (text.trim())
            parts.push({
              type: "text",
              text: `Document "${d.name || "school-doc"}":\n${text.slice(0, 8000)}`,
            });
        } catch {
          /* skip unreadable */
        }
      }
    }
    userContent = parts;
  }

  try {
    const client = new OpenAI(); // reads OPENAI_API_KEY; throws if missing
    const completion = await client.chat.completions.create({
      model: ELIORA_SUMMARY_MODEL,
      max_completion_tokens: 2500,
      messages: [
        { role: "system", content: fourYearPlanPrompt(body.profile) },
        { role: "user", content: userContent },
      ],
      tools: [MAKE_PLAN_TOOL],
      tool_choice: {
        type: "function",
        function: { name: "make_four_year_plan" },
      },
    });
    const call = completion.choices[0]?.message?.tool_calls?.[0];
    const args =
      call && "function" in call
        ? JSON.parse(call.function.arguments || "{}")
        : {};
    const plan = normalize(args, destination);
    if (!plan.years.length) {
      return Response.json(
        { error: "Couldn't build that roadmap — try again." },
        { status: 200 },
      );
    }
    return Response.json({ plan });
  } catch {
    return Response.json(
      { error: "Couldn't build that roadmap — try again." },
      { status: 200 },
    );
  }
}
