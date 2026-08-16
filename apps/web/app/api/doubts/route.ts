import {
  acceptDoubtReply,
  askDoubt,
  createGroup,
  deleteDoubt,
  joinGroup,
  readFeed,
  replyToDoubt,
  voteOnDoubt,
  type DoubtFeed,
} from "@/lib/doubts";
import { DOUBT_GLOBAL_SCOPE, isValidGroupCode } from "@eliora/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The doubts board: ask a question with your working shown, answer other
// people's, vote, and mark what actually helped. Every doubt lives either in
// the global feed or inside a private group identified by a join code.
//
// GET  /api/doubts?scope=global|CODE                       -> { feed }
// POST /api/doubts                                          -> { feed } | { group }
//   { action: "create-group", name, memberId, memberName }
//   { action: "join-group",   code, memberId, memberName }
//   { action: "ask",     scope, memberId, memberName, title, body, subject?, work? }
//   { action: "reply",   scope, memberId, memberName, doubtId, parentId?, text, work? }
//   { action: "vote",    scope, memberId, doubtId, replyId?, value: 1 | -1 }
//   { action: "accept",  scope, memberId, doubtId, replyId }
//   { action: "delete",  scope, memberId, doubtId, replyId? }

// Mutations all resolve to the in-scope feed, or null when the scope/doubt is
// gone — collapse that into one response shape.
function feedResponse(feed: DoubtFeed | null) {
  if (!feed) {
    return Response.json(
      { error: "That doubt or group is no longer there." },
      { status: 404 },
    );
  }
  return Response.json({ feed }, { headers: { "Cache-Control": "no-store" } });
}

// Reading is anonymous: the client sends its member id only so the UI can
// highlight its own votes, and that's decided client-side from the feed.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const scope = (url.searchParams.get("scope") ?? DOUBT_GLOBAL_SCOPE).trim();
  return feedResponse(await readFeed(scope));
}

export async function POST(req: Request) {
  let body: {
    action?: string;
    scope?: string;
    code?: string;
    name?: string;
    memberId?: string;
    memberName?: string;
    doubtId?: string;
    replyId?: string;
    parentId?: string;
    title?: string;
    subject?: string;
    text?: string;
    work?: string;
    value?: number;
  };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }

  const memberId = (body.memberId ?? "").trim();
  if (!memberId) {
    return Response.json({ error: "Missing member id." }, { status: 400 });
  }
  const memberName = body.memberName ?? "Guest";
  const scope = (body.scope ?? DOUBT_GLOBAL_SCOPE).trim();

  switch (body.action) {
    case "create-group": {
      const name = (body.name ?? "").trim();
      if (!name) {
        return Response.json({ error: "Give your group a name." }, { status: 400 });
      }
      const group = await createGroup({ name, memberId, memberName });
      return Response.json({ group });
    }

    case "join-group": {
      const code = (body.code ?? "").trim().toUpperCase();
      if (!isValidGroupCode(code)) {
        return Response.json(
          { error: "That code doesn't look right." },
          { status: 400 },
        );
      }
      const group = await joinGroup({ code, memberId, memberName });
      if (!group) {
        return Response.json(
          { error: "No group with that code." },
          { status: 404 },
        );
      }
      return Response.json({ group });
    }

    case "ask": {
      const title = (body.title ?? "").trim();
      if (!title) {
        return Response.json(
          { error: "What's the question? Add a title." },
          { status: 400 },
        );
      }
      return feedResponse(
        await askDoubt({
          scope,
          authorId: memberId,
          authorName: memberName,
          title,
          body: body.text ?? "",
          subject: body.subject,
          work: body.work,
        }),
      );
    }

    case "reply": {
      const doubtId = (body.doubtId ?? "").trim();
      if (!doubtId) {
        return Response.json({ error: "Missing doubt id." }, { status: 400 });
      }
      if (!(body.text ?? "").trim() && !(body.work ?? "").trim()) {
        return Response.json({ error: "Write something first." }, { status: 400 });
      }
      return feedResponse(
        await replyToDoubt({
          scope,
          doubtId,
          parentId: body.parentId,
          authorId: memberId,
          authorName: memberName,
          text: body.text ?? "",
          work: body.work,
        }),
      );
    }

    case "vote": {
      const doubtId = (body.doubtId ?? "").trim();
      const value = body.value === -1 ? -1 : 1;
      if (!doubtId) {
        return Response.json({ error: "Missing doubt id." }, { status: 400 });
      }
      return feedResponse(
        await voteOnDoubt({
          scope,
          doubtId,
          replyId: body.replyId,
          memberId,
          value,
        }),
      );
    }

    case "accept": {
      const doubtId = (body.doubtId ?? "").trim();
      const replyId = (body.replyId ?? "").trim();
      if (!doubtId || !replyId) {
        return Response.json({ error: "Missing ids." }, { status: 400 });
      }
      return feedResponse(
        await acceptDoubtReply({ scope, doubtId, replyId, memberId }),
      );
    }

    case "delete": {
      const doubtId = (body.doubtId ?? "").trim();
      if (!doubtId) {
        return Response.json({ error: "Missing doubt id." }, { status: 400 });
      }
      return feedResponse(
        await deleteDoubt({ scope, doubtId, replyId: body.replyId, memberId }),
      );
    }

    default:
      return Response.json({ error: "Unknown action." }, { status: 400 });
  }
}
