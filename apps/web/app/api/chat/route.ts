import OpenAI from "openai";
import {
  assignmentsContext,
  ELIORA_CHAT_MODEL,
  ELIORA_SYSTEM_PROMPT,
  eventsContext,
  fourYearPlanContext,
  goalsContext,
  planContext,
  profileContext,
  revisionContext,
  subjectsContext,
  type ChatMessage,
  type ChatRequest,
  type FourYearCourse,
} from "@eliora/shared";

// Streams newline-delimited JSON events to the client:
//   {"type":"text","value":"..."}      incremental reply text
//   {"type":"videos","items":[...]}    real YouTube videos to render as cards
//   {"type":"plan","items":[...]}      learning-plan milestones
//   {"type":"event","item":{...}}      a calendar date
//   {"type":"flashcards","items":[...]}
//   {"type":"quiz","items":[...]}
//   {"type":"goal","item":{...}}        a SMART goal to add
//   {"type":"fourYearPlan","item":{...}} the long-term academic roadmap
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EVENT_KINDS = ["exam", "final", "quiz", "assignment", "other"] as const;

// Tools (OpenAI function-calling format) Eliora can call.
const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "search_youtube",
      description:
        "Search YouTube for real study videos on a topic. Returns up to 4 real " +
        "videos. The app shows returned videos to the learner as cards. If it " +
        "returns an error or no results, fall back to a YouTube search link.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Specific search query, e.g. 'algebra linear equations'",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_plan",
      description:
        "Save or update the learner's study plan as 3–6 small milestones. The " +
        "app shows it as a checklist with a progress bar. Always pass the FULL " +
        "updated list. Mark review/quiz steps with checkpoint: true — the app " +
        "shows its own 🚩 Checkpoint badge, so do NOT write the word 'CHECKPOINT' " +
        "or any 🚩 emoji in the title or detail; just set checkpoint: true. Keep " +
        "each title a short, plain phrase (optionally prefixed with the class " +
        "name, e.g. 'Chemistry: balance equations').",
      parameters: {
        type: "object",
        properties: {
          milestones: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                detail: { type: "string" },
                checkpoint: { type: "boolean" },
              },
              required: ["title"],
            },
          },
        },
        required: ["milestones"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_event",
      description:
        "Add an important date to the learner's calendar (exam, final, quiz, " +
        "assignment). Call whenever the learner mentions a specific date.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "What the date is for" },
          date: { type: "string", description: "Date in YYYY-MM-DD format" },
          kind: { type: "string", enum: [...EVENT_KINDS] },
        },
        required: ["title", "date"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "make_flashcards",
      description:
        "Create a deck of flashcards. The app shows them as flip cards. Keep " +
        "fronts short (a term or question) and backs simple.",
      parameters: {
        type: "object",
        properties: {
          cards: {
            type: "array",
            items: {
              type: "object",
              properties: {
                front: { type: "string" },
                back: { type: "string" },
              },
              required: ["front", "back"],
            },
          },
        },
        required: ["cards"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_subject_folder",
      description:
        "Create a folder for a subject/class the student needs help with, to " +
        "keep their study materials organized. Call this once when a new subject " +
        "comes up that doesn't already have a folder. Use a clear subject name " +
        "(e.g. 'AP World History', 'Algebra 1', 'Intro Spanish').",
      parameters: {
        type: "object",
        properties: {
          subject: { type: "string", description: "The subject / class name" },
        },
        required: ["subject"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "make_quiz",
      description:
        "Create a short multiple-choice quiz (3–6 questions). The app grades it " +
        "and remembers what the learner gets wrong so you can revise it.",
      parameters: {
        type: "object",
        properties: {
          questions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                question: { type: "string" },
                options: { type: "array", items: { type: "string" } },
                answerIndex: {
                  type: "integer",
                  description: "0-based index of the correct option",
                },
                explanation: { type: "string" },
                topic: { type: "string" },
              },
              required: ["question", "options", "answerIndex"],
            },
          },
        },
        required: ["questions"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_assignment",
      description:
        "Add a homework assignment to the learner's 'Today's assignments' list. " +
        "Call this whenever they mention something they need to do or turn in " +
        "(e.g. 'I have a bio worksheet due Friday', 'I still need to finish my " +
        "essay'). Use a short clear title; include the subject/class and a due " +
        "date when known. For a graded test/exam/final/quiz, prefer add_event " +
        "instead so it lands on the calendar.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "What needs to be done" },
          subject: { type: "string", description: "Class/subject, if known" },
          due: { type: "string", description: "Due date in YYYY-MM-DD, if known" },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_goal",
      description:
        "Save a SMART goal the learner wants to work toward. Call this when they " +
        "describe something they're aiming for (e.g. 'I want to get a B in " +
        "chemistry', 'pass the AP exam', 'finish my essay by Friday'). Shape it " +
        "into a SMART goal: specific (what), measurable (how they'll know), " +
        "achievable (why it's realistic / a first step), relevant (why it " +
        "matters), and time-bound (a target date). If the measure is a count " +
        "(e.g. 20 practice problems, 5 chapters), set target to that number so " +
        "the app shows a progress bar. Keep it to one clear goal. RIGHT AFTER " +
        "saving it, break the goal into 3–6 small tasks with the save_plan tool, " +
        "share real study videos/links/docs to research those tasks (search_youtube " +
        "+ known sites), and walk the learner through completing them one at a time.",
      parameters: {
        type: "object",
        properties: {
          specific: {
            type: "string",
            description: "The goal itself — what exactly they want to achieve",
          },
          measurable: {
            type: "string",
            description: "How success is measured",
          },
          achievable: {
            type: "string",
            description: "Why it's realistic, or the first concrete step",
          },
          relevant: { type: "string", description: "Why it matters to them" },
          timeBound: {
            type: "string",
            description: "Target date in YYYY-MM-DD",
          },
          subject: { type: "string", description: "Class/subject, if relevant" },
          horizon: {
            type: "string",
            enum: ["short", "mid", "long"],
            description:
              "Time horizon: 'short' (days–weeks), 'mid' (this term / a few months), or 'long' (this year and beyond / after graduation).",
          },
          target: {
            type: "number",
            description: "Numeric target, if the goal is countable",
          },
        },
        required: ["specific"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_four_year_plan",
      description:
        "Save or update the learner's long-term 4-year ACADEMIC ROADMAP — the " +
        "year-by-year classes and milestones leading to a destination (a college, " +
        "major, or career). This is the BIG picture, separate from the short-term " +
        "study plan (save_plan). Call this when the learner wants to map out their " +
        "path across the years, or when they mention a new target school/major or a " +
        "class they've taken or dropped. Always pass the FULL updated roadmap: a " +
        "destination plus up to 4 years, each with its courses and milestones. " +
        "Sequence prerequisites correctly (foundational before advanced).",
      parameters: {
        type: "object",
        properties: {
          destination: {
            type: "string",
            description: "Where it's headed — a college, major, or career.",
          },
          years: {
            type: "array",
            description: "Up to 4 years, in order.",
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
                        description: "Credit value toward graduation (e.g. 1).",
                      },
                      category: {
                        type: "string",
                        description:
                          "Requirement area (English, Math, Science, Social Studies, World Language, PE/Health, Arts, Elective, Career/Technical).",
                      },
                      level: {
                        type: "string",
                        enum: ["Regular", "Honors", "AP/IB", "College"],
                        description:
                          "Course rigor level (feeds weighted GPA). Default Regular.",
                      },
                      grade: {
                        type: "string",
                        description:
                          "Letter grade earned (e.g. 'A', 'B+') — only for completed courses; else empty.",
                      },
                    },
                    required: ["title"],
                  },
                },
                milestones: {
                  type: "array",
                  description:
                    "Key non-course milestones (tests, clubs, projects, applications), incl. one checkpoint (checkpoint:true) review point per year.",
                  items: {
                    type: "object",
                    properties: {
                      title: { type: "string" },
                      checkpoint: { type: "boolean" },
                    },
                    required: ["title"],
                  },
                },
              },
              required: ["label"],
            },
          },
          requirements: {
            type: "array",
            description: "Graduation credit requirements by subject area.",
            items: {
              type: "object",
              properties: {
                subject: { type: "string" },
                required: { type: "number" },
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
  },
];

type Video = { videoId: string; title: string; channel: string; url: string };

async function searchYouTube(
  query: string,
): Promise<Video[] | { error: string }> {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return { error: "youtube_api_key_not_configured" };
  const url =
    "https://www.googleapis.com/youtube/v3/search?part=snippet&type=video" +
    `&maxResults=4&safeSearch=strict&q=${encodeURIComponent(query)}&key=${key}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return { error: `youtube_request_failed_${res.status}` };
    const data = (await res.json()) as {
      items?: Array<{
        id?: { videoId?: string };
        snippet?: { title?: string; channelTitle?: string };
      }>;
    };
    const videos = (data.items ?? [])
      .filter((it) => it.id?.videoId)
      .map((it) => ({
        videoId: it.id!.videoId!,
        title: it.snippet?.title ?? "Untitled",
        channel: it.snippet?.channelTitle ?? "Unknown channel",
        url: `https://www.youtube.com/watch?v=${it.id!.videoId}`,
      }));
    return videos.length ? videos : { error: "no_results" };
  } catch {
    return { error: "youtube_request_error" };
  }
}

function isValid(messages: unknown): messages is ChatMessage[] {
  return (
    Array.isArray(messages) &&
    messages.every(
      (m) =>
        m &&
        typeof m === "object" &&
        (m as ChatMessage).role !== undefined &&
        typeof (m as ChatMessage).content === "string",
    )
  );
}

// Run one tool call, emit any UI event, and return the tool-result text.
async function runTool(
  name: string,
  input: Record<string, unknown>,
  send: (obj: unknown) => void,
): Promise<string> {
  if (name === "search_youtube") {
    const result = await searchYouTube(String(input.query ?? ""));
    if (Array.isArray(result)) send({ type: "videos", items: result });
    return JSON.stringify(result);
  }
  if (name === "save_plan") {
    const raw = (input.milestones as
      | { title?: string; detail?: string; checkpoint?: boolean }[]
      | undefined) ?? [];
    // Strip any 🚩 / "CHECKPOINT —" the model may have written into the text —
    // the app renders its own checkpoint badge, so keep titles clean (and avoid
    // the markers compounding each time the full list is re-saved).
    const clean = (s?: string) =>
      (s ?? "")
        .replace(/🚩/g, "")
        .replace(/\bcheckpoint\s*[—:-]\s*/gi, "")
        .replace(/\s{2,}/g, " ")
        .trim();
    const items = raw
      .filter((m) => clean(m?.title))
      .map((m) => ({
        title: clean(m.title),
        detail: clean(m.detail) || undefined,
        checkpoint: m.checkpoint === true || undefined,
      }));
    send({ type: "plan", items });
    return `Plan saved with ${items.length} milestones.`;
  }
  if (name === "add_event") {
    const title = String(input.title ?? "").trim();
    const date = String(input.date ?? "").trim();
    if (title && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      const kind = EVENT_KINDS.includes(input.kind as (typeof EVENT_KINDS)[number])
        ? (input.kind as string)
        : "other";
      send({
        type: "event",
        item: { id: `${date}__${title.toLowerCase()}`, title, date, kind },
      });
      return `Saved "${title}" on ${date}.`;
    }
    return "Could not save — need a title and a date in YYYY-MM-DD format.";
  }
  if (name === "make_flashcards") {
    const raw = (input.cards as { front?: string; back?: string }[] | undefined) ?? [];
    const items = raw
      .filter((c) => c?.front?.trim() && c?.back?.trim())
      .map((c) => ({ front: c.front!.trim(), back: c.back!.trim() }));
    send({ type: "flashcards", items });
    return `Made ${items.length} flashcards.`;
  }
  if (name === "make_quiz") {
    const raw = (input.questions as
      | {
          question?: string;
          options?: string[];
          answerIndex?: number;
          explanation?: string;
          topic?: string;
        }[]
      | undefined) ?? [];
    const items = raw
      .filter(
        (q) =>
          q?.question?.trim() &&
          Array.isArray(q.options) &&
          q.options.length >= 2 &&
          typeof q.answerIndex === "number",
      )
      .map((q) => ({
        question: q.question!.trim(),
        options: q.options!.map((o) => String(o)),
        answerIndex: q.answerIndex!,
        explanation: q.explanation?.trim() || undefined,
        topic: q.topic?.trim() || undefined,
      }));
    send({ type: "quiz", items });
    return `Made a ${items.length}-question quiz.`;
  }
  if (name === "create_subject_folder") {
    const subject = String(input.subject ?? "").trim();
    if (subject) {
      send({ type: "folder", name: subject });
      return `Created a folder for ${subject}.`;
    }
    return "No subject name was given.";
  }
  if (name === "add_assignment") {
    const title = String(input.title ?? "").trim();
    if (!title) return "No assignment title was given.";
    const subject = input.subject ? String(input.subject).trim() : undefined;
    const dueRaw = typeof input.due === "string" ? input.due.trim() : "";
    const due = /^\d{4}-\d{2}-\d{2}$/.test(dueRaw) ? dueRaw : undefined;
    send({ type: "assignment", item: { title, subject, due } });
    return `Added assignment "${title}"${due ? ` (due ${due})` : ""}.`;
  }
  if (name === "add_goal") {
    const specific = String(input.specific ?? "").trim();
    if (!specific) return "No goal was given.";
    const str = (v: unknown) =>
      typeof v === "string" && v.trim() ? v.trim() : undefined;
    const tbRaw = typeof input.timeBound === "string" ? input.timeBound.trim() : "";
    const timeBound = /^\d{4}-\d{2}-\d{2}$/.test(tbRaw) ? tbRaw : undefined;
    const target =
      typeof input.target === "number" && input.target > 0
        ? Math.round(input.target)
        : undefined;
    const horizon = ["short", "mid", "long"].includes(input.horizon as string)
      ? (input.horizon as string)
      : undefined;
    send({
      type: "goal",
      item: {
        specific,
        measurable: str(input.measurable),
        achievable: str(input.achievable),
        relevant: str(input.relevant),
        subject: str(input.subject),
        horizon,
        timeBound,
        target,
      },
    });
    return `Saved your goal: "${specific}"${timeBound ? ` (by ${timeBound})` : ""}.`;
  }
  if (name === "save_four_year_plan") {
    const destination = String(input.destination ?? "").trim();
    const numOrU = (v: unknown) =>
      typeof v === "number" && isFinite(v) && v >= 0 ? v : undefined;
    const rawYears =
      (input.years as
        | {
            label?: string;
            courses?: {
              title?: string;
              note?: string;
              credits?: number;
              category?: string;
              level?: string;
              grade?: string;
            }[];
            milestones?: unknown[];
          }[]
        | undefined) ?? [];
    const LEVELS = ["Regular", "Honors", "AP/IB", "College"];
    const lvl = (v: unknown): FourYearCourse["level"] => {
      const s = typeof v === "string" ? v.trim() : "";
      return LEVELS.includes(s) ? (s as FourYearCourse["level"]) : undefined;
    };
    const grd = (v: unknown): string | undefined => {
      const s = typeof v === "string" ? v.trim().toUpperCase() : "";
      return /^[A-D][+-]?$|^F$/.test(s) ? s : undefined;
    };
    const years = rawYears
      .filter((y) => (y?.label ?? "").trim())
      .slice(0, 4)
      .map((y) => ({
        label: String(y.label).trim(),
        courses: (Array.isArray(y.courses) ? y.courses : [])
          .filter((c) => (c?.title ?? "").trim())
          .map((c) => ({
            title: String(c.title).trim(),
            note: c.note ? String(c.note).trim() || undefined : undefined,
            credits: numOrU(c.credits),
            category: c.category ? String(c.category).trim() || undefined : undefined,
            level: lvl(c.level),
            grade: grd(c.grade),
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
          .filter((m) => m.title.length > 0),
      }));
    if (!years.length) return "Could not save — need at least one year.";
    const requirements = (
      Array.isArray(input.requirements)
        ? (input.requirements as { subject?: string; required?: number }[])
        : []
    )
      .filter((r) => (r?.subject ?? "").trim() && numOrU(r?.required) != null)
      .map((r) => ({
        subject: String(r.subject).trim(),
        required: numOrU(r.required)!,
      }));
    send({
      type: "fourYearPlan",
      item: {
        destination,
        years,
        requirements: requirements.length ? requirements : undefined,
        totalRequired: numOrU(input.totalRequired),
      },
    });
    return `Saved a ${years.length}-year roadmap toward "${
      destination || "their goal"
    }".`;
  }
  return "Unknown tool.";
}

export async function POST(req: Request) {
  let body: ChatRequest;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  if (!isValid(body.messages) || body.messages.length === 0) {
    return new Response("`messages` must be a non-empty array", { status: 400 });
  }

  const encoder = new TextEncoder();
  const today = new Date().toISOString().slice(0, 10);
  const todayName = new Date(`${today}T00:00:00`).toLocaleDateString("en-US", {
    weekday: "long",
  });
  const system =
    ELIORA_SYSTEM_PROMPT +
    `\n\n## Today's date\nToday is ${todayName}, ${today}. Use this to resolve ` +
    `relative dates yourself (e.g. "next Friday", "in 3 days", "tomorrow") into a ` +
    `YYYY-MM-DD date — do NOT ask the learner for the exact date.` +
    profileContext(body.profile) +
    planContext(body.plan) +
    eventsContext(body.events, today) +
    assignmentsContext(body.assignments, today) +
    goalsContext(body.goals, today) +
    fourYearPlanContext(body.fourYearPlan) +
    revisionContext(body.missed) +
    subjectsContext(body.subjects);

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: system },
    ...body.messages.map((m) => ({ role: m.role, content: m.content })),
  ];

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) =>
        controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));

      try {
        const client = new OpenAI(); // reads OPENAI_API_KEY; throws if missing
        // Tool-use loop: stream text each turn; if Eliora calls tools, run them,
        // feed results back, and continue. Capped to avoid loops.
        for (let i = 0; i < 5; i++) {
          const completion = await client.chat.completions.create({
            model: ELIORA_CHAT_MODEL,
            max_completion_tokens: 2000,
            messages,
            tools: TOOLS,
            stream: true,
          });

          let assistantText = "";
          const calls: { id: string; name: string; args: string }[] = [];

          for await (const chunk of completion) {
            const delta = chunk.choices[0]?.delta;
            if (delta?.content) {
              assistantText += delta.content;
              send({ type: "text", value: delta.content });
            }
            for (const tc of delta?.tool_calls ?? []) {
              const idx = tc.index;
              calls[idx] ??= { id: "", name: "", args: "" };
              if (tc.id) calls[idx].id = tc.id;
              if (tc.function?.name) calls[idx].name += tc.function.name;
              if (tc.function?.arguments) calls[idx].args += tc.function.arguments;
            }
          }

          if (calls.length === 0) break; // no tools requested — done

          messages.push({
            role: "assistant",
            content: assistantText || null,
            tool_calls: calls.map((c) => ({
              id: c.id,
              type: "function",
              function: { name: c.name, arguments: c.args || "{}" },
            })),
          });

          for (const c of calls) {
            let input: Record<string, unknown> = {};
            try {
              input = JSON.parse(c.args || "{}");
            } catch {
              /* leave empty */
            }
            const result = await runTool(c.name, input, send);
            messages.push({
              role: "tool",
              tool_call_id: c.id,
              content: result,
            });
          }
        }
        controller.close();
      } catch (err) {
        const status =
          err instanceof OpenAI.APIError ? ` (${err.status})` : "";
        send({
          type: "text",
          value: `\n\n[Eliora ran into a problem${status}. Please try again.]`,
        });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
    },
  });
}
