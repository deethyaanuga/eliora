import OpenAI from "openai";
import {
  assignmentsContext,
  ELIORA_CHAT_MODEL,
  ELIORA_SYSTEM_PROMPT,
  ELIORA_VOICE_INSTRUCTIONS,
  eventsContext,
  fourYearPlanContext,
  goalsContext,
  LESSON_VISUAL_GUIDE,
  LESSON_VISUAL_SCHEMA,
  materialContext,
  mistakesContext,
  normalizeFlashcardStyle,
  parseLessonVisual,
  planContext,
  profileContext,
  revisionContext,
  subjectsContext,
  tutorContext,
  type ChatAttachment,
  type ChatMessage,
  type ChatRequest,
  type FourYearCourse,
} from "@eliora/shared";
import { findExamples, saveExample } from "@/lib/examples";

// Streams newline-delimited JSON events to the client:
//   {"type":"text","value":"..."}      incremental reply text
//   {"type":"status","value":"..."}     what Eliora is doing right now (tool runs)
//   {"type":"videos","items":[...]}    real YouTube videos to render as cards
//   {"type":"socials","items":[...]}   short-form study recs (open a platform search)
//   {"type":"resources","items":[...]} non-video study resources (sites, books, practice)
//   {"type":"plan","items":[...]}      learning-plan milestones
//   {"type":"event","item":{...}}      a calendar date
//   {"type":"flashcards","items":[...]}
//   {"type":"quiz","items":[...]}
//   {"type":"goal","item":{...}}        a SMART goal to add
//   {"type":"mistake","item":{...}}     a concept for the mistake tracker
//   {"type":"fourYearPlan","item":{...}} the long-term academic roadmap
//   {"type":"examples","items":[...]}  anonymized peer examples (how others solved it)
//   {"type":"visual","item":{...}}     a diagram to draw beside the explanation
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Only this many of the most recent messages go to the model — the profile,
// plan, calendar, and goals all travel in the system prompt, so old chat turns
// add cost without adding much context.
const MAX_HISTORY = 40;

// Friendly one-liners shown in the chat bubble while a tool runs.
const TOOL_STATUS: Record<string, string> = {
  search_youtube: "Searching YouTube for real videos…",
  recommend_socials: "Finding creators on TikTok, YouTube & Instagram…",
  recommend_resources: "Picking out study resources for you…",
  fetch_link: "Reading that link…",
  save_plan: "Updating your plan…",
  add_event: "Adding it to your calendar…",
  make_flashcards: "Making your flashcards…",
  make_quiz: "Building your quiz…",
  create_subject_folder: "Creating a subject folder…",
  add_assignment: "Adding your assignment…",
  add_goal: "Saving your goal…",
  log_mistake: "Noting that for your review list…",
  save_four_year_plan: "Updating your roadmap…",
  draw_visual: "Sketching a diagram…",
  find_student_examples: "Looking at how other students solved this…",
  save_student_example: "Saving this to help other students…",
};

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
      name: "recommend_socials",
      description:
        "Recommend short-form study content across TikTok, YouTube (Shorts), " +
        "and Instagram Reels for a topic. Use this when the learner wants quick, " +
        "bite-sized explainers or asks about TikTok/Instagram/short videos, or " +
        "alongside longer YouTube videos for variety. You do NOT get real clips " +
        "back — instead, for each item give the platform and a specific thing to " +
        "search for (a search phrase, a well-known educational creator, or a " +
        "hashtag); the app turns each into a card that opens that platform's " +
        "search. Return 3–6 items spread across at least two platforms. Keep " +
        "each 'query' concrete (e.g. 'photosynthesis explained', '@mathsorcerer', " +
        "'#apbiology'). Favor reputable, school-appropriate creators.",
      parameters: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            description: "The subject/topic these recommendations are for",
          },
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                platform: {
                  type: "string",
                  enum: ["youtube", "tiktok", "instagram"],
                },
                query: {
                  type: "string",
                  description:
                    "What to search for on that platform: a phrase, @creator, or #hashtag",
                },
                note: {
                  type: "string",
                  description: "Short reason it helps (one line)",
                },
              },
              required: ["platform", "query"],
            },
          },
        },
        required: ["items"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "recommend_resources",
      description:
        "Recommend study resources for a topic that are NOT video: websites, " +
        "books/textbooks, practice problem sets, articles, free courses, and " +
        "tools (e.g. Khan Academy, Desmos, OpenStax, Paul's Online Math Notes, " +
        "a chapter of the learner's own textbook). Use this when the learner " +
        "asks what to read/use/practice with, wants something beyond videos, or " +
        "is stuck and would benefit from a reference. The app shows each one as " +
        "a card. Return 2–5 items, mixing kinds where it helps. Only fill in " +
        "'url' when you are certain of a well-known, stable page (usually a " +
        "site's homepage, e.g. https://www.khanacademy.org) — never guess at a " +
        "deep link; leave it out and the app makes the card open a web search " +
        "instead. Favor free and school-appropriate resources.",
      parameters: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            description: "The subject/topic these recommendations are for",
          },
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: {
                  type: "string",
                  description:
                    "Name of the resource, e.g. 'Khan Academy: Systems of Equations' " +
                    "or 'OpenStax College Algebra, Ch. 7'",
                },
                kind: {
                  type: "string",
                  enum: ["site", "book", "practice", "article", "course", "tool"],
                },
                note: {
                  type: "string",
                  description:
                    "One line on what it's good for and how to use it",
                },
                url: {
                  type: "string",
                  description:
                    "Optional. Only a well-known, stable http(s) page you are " +
                    "sure of. Omit rather than guess.",
                },
              },
              required: ["title", "kind"],
            },
          },
        },
        required: ["items"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_link",
      description:
        "Fetch a web page and return its readable text. Call this whenever the " +
        "learner shares a URL (an article, study guide, assignment page, etc.) " +
        "or asks about a specific link, so you can read it before answering. " +
        "Works for public http(s) pages only; if it returns an error, say you " +
        "couldn't open the page and ask them to paste the relevant part.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "Full URL to fetch, e.g. 'https://example.com/article'",
          },
        },
        required: ["url"],
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
        "fronts short and backs simple. Each card has a \"style\": \"basic\" " +
        "(front=term, back=definition), \"reversed\" (front=definition, " +
        "back=term), \"qa\" (front=question, back=answer), \"cloze\" (front=a " +
        'sentence with the key word blanked as "____", back=the missing word), ' +
        "or \"example\" (front=concept, back=a worked example). If the learner " +
        "asked for a specific style, use it for every card; otherwise pick what " +
        "fits each fact — mixing styles is good.",
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
                style: {
                  type: "string",
                  enum: ["basic", "reversed", "qa", "cloze", "example"],
                },
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
      name: "log_mistake",
      description:
        "Record a specific concept or skill the learner just got wrong, or " +
        "revealed a real misconception about, onto their mistake tracker for " +
        "targeted review later. Call this when you catch a GENUINE, specific " +
        "misunderstanding in their answer or reasoning — not for tiny slips, " +
        "typos, or things they self-correct. One call per distinct concept.",
      parameters: {
        type: "object",
        properties: {
          concept: {
            type: "string",
            description:
              "The specific concept/skill they're missing, e.g. 'Balancing redox equations' or 'Subject–verb agreement'.",
          },
          subject: {
            type: "string",
            description: "The class/subject it belongs to, e.g. 'Chemistry'.",
          },
          why: {
            type: "string",
            description:
              "The misconception — what they got wrong or believe incorrectly, in a short phrase.",
          },
          fix: {
            type: "string",
            description: "The correct idea, in one plain sentence.",
          },
        },
        required: ["concept"],
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
  {
    type: "function",
    function: {
      name: "draw_visual",
      description:
        "Draw a diagram beside your explanation. Call this the moment you " +
        "realize what you're about to explain has SHAPE — an order, a " +
        "contrast, a split, a loop, a chronology, a branching, or an " +
        "equation — and call it BEFORE you write the explanation out, so the " +
        "picture is already on screen while the learner reads. The app draws " +
        "it as a clean diagram, so do NOT re-describe the diagram in words " +
        "or draw it with text/ASCII; just teach, and let the picture carry " +
        "the structure. At most one per reply. Skip it entirely for chit-" +
        "chat, encouragement, a single fact, or anything with no structure " +
        "worth drawing — a pointless diagram is worse than none.\n" +
        LESSON_VISUAL_GUIDE,
      parameters: LESSON_VISUAL_SCHEMA,
    },
  },
  {
    type: "function",
    function: {
      name: "find_student_examples",
      description:
        "Search the bank of ANONYMIZED examples from other students for how peers " +
        "worked through a similar problem or concept. Call this when the learner " +
        "is stuck on a specific problem/topic and a parallel example would help. " +
        "Returns up to a few matches; the app shows them to the learner as small " +
        "'how another student tackled this' cards, so don't re-list them as text — " +
        "weave the useful idea into your next hint. These are anonymous parallel " +
        "examples to spark the learner's OWN next step, never the finished answer " +
        "to copy. If it returns no matches, just coach them normally.",
      parameters: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            description:
              "The problem or concept to find peer examples for, e.g. 'solving two-step equations' or 'balancing chemical equations'.",
          },
          subject: {
            type: "string",
            description: "The class/subject to scope the search to, if known.",
          },
        },
        required: ["topic"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_student_example",
      description:
        "After you've helped THIS learner genuinely work through a problem, save a " +
        "short, FULLY ANONYMIZED write-up of it so the next student stuck on the " +
        "same thing can benefit. Strip anything identifying — no names, no personal " +
        "details, no specifics that point back to one person. Capture the subject, " +
        "the topic, the kind of problem, and the approach/steps that helped.",
      parameters: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            description: "What it's about, e.g. 'solving two-step equations'.",
          },
          problem: {
            type: "string",
            description:
              "The kind of problem the student was stuck on (generalized, not their exact personal wording).",
          },
          approach: {
            type: "string",
            description:
              "The approach or steps that helped them work through it, in a sentence or two.",
          },
          subject: { type: "string", description: "Class/subject, if known." },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "A few keywords to help match this example later.",
          },
        },
        required: ["topic", "problem", "approach"],
      },
    },
  },
];

type Video = { videoId: string; title: string; channel: string; url: string };

// Short-form recommendations across platforms. TikTok and Instagram have no
// free public search API, so — unlike YouTube — we don't fetch real clips.
// Instead the model recommends WHAT to look up (a search phrase, creator, or
// hashtag) per platform and we hand back a native deep-link the learner can
// open. This mirrors the YouTube "fallback search link" behavior below.
type SocialPlatform = "youtube" | "tiktok" | "instagram";
type SocialRec = {
  platform: SocialPlatform;
  title: string; // what to search for / creator / hashtag
  note?: string; // one line on why it helps
  url: string;
};

function buildSocialUrl(platform: SocialPlatform, query: string): string {
  const q = encodeURIComponent(query.trim());
  switch (platform) {
    case "tiktok":
      return `https://www.tiktok.com/search?q=${q}`;
    case "instagram":
      return `https://www.instagram.com/explore/search/keyword/?q=${q}`;
    case "youtube":
    default:
      // Bias toward short-form study clips.
      return `https://www.youtube.com/results?search_query=${encodeURIComponent(
        query.trim() + " shorts",
      )}`;
  }
}

// Non-video study resources (sites, books, practice sets, articles, courses,
// tools). The model is told to supply a url ONLY for pages it's sure of, since
// a made-up deep link is worse than no link — anything missing or malformed
// becomes a web search for the resource, which always resolves to something.
type ResourceKind =
  | "site"
  | "book"
  | "practice"
  | "article"
  | "course"
  | "tool";
type ResourceRec = {
  kind: ResourceKind;
  title: string;
  note?: string;
  url: string;
  searched?: boolean; // url is a search, not the resource itself
};

function safeResourceUrl(raw: unknown): string | null {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

// Telling the model "don't guess at deep links" isn't enough — it still returns
// plausible-looking paths that 404 (a dead link is the worst thing to hand a
// stuck learner), so we actually check before showing the card. Deliberately
// conservative: only a definitive 404/410 or a failed request counts as dead,
// because plenty of sites answer a bot's HEAD with 403 while the page is fine.
async function resourceUrlIsLive(url: string): Promise<boolean> {
  const check = async (method: "HEAD" | "GET") => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const res = await fetch(url, {
        method,
        redirect: "follow",
        signal: ctrl.signal,
        headers: { "user-agent": "Mozilla/5.0 (compatible; Eliora/1.0)" },
      });
      return res.status;
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    let status = await check("HEAD");
    // Some servers don't implement HEAD — re-ask with GET before judging.
    if (status === 405 || status === 501) status = await check("GET");
    return status !== 404 && status !== 410;
  } catch {
    return false; // DNS failure, timeout, bad host — don't hand it over.
  }
}

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

// How much page text the model gets — enough for an article, small enough to
// not blow up the context window.
const FETCH_MAX_CHARS = 8000;

// Hosts a server-side fetch must never reach (the request runs from our
// server, so a learner-supplied URL could otherwise probe the local network).
function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h.endsWith(".internal") ||
    h === "0.0.0.0" ||
    h === "[::1]" ||
    h === "::1" ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    /^169\.254\./.test(h) // link-local / cloud metadata
  );
}

// Crude but dependency-free HTML → readable text.
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n\s*\n\s*/g, "\n\n")
    .trim();
}

async function fetchLink(
  rawUrl: string,
): Promise<{ url: string; title?: string; text: string } | { error: string }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { error: "invalid_url" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { error: "only_http_and_https_urls_are_supported" };
  }
  if (isBlockedHost(url.hostname)) {
    return { error: "host_not_allowed" };
  }
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; ElioraBot/1.0)",
        Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
      },
    });
    if (!res.ok) return { error: `request_failed_${res.status}` };
    const type = res.headers.get("content-type") ?? "";
    if (!/text\/|html|xml|json/i.test(type)) {
      return { error: "not_a_text_page" };
    }
    const raw = await res.text();
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i
      .exec(raw)?.[1]
      ?.trim()
      .slice(0, 200);
    const text = /html|xml/i.test(type) ? htmlToText(raw) : raw.trim();
    if (!text) return { error: "page_had_no_readable_text" };
    return {
      url: url.toString(),
      title: title || undefined,
      text:
        text.length > FETCH_MAX_CHARS
          ? text.slice(0, FETCH_MAX_CHARS) + "\n\n[…truncated]"
          : text,
    };
  } catch (err) {
    return {
      error:
        err instanceof Error && err.name === "TimeoutError"
          ? "request_timed_out"
          : "request_error",
    };
  }
}

function isValidAttachment(a: unknown): a is ChatAttachment {
  if (!a || typeof a !== "object") return false;
  const at = a as Record<string, unknown>;
  return (
    (at.kind === "image" || at.kind === "video" || at.kind === "file") &&
    typeof at.name === "string" &&
    typeof at.mime === "string" &&
    (at.dataUrl === undefined || typeof at.dataUrl === "string") &&
    (at.text === undefined || typeof at.text === "string") &&
    (at.note === undefined || typeof at.note === "string")
  );
}

function isValid(messages: unknown): messages is ChatMessage[] {
  return (
    Array.isArray(messages) &&
    messages.every(
      (m) =>
        m &&
        typeof m === "object" &&
        // Only chat roles — a client must not be able to smuggle in a
        // "system" (or other privileged) message.
        ((m as ChatMessage).role === "user" ||
          (m as ChatMessage).role === "assistant") &&
        typeof (m as ChatMessage).content === "string" &&
        ((m as ChatMessage).attachments === undefined ||
          (Array.isArray((m as ChatMessage).attachments) &&
            (m as ChatMessage).attachments!.every(isValidAttachment))),
    )
  );
}

// How much extracted file text the model gets per attachment.
const ATTACH_TEXT_MAX = 12_000;
// Data URLs must be real base64 images — reject anything a client might smuggle
// in (e.g. an SVG with script, or a non-image scheme) before it reaches vision.
const SAFE_IMAGE_DATA_URL = /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=\s]+$/;

// Turn a chat message into an OpenAI content value. Plain messages stay a
// string; a user message that carries attachments becomes a multi-part content
// array (text + image parts) so the vision model can see photos and video
// frames. `withImages` is false for older turns so we don't resend heavy image
// payloads on every follow-up.
function toContent(
  m: ChatMessage,
  withImages: boolean,
): OpenAI.Chat.Completions.ChatCompletionUserMessageParam["content"] {
  const atts = m.attachments ?? [];
  if (m.role !== "user" || atts.length === 0) return m.content;

  const parts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
  if (m.content.trim()) parts.push({ type: "text", text: m.content });

  for (const a of atts) {
    const isImage = a.kind === "image" || a.kind === "video";
    if (isImage && withImages && a.dataUrl && SAFE_IMAGE_DATA_URL.test(a.dataUrl)) {
      if (a.kind === "video") {
        parts.push({
          type: "text",
          text: `[Still frame from the video "${a.name}"${a.note ? ` — ${a.note}` : ""}]`,
        });
      }
      parts.push({ type: "image_url", image_url: { url: a.dataUrl, detail: "auto" } });
    } else if (a.kind === "file" && a.text && a.text.trim()) {
      const body = a.text.slice(0, ATTACH_TEXT_MAX);
      parts.push({
        type: "text",
        text:
          `[Attached file "${a.name}"${a.text.length > ATTACH_TEXT_MAX ? " (truncated)" : ""}]\n` +
          body,
      });
    } else {
      // Something the model can't read (an old image dropped to save tokens, a
      // PDF, a raw video) — leave a short note so it can respond sensibly.
      parts.push({
        type: "text",
        text: `[Attached ${a.kind}: "${a.name}"${a.note ? ` — ${a.note}` : ""}]`,
      });
    }
  }

  return parts.length ? parts : m.content;
}

// Run one tool call, emit any UI event, and return the tool-result text.
async function runTool(
  name: string,
  input: Record<string, unknown>,
  send: (obj: unknown) => void,
): Promise<string> {
  if (name === "search_youtube") {
    const query = String(input.query ?? "").trim();
    const result = await searchYouTube(query);
    if (Array.isArray(result)) {
      send({ type: "videos", items: result });
      return JSON.stringify(result);
    }
    // No API key / API failure — hand the model a ready-made search link so it
    // can share that instead of apologizing about an error.
    const link = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    return JSON.stringify({
      ...result,
      fallback:
        "Video lookup is unavailable, but do NOT tell the learner there was " +
        `an error — just share this YouTube search link instead: ${link}`,
    });
  }
  if (name === "recommend_socials") {
    const raw = (input.items as
      | { platform?: string; query?: string; note?: string }[]
      | undefined) ?? [];
    const valid = new Set<SocialPlatform>(["youtube", "tiktok", "instagram"]);
    const seen = new Set<string>();
    const items: SocialRec[] = [];
    for (const it of raw) {
      const platform = String(it?.platform ?? "").trim() as SocialPlatform;
      const query = String(it?.query ?? "").trim();
      if (!valid.has(platform) || !query) continue;
      const dedupe = `${platform}:${query.toLowerCase()}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      items.push({
        platform,
        title: query,
        note: it?.note ? String(it.note).trim() : undefined,
        url: buildSocialUrl(platform, query),
      });
    }
    if (items.length) send({ type: "socials", items });
    return JSON.stringify(
      items.length
        ? { recommendations: items }
        : {
            error: "no_recommendations",
            note:
              "Give the learner a few concrete things to search for on TikTok, " +
              "YouTube Shorts, or Instagram instead.",
          },
    );
  }
  if (name === "recommend_resources") {
    const topic = String(input.topic ?? "").trim();
    const raw = (input.items as
      | { title?: string; kind?: string; note?: string; url?: string }[]
      | undefined) ?? [];
    const valid = new Set<ResourceKind>([
      "site",
      "book",
      "practice",
      "article",
      "course",
      "tool",
    ]);
    const seen = new Set<string>();
    const items: ResourceRec[] = [];
    for (const it of raw) {
      const title = String(it?.title ?? "").trim();
      const kindRaw = String(it?.kind ?? "").trim() as ResourceKind;
      if (!title) continue;
      const kind = valid.has(kindRaw) ? kindRaw : "site";
      const dedupe = title.toLowerCase();
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      items.push({
        kind,
        title,
        note: it?.note ? String(it.note).trim() : undefined,
        url: safeResourceUrl(it?.url) ?? "",
      });
    }
    // Check the supplied links together rather than one at a time, then swap
    // any dead one for a search so every card still leads somewhere useful.
    await Promise.all(
      items.map(async (item) => {
        if (item.url && (await resourceUrlIsLive(item.url))) return;
        item.url = `https://www.google.com/search?q=${encodeURIComponent(
          topic ? `${item.title} ${topic}` : item.title,
        )}`;
        item.searched = true;
      }),
    );
    if (items.length) send({ type: "resources", items });
    return JSON.stringify(
      items.length
        ? { recommendations: items }
        : {
            error: "no_recommendations",
            note:
              "Name a couple of trusted study resources for the topic in your " +
              "reply instead.",
          },
    );
  }
  if (name === "fetch_link") {
    const result = await fetchLink(String(input.url ?? "").trim());
    if ("error" in result) {
      return JSON.stringify({
        ...result,
        note:
          "Could not read the page. Tell the learner you couldn't open the " +
          "link and ask them to paste the part they want help with.",
      });
    }
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
    const raw =
      (input.cards as
        | { front?: string; back?: string; style?: string }[]
        | undefined) ?? [];
    const items = raw
      .filter((c) => c?.front?.trim() && c?.back?.trim())
      .map((c) => ({
        front: c.front!.trim(),
        back: c.back!.trim(),
        style: normalizeFlashcardStyle(c.style),
      }));
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
  if (name === "draw_visual") {
    const visual = parseLessonVisual(input);
    if (!visual) {
      // Tell the model what went wrong so it can teach without the picture
      // rather than stalling or apologizing to the learner about it.
      return (
        "That diagram didn't fit any shape the app can draw (check 'kind' and " +
        "that you gave enough items). Don't mention this — just explain it in " +
        "words."
      );
    }
    send({ type: "visual", item: visual });
    return `Drew a ${visual.kind} diagram. It's on screen — teach around it, don't describe it.`;
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
  if (name === "log_mistake") {
    const concept = String(input.concept ?? "").trim();
    if (!concept) return "No concept was given.";
    const str = (v: unknown) =>
      typeof v === "string" && v.trim() ? v.trim() : undefined;
    send({
      type: "mistake",
      item: {
        concept,
        subject: str(input.subject),
        why: str(input.why),
        fix: str(input.fix),
        source: "chat",
      },
    });
    return `Logged "${concept}" to the mistake tracker.`;
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
  if (name === "find_student_examples") {
    const topic = String(input.topic ?? "").trim();
    const subject =
      typeof input.subject === "string" ? input.subject.trim() : undefined;
    if (!topic) return "No topic was given.";
    const examples = await findExamples(topic, subject || undefined);
    if (!examples.length) {
      return JSON.stringify({
        examples: [],
        note:
          "No peer examples matched — don't mention a lookup happened, just " +
          "coach the learner normally with your own hint or a parallel example.",
      });
    }
    send({ type: "examples", items: examples });
    return JSON.stringify({
      examples,
      note:
        "The app is showing these anonymized peer examples to the learner as " +
        "cards. Do NOT re-list them as text — weave one helpful idea into your " +
        "next hint, and keep it a nudge, not the finished answer.",
    });
  }
  if (name === "save_student_example") {
    const saved = await saveExample({
      topic: input.topic,
      problem: input.problem,
      approach: input.approach,
      subject: input.subject,
      tags: input.tags,
    });
    if (!saved) {
      return "Not saved — need a topic, the kind of problem, and the approach that helped.";
    }
    return `Saved an anonymized example on "${saved.topic}" for other students.`;
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
    `\n\n## Attachments\nThe learner can attach photos, files, and videos. Photos ` +
    `(and a still frame pulled from a video) are given to you as images — read them ` +
    `carefully: they're usually a worksheet, textbook page, notes, or a problem they ` +
    `need help with. Text files arrive as "[Attached file …]" blocks. For anything ` +
    `marked as unreadable (e.g. a PDF or raw video), don't pretend to see it — say ` +
    `what you'd need (a photo/screenshot, or the pasted text) to help.` +
    tutorContext(body.tutor) +
    materialContext(body.material) +
    profileContext(body.profile) +
    planContext(body.plan) +
    eventsContext(body.events, today) +
    assignmentsContext(body.assignments, today) +
    goalsContext(body.goals, today) +
    fourYearPlanContext(body.fourYearPlan) +
    revisionContext(body.missed) +
    mistakesContext(body.mistakes) +
    subjectsContext(body.subjects) +
    // Last, so it wins where it contradicts the written-chat guidance above.
    (body.voice ? ELIORA_VOICE_INSTRUCTIONS : "");

  // Attach image data only for the most recent turns — resending heavy base64
  // photos on every follow-up would balloon cost and hit context limits.
  const IMAGE_TURNS = 6;
  const recent = body.messages.slice(-MAX_HISTORY);
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: system },
    ...recent.map((m, i) =>
      m.role === "user"
        ? {
            role: "user" as const,
            content: toContent(m, i >= recent.length - IMAGE_TURNS),
          }
        : { role: m.role, content: m.content },
    ),
  ];

  // Create a (streaming) completion, retrying once on transient failures
  // (rate limits, 5xx, dropped connections) so a blip doesn't kill the reply.
  async function createCompletion(
    client: OpenAI,
    params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
    signal: AbortSignal,
  ) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await client.chat.completions.create(params, { signal });
      } catch (err) {
        const status = err instanceof OpenAI.APIError ? err.status : undefined;
        const transient =
          status === undefined || status === 429 || status >= 500;
        if (signal.aborted || !transient || attempt >= 2) throw err;
        await new Promise((r) => setTimeout(r, 800));
      }
    }
  }

  // Aborts the upstream OpenAI request when the client disconnects.
  const upstream = new AbortController();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
        } catch {
          /* client already disconnected — nothing to do */
        }
      };

      try {
        const client = new OpenAI(); // reads OPENAI_API_KEY; throws if missing
        // Tool-use loop: stream text each turn; if Eliora calls tools, run them,
        // feed results back, and continue. Capped to avoid loops.
        let answered = false;
        let streamedAny = false; // any visible text sent to the learner yet?
        for (let i = 0; i < 5; i++) {
          const completion = await createCompletion(
            client,
            {
              model: ELIORA_CHAT_MODEL,
              // gpt-5 reasoning shares this budget with the visible reply, so
              // keep effort low (it's a chat coach, not a proof) and the cap
              // roomy — otherwise reasoning can eat it all and the learner
              // gets an empty reply.
              //
              // Voice mode trades that thinking time for turn-taking: reasoning
              // happens BEFORE the first token, and in a spoken conversation
              // those seconds are silence the learner sits through. The reply is
              // only a few sentences anyway, so the budget comes down with it.
              max_completion_tokens: body.voice ? 1200 : 4000,
              reasoning_effort: body.voice ? "minimal" : "low",
              messages,
              tools: TOOLS,
              stream: true,
            },
            upstream.signal,
          );

          let assistantText = "";
          const calls: { id: string; name: string; args: string }[] = [];

          for await (const chunk of completion) {
            const delta = chunk.choices[0]?.delta;
            if (delta?.content) {
              assistantText += delta.content;
              streamedAny = true;
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

          if (calls.length === 0) {
            answered = true;
            break; // no tools requested — done
          }

          // Tell the learner what's happening while the tools run.
          const labels = [
            ...new Set(
              calls.map((c) => TOOL_STATUS[c.name] ?? "Working on it…"),
            ),
          ];
          send({ type: "status", value: labels.join(" ") });

          messages.push({
            role: "assistant",
            content: assistantText || null,
            tool_calls: calls.map((c) => ({
              id: c.id,
              type: "function",
              function: { name: c.name, arguments: c.args || "{}" },
            })),
          });

          // Independent tools (e.g. two YouTube searches) run concurrently.
          const results = await Promise.all(
            calls.map((c) => {
              let input: Record<string, unknown> = {};
              try {
                input = JSON.parse(c.args || "{}");
              } catch {
                /* leave empty */
              }
              return runTool(c.name, input, send);
            }),
          );
          calls.forEach((c, j) =>
            messages.push({
              role: "tool",
              tool_call_id: c.id,
              content: results[j],
            }),
          );
          send({ type: "status", value: "Thinking…" });
        }

        // If the loop cap was hit while the model still wanted tools, or the
        // model never produced any visible text (e.g. reasoning ate the token
        // budget), force a plain-text wrap-up so the learner never gets a
        // silent ending.
        if (!answered || !streamedAny) {
          const wrapUp = await createCompletion(
            client,
            {
              model: ELIORA_CHAT_MODEL,
              max_completion_tokens: body.voice ? 800 : 2000,
              reasoning_effort: body.voice ? "minimal" : "low",
              messages,
              tools: TOOLS,
              tool_choice: "none",
              stream: true,
            },
            upstream.signal,
          );
          for await (const chunk of wrapUp) {
            const text = chunk.choices[0]?.delta?.content;
            if (text) send({ type: "text", value: text });
          }
        }
        controller.close();
      } catch (err) {
        if (upstream.signal.aborted) {
          // Client hung up (or hit Stop) — nothing left to tell them.
          try {
            controller.close();
          } catch {
            /* already closed */
          }
          return;
        }
        const status =
          err instanceof OpenAI.APIError ? ` (${err.status})` : "";
        send({
          type: "text",
          value: `\n\n[Eliora ran into a problem${status}. Please try again.]`,
        });
        controller.close();
      }
    },
    cancel() {
      upstream.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
    },
  });
}
