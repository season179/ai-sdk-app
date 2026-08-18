CREATE TABLE "agent_memory_documents" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"index_body" text DEFAULT '' NOT NULL,
	"details" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"index_token_count" integer DEFAULT 0 NOT NULL,
	"details_token_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_memory_documents_index_tokens_check" CHECK ("agent_memory_documents"."index_token_count" between 0 and 1000),
	CONSTRAINT "agent_memory_documents_details_tokens_check" CHECK ("agent_memory_documents"."details_token_count" between 0 and 4000),
	CONSTRAINT "agent_memory_documents_details_array_check" CHECK (jsonb_typeof("agent_memory_documents"."details") = 'array')
);
