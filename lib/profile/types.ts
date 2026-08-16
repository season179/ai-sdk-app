export type ProfileFactCategory =
  | "identity_context"
  | "preferences_constraints"
  | "active_projects_goals"
  | "interaction_instructions";

export type ProfileFactAuthority = "synthesized" | "user";

export type ProfileVersionTrigger = "scheduled" | "explicit" | "manual_ui";

export type ProfileVersionAuthority = "synthesized" | "user";

export type ProfileFactV1 = {
  factKey: string;
  sentence: string;
  category: ProfileFactCategory;
  authority: ProfileFactAuthority;
  protected: boolean;
  order: number;
};
