import { profileErrorResponse } from "@/app/api/profile/_errors";
import {
  getProfileControlPlane,
  ProfileServiceInputError,
  saveManualProfile,
} from "@/lib/profile/service";

const PUT_KEYS = new Set(["body", "expectedVersionId"]);

export async function GET() {
  try {
    return Response.json({ profile: await getProfileControlPlane() });
  } catch (error) {
    return profileErrorResponse(error);
  }
}

export async function PUT(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  try {
    if (!isPlainObject(body)) {
      throw new ProfileServiceInputError("Request body must be a JSON object.");
    }
    const unknownKeys = Object.keys(body).filter((key) => !PUT_KEYS.has(key));
    if (unknownKeys.length) {
      throw new ProfileServiceInputError(`Unsupported profile field: ${unknownKeys[0]}.`);
    }
    if (!Object.hasOwn(body, "body") || !Object.hasOwn(body, "expectedVersionId")) {
      throw new ProfileServiceInputError("body and expectedVersionId are required.");
    }
    const result = await saveManualProfile({
      body: body.body,
      expectedVersionId: body.expectedVersionId,
    });
    return Response.json(result);
  } catch (error) {
    return profileErrorResponse(error);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
