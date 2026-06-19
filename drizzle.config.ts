import { defineConfig } from "drizzle-kit";

// Source of truth for OUR tables only. pg-boss owns its own schema (pgboss)
// and the legacy raw migrations left a public.schema_migrations table behind,
// so the filters keep drizzle-kit from trying to manage anything but these.
export default defineConfig({
  dialect: "postgresql",
  schema: "./db/schema.ts",
  out: "./db/drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
  schemaFilter: ["public"],
  tablesFilter: [
    "agent_scheduled_tasks",
    "agent_scheduled_task_runs",
    "agent_skills",
    "agent_chat_sessions",
    "agent_chat_messages",
    "agent_memories",
    "agent_review_proposals",
    "agent_review_states",
  ],
});
