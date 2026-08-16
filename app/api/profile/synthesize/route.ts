import { profileErrorResponse } from "@/app/api/profile/_errors";
import { requestManualProfileSynthesis } from "@/lib/profile/service";

export async function POST() {
  try {
    const status = await requestManualProfileSynthesis();
    return Response.json(status, { status: 202 });
  } catch (error) {
    return profileErrorResponse(error);
  }
}
