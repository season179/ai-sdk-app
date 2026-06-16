ALTER TABLE "agent_chat_sessions" ADD COLUMN "origin" text DEFAULT 'chat' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_chat_sessions" ADD COLUMN "task_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_scheduled_tasks" ADD COLUMN "origin_session_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_chat_sessions" ADD CONSTRAINT "agent_chat_sessions_task_id_agent_scheduled_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."agent_scheduled_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_scheduled_tasks" ADD CONSTRAINT "agent_scheduled_tasks_origin_session_id_agent_chat_sessions_id_fk" FOREIGN KEY ("origin_session_id") REFERENCES "public"."agent_chat_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_chat_sessions_task_id_uniq" ON "agent_chat_sessions" USING btree ("task_id") WHERE "agent_chat_sessions"."task_id" is not null;--> statement-breakpoint
ALTER TABLE "agent_chat_sessions" ADD CONSTRAINT "agent_chat_sessions_origin_check" CHECK ("agent_chat_sessions"."origin" in ('chat', 'scheduled_task'));