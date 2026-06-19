import {
  ReviewProposalNotFoundError,
  SELF_IMPROVEMENT_UNAVAILABLE_MESSAGE,
  SelfImprovementInputError,
} from "@/lib/self-improvement/errors";

export function proposalErrorResponse(error: unknown) {
  if (error instanceof ReviewProposalNotFoundError) {
    return Response.json({ error: error.message }, { status: 404 });
  }

  if (error instanceof SelfImprovementInputError) {
    return Response.json({ error: error.message }, { status: 400 });
  }

  console.error("Review proposal request failed", error);
  return Response.json({ error: SELF_IMPROVEMENT_UNAVAILABLE_MESSAGE }, { status: 500 });
}
