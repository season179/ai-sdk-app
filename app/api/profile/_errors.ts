import {
  ProfileGenerationConflictError,
  ProfileSourceValidationError,
} from "@/lib/profile/repository";
import {
  ProfileFactNotFoundError,
  ProfileServiceConflictError,
  ProfileServiceDisabledError,
  ProfileServiceInputError,
} from "@/lib/profile/service";

export function profileErrorResponse(error: unknown): Response {
  if (error instanceof ProfileServiceInputError) {
    return Response.json(
      { error: error.message, ...(error.issues.length ? { issues: error.issues } : {}) },
      { status: 400 },
    );
  }
  if (
    error instanceof ProfileServiceConflictError ||
    error instanceof ProfileGenerationConflictError
  ) {
    return Response.json(
      { error: "The profile changed. Reload it before trying again.", conflict: true },
      { status: 409 },
    );
  }
  if (error instanceof ProfileFactNotFoundError) {
    return Response.json({ error: error.message }, { status: 404 });
  }
  if (error instanceof ProfileServiceDisabledError) {
    return Response.json({ error: error.message }, { status: 409 });
  }
  if (error instanceof ProfileSourceValidationError) {
    return Response.json({ error: "Profile text failed validation." }, { status: 400 });
  }
  console.error("Profile request failed", error);
  return Response.json({ error: "Profile request could not be completed." }, { status: 500 });
}
