import { proposalErrorResponse } from "@/app/api/proposals/_errors";
import type { ReviewProposalStatus } from "@/db/schema";
import { createReviewProposal, listReviewProposals } from "@/lib/self-improvement/proposals";
import { isUuid } from "@/lib/utils";

const STATUSES = new Set<ReviewProposalStatus>(["pending", "rejected", "applied", "failed"]);

export async function GET(req: Request) {
  const rawStatus = new URL(req.url).searchParams.get("status");
  const status =
    rawStatus && STATUSES.has(rawStatus as ReviewProposalStatus)
      ? (rawStatus as ReviewProposalStatus)
      : undefined;

  try {
    const proposals = await listReviewProposals({ status });
    return Response.json({ proposals });
  } catch (error) {
    return proposalErrorResponse(error);
  }
}

export async function POST(req: Request) {
  let body: {
    kind?: unknown;
    payload?: unknown;
    rationale?: unknown;
    sessionId?: unknown;
    triggerMessageId?: unknown;
  };

  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  if (body.sessionId != null && (typeof body.sessionId !== "string" || !isUuid(body.sessionId))) {
    return Response.json({ error: "sessionId must be a UUID string." }, { status: 400 });
  }

  if (
    body.triggerMessageId != null &&
    (typeof body.triggerMessageId !== "string" || body.triggerMessageId.trim().length > 128)
  ) {
    return Response.json(
      { error: "triggerMessageId must be a string 128 characters or fewer." },
      { status: 400 },
    );
  }

  const sessionId = typeof body.sessionId === "string" ? body.sessionId : null;
  const triggerMessageId =
    typeof body.triggerMessageId === "string" ? body.triggerMessageId.trim() : null;

  try {
    const proposal = await createReviewProposal({
      kind: body.kind,
      payload: body.payload,
      rationale: body.rationale,
      sessionId,
      triggerMessageId,
      reviewerModel: "manual",
    });

    return Response.json({ proposal }, { status: 201 });
  } catch (error) {
    return proposalErrorResponse(error);
  }
}
