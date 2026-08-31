import OpenAI from "openai";
import {
  COURSE_MODULES_MAX,
  COURSE_MODULES_MIN,
  coursePrompt,
  ELIORA_SUMMARY_MODEL,
  type Course,
  type CourseModule,
  type CourseRequest,
  type StudyMaterial,
} from "@eliora/shared";

// Course from your textbook: takes a material digest (already indexed once by
// /api/material) and plans it into a Khan-Academy-style course — ordered
// modules, each grouping a few of the book's own sections into one sitting.
// The heavy file never travels here, only the small digest. Each module's
// actual lesson is built later, on demand, by /api/lesson from just that
// module's sections (courseModuleText). Forced tool call so the plan is
// always structured.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COURSE_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "plan_course",
    description:
      "Return the course plan: ordered modules grouping the digest's sections.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Short, motivating course name.",
        },
        intro: {
          type: "string",
          description: "1–2 sentences: where this course takes the learner.",
        },
        modules: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "Short unit name." },
              goal: {
                type: "string",
                description:
                  'One line: what the learner can DO after this module ("Explain why…", "Solve…").',
              },
              sections: {
                type: "array",
                items: { type: "string" },
                description:
                  "1–4 section titles from the digest, EXACTLY as the digest names them.",
              },
              minutes: {
                type: "integer",
                description: "Rough time for this module, 10–25.",
              },
            },
            required: ["title", "goal", "sections"],
          },
          description: `${COURSE_MODULES_MIN}–${COURSE_MODULES_MAX} modules in learning order, together covering every section once.`,
        },
      },
      required: ["title", "intro", "modules"],
    },
  },
};

const str = (v: unknown) =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

export async function POST(req: Request) {
  let body: CourseRequest;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const material = body.material as StudyMaterial | undefined;
  if (!material?.topics?.length || !str(material.title)) {
    return Response.json(
      { error: "Upload and index some material first — then I can plan a course from it." },
      { status: 200 },
    );
  }

  const overview = str(material.overview) ?? "";
  const terms = Array.isArray(material.terms) ? material.terms : [];
  const digest = `Material: ${material.title}
${overview}

Sections (in the material's order):
${material.topics.map((t) => `- ${t.title}: ${t.summary}`).join("\n")}${
    terms.length
      ? `\n\nTerms it defines: ${terms.map((t) => t.term).join(", ")}`
      : ""
  }`;

  try {
    const client = new OpenAI(); // reads OPENAI_API_KEY; throws if missing
    const completion = await client.chat.completions.create({
      model: ELIORA_SUMMARY_MODEL,
      max_completion_tokens: 2000,
      messages: [
        { role: "system", content: coursePrompt(body.profile) },
        {
          role: "user",
          content: `Plan a course from this digest.\n\n${digest}`,
        },
      ],
      tools: [COURSE_TOOL],
      tool_choice: { type: "function", function: { name: "plan_course" } },
    });
    const call = completion.choices[0]?.message?.tool_calls?.[0];
    const args =
      call && "function" in call
        ? JSON.parse(call.function.arguments || "{}")
        : {};

    // Keep only section titles that actually exist in the digest — a module's
    // sections are used to look the material back up, so an invented title
    // would silently teach from nothing.
    const real = new Map(
      material.topics.map((t) => [t.title.trim().toLowerCase(), t.title]),
    );
    const covered = new Set<string>();
    const modules: CourseModule[] = (Array.isArray(args.modules)
      ? args.modules
      : []
    )
      .filter(
        (m: { title?: unknown; goal?: unknown }) => str(m?.title) && str(m?.goal),
      )
      .slice(0, COURSE_MODULES_MAX)
      .map(
        (
          m: {
            title?: unknown;
            goal?: unknown;
            sections?: unknown;
            minutes?: unknown;
          },
          i: number,
        ) => {
          const sections = (Array.isArray(m.sections) ? m.sections : [])
            .map((s: unknown) => real.get(String(s).trim().toLowerCase()))
            .filter((s): s is string => !!s && !covered.has(s));
          sections.forEach((s) => covered.add(s));
          const minutes =
            typeof m.minutes === "number" && m.minutes >= 5 && m.minutes <= 40
              ? Math.round(m.minutes)
              : 15;
          return {
            id: `cm${i}`,
            title: String(m.title).trim(),
            goal: String(m.goal).trim(),
            sections,
            minutes,
          };
        },
      )
      .filter((m: CourseModule) => m.sections.length > 0);

    // Every section belongs somewhere — sweep any the planner missed into the
    // last module rather than quietly dropping part of the learner's book.
    const missed = material.topics
      .map((t) => t.title)
      .filter((t) => !covered.has(t));
    if (missed.length && modules.length) {
      modules[modules.length - 1].sections.push(...missed);
    }

    if (modules.length < COURSE_MODULES_MIN) {
      return Response.json({
        error:
          "That material is a bit small to split into modules — try the regular lesson instead, or upload a fuller chapter.",
      });
    }

    const course: Course = {
      id: `c${Date.now().toString(36)}`,
      materialId: material.id,
      materialTitle: material.title,
      subject: str(material.subject),
      title: str(args.title) ?? material.title,
      intro: str(args.intro) ?? "",
      modules,
      createdAt: new Date().toISOString().slice(0, 10),
    };
    return Response.json({ course });
  } catch {
    return Response.json(
      { error: "Couldn't plan the course right now — try again." },
      { status: 200 },
    );
  }
}
