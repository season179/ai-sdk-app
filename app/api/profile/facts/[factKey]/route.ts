import { profileErrorResponse } from "@/app/api/profile/_errors";
import { deleteManualProfileFact } from "@/lib/profile/service";

export type ProfileFactRouteContext = {
  params: Promise<{ factKey: string }>;
};

export async function DELETE(req: Request, context: ProfileFactRouteContext) {
  const { factKey } = await context.params;
  const expectedVersionId = new URL(req.url).searchParams.get("expectedVersionId");

  try {
    const result = await deleteManualProfileFact(
      factKey,
      expectedVersionId === null ? {} : { expectedVersionId },
    );
    return Response.json(result);
  } catch (error) {
    return profileErrorResponse(error);
  }
}
