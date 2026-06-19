import { proposalErrorResponse } from "@/app/api/proposals/_errors";
import { applyReviewProposal } from "@/lib/self-improvement/apply";
import { isUuid } from "@/lib/utils";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function POST(_req: Request, context: RouteContext) {
  const { id } = await context.params;

  if (!isUuid(id)) {
    return Response.json(
      { error: `No review proposal with id '${id}' was found.` },
      { status: 404 },
    );
  }

  try {
    const proposal = await applyReviewProposal(id);
    return Response.json({ proposal });
  } catch (error) {
    return proposalErrorResponse(error);
  }
}
