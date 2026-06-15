import { schedulerErrorResponse } from "@/app/api/scheduled-tasks/_errors";
import { getScheduledJobsOverview } from "@/lib/scheduler/overview";

export async function GET() {
  try {
    const overview = await getScheduledJobsOverview();
    return Response.json({ overview });
  } catch (error) {
    return schedulerErrorResponse(error);
  }
}
