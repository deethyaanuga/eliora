import OpenAI from "openai";
import { ELIORA_SUMMARY_MODEL, type CourseLevel } from "@eliora/shared";

// Reads an uploaded transcript / report card (PDF, image, or text) and pulls out
// the courses the student has ALREADY completed, with their letter grades — so
// they land straight in the 4-year plan's GPA calculator instead of being typed
// in by hand. Returns { courses: [{ title, grade, credits?, level? }] }. Forces
// a tool call so the shape is always clean.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EXTRACT_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "extract_grades",
    description:
      "Return every completed course with a letter grade found on the uploaded " +
      "transcript / report card.",
    parameters: {
      type: "object",
      properties: {
        courses: {
          type: "array",
          description:
            "One entry per completed, graded course. Skip in-progress courses " +
            "with no final grade, GPA summary rows, and non-course lines.",
          items: {
            type: "object",
            properties: {
              title: {
                type: "string",
                description: "Course name exactly as written on the document.",
              },
              grade: {
                type: "string",
                description:
                  "Final letter grade (A+, A, A-, B+ … F). Convert a percentage " +
                  "to the matching letter (93+ = A, 90–92 = A-, 87–89 = B+, …). " +
                  "Leave empty if there is no final grade.",
              },
              credits: {
                type: "number",
                description:
                  "Credit value if the document lists one (e.g. 1, 0.5).",
              },
              level: {
                type: "string",
                enum: ["Regular", "Honors", "AP/IB", "College"],
                description:
                  "Rigor if the title makes it clear (AP/IB/Honors/Dual-credit); " +
                  "otherwise omit.",
              },
            },
            required: ["title", "grade"],
          },
        },
      },
      required: ["courses"],
    },
  },
};

const LEVELS = ["Regular", "Honors", "AP/IB", "College"];
const toLevel = (v: unknown): CourseLevel | undefined => {
  const s = typeof v === "string" ? v.trim() : "";
  return LEVELS.includes(s) ? (s as CourseLevel) : undefined;
};
const toGrade = (v: unknown): string | undefined => {
  const s = typeof v === "string" ? v.trim().toUpperCase() : "";
  return /^[A-D][+-]?$|^F$/.test(s) ? s : undefined;
};
const toNum = (v: unknown): number | undefined =>
  typeof v === "number" && isFinite(v) && v >= 0 ? v : undefined;

type UploadDoc = { base64?: string; mediaType?: string; name?: string };
type ExtractRequest = {
  docs?: UploadDoc[]; // uploaded transcript / report card
  text?: string; // pasted grades, as an alternative to a file
  courseTitles?: string[]; // titles already in the plan (helps the model match)
};

type RawCourse = {
  title?: unknown;
  grade?: unknown;
  credits?: unknown;
  level?: unknown;
};

export async function POST(req: Request) {
  let body: ExtractRequest;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const docs = (Array.isArray(body.docs) ? body.docs : [])
    .filter((d) => d && (d.base64 || "").length)
    .slice(0, 4);
  const pasted = (body.text ?? "").trim();
  if (!docs.length && !pasted) {
    return Response.json({ error: "missing_input" }, { status: 400 });
  }

  const known = (Array.isArray(body.courseTitles) ? body.courseTitles : [])
    .map((t) => String(t ?? "").trim())
    .filter(Boolean)
    .slice(0, 60);
  const intro =
    "You are reading a student's transcript or report card. Extract EVERY course " +
    "that has a final letter grade, exactly as titled, and return them via the " +
    "tool. Ignore GPA/credit summary rows and courses still in progress." +
    (known.length
      ? "\n\nThe student's plan already lists these courses — when a course on the " +
        "document is clearly the same one, use the plan's exact title so it matches:\n- " +
        known.join("\n- ")
      : "") +
    (pasted ? `\n\nPasted grades:\n${pasted}` : "");

  type UserContent =
    OpenAI.Chat.Completions.ChatCompletionUserMessageParam["content"];
  let userContent: UserContent = intro;
  if (docs.length) {
    const parts: Exclude<UserContent, string> = [{ type: "text", text: intro }];
    for (const d of docs) {
      const media = d.mediaType ?? "";
      if (media === "application/pdf") {
        parts.push({
          type: "file",
          file: {
            filename: d.name || "transcript.pdf",
            file_data: `data:application/pdf;base64,${d.base64}`,
          },
        });
      } else if (media.startsWith("image/")) {
        parts.push({
          type: "image_url",
          image_url: { url: `data:${media};base64,${d.base64}` },
        });
      } else {
        try {
          const text = Buffer.from(d.base64 || "", "base64").toString("utf8");
          if (text.trim())
            parts.push({
              type: "text",
              text: `Document "${d.name || "transcript"}":\n${text.slice(0, 8000)}`,
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
      max_completion_tokens: 2000,
      messages: [{ role: "user", content: userContent }],
      tools: [EXTRACT_TOOL],
      tool_choice: { type: "function", function: { name: "extract_grades" } },
    });
    const call = completion.choices[0]?.message?.tool_calls?.[0];
    const args =
      call && "function" in call
        ? JSON.parse(call.function.arguments || "{}")
        : {};
    const courses = (Array.isArray(args.courses) ? (args.courses as RawCourse[]) : [])
      .map((c) => ({
        title: String(c?.title ?? "").trim(),
        grade: toGrade(c?.grade),
        credits: toNum(c?.credits),
        level: toLevel(c?.level),
      }))
      .filter((c) => c.title && c.grade)
      .slice(0, 60);
    return Response.json({ courses });
  } catch {
    return Response.json(
      { error: "Couldn't read those grades — try a clearer file." },
      { status: 200 },
    );
  }
}
