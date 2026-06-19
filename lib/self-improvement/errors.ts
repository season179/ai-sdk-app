export const SELF_IMPROVEMENT_UNAVAILABLE_MESSAGE =
  "Self-improvement data is unavailable. Check the database connection and migrations.";

export class SelfImprovementInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SelfImprovementInputError";
  }
}

export class MemoryNotFoundError extends SelfImprovementInputError {
  constructor(id: string) {
    super(`No memory with id '${id}' was found.`);
    this.name = "MemoryNotFoundError";
  }
}

export class ReviewProposalNotFoundError extends SelfImprovementInputError {
  constructor(id: string) {
    super(`No review proposal with id '${id}' was found.`);
    this.name = "ReviewProposalNotFoundError";
  }
}
