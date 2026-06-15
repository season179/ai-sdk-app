CREATE TABLE "agent_chat_messages" (
	"id" text NOT NULL,
	"session_id" uuid NOT NULL,
	"role" text NOT NULL,
	"parts" jsonb NOT NULL,
	"metadata" jsonb,
	"ordinal" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_chat_messages_session_id_id_pk" PRIMARY KEY("session_id","id"),
	CONSTRAINT "agent_chat_messages_role_check" CHECK ("agent_chat_messages"."role" in ('user', 'assistant', 'system'))
);
--> statement-breakpoint
CREATE TABLE "agent_chat_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"title" text,
	"last_message_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	CONSTRAINT "agent_chat_sessions_title_check" CHECK ("agent_chat_sessions"."title" is null or char_length("agent_chat_sessions"."title") between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "agent_chat_messages" ADD CONSTRAINT "agent_chat_messages_session_id_agent_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_chat_messages_session_ordinal_idx" ON "agent_chat_messages" USING btree ("session_id","ordinal");--> statement-breakpoint
CREATE INDEX "agent_chat_sessions_list_idx" ON "agent_chat_sessions" USING btree ("agent_id") WHERE "agent_chat_sessions"."deleted_at" is null;