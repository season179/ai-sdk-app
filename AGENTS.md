## Code intelligence

This project uses **codedb** (MCP server) as the primary tool for navigating and searching the
codebase.

### codedb — default for all code lookups
Use codedb MCP tools first; they are sub-millisecond and token-cheap:
- `codedb_search` — trigram full-text / regex search
- `codedb_word` — O(1) identifier lookup
- `codedb_symbol` — where a symbol is defined
- `codedb_callers` — every call site of a symbol
- `codedb_outline` — symbols (functions/types/imports) in a file
- `codedb_deps` — import / imported-by graph (`transitive=true` for full BFS)
- `codedb_context` — pass a natural-language task, get keywords + defs + ranked files + snippets
- `codedb_tree`, `codedb_ls`, `codedb_glob`, `codedb_read` — navigation and reading

Reach for raw `Read`/`grep` only to modify or debug specific lines after codedb has located them.

## Database

- Our tables (`agent_scheduled_tasks`, `agent_scheduled_task_runs`, `agent_skills`, `agent_chat_sessions`, `agent_chat_messages`) are modeled with Drizzle ORM in `db/schema.ts` — the typed data-access layer. Query them through `getDb()` in `db/index.ts`, which binds Drizzle to the shared `pg` pool (`getPool()`); never open a second pool.
- Persistent chat lives in `agent_chat_sessions` (one row per conversation, soft-deleted via `deleted_at`) and `agent_chat_messages` (UIMessage `parts`/`metadata` as jsonb, ordered by `ordinal`, composite PK `(session_id, id)`, FK cascade). Access them through `lib/chat/sessions.ts`; the whole transcript is saved per turn by delete-all-then-insert from the chat route's `onFinish`.
- `db/schema.ts` is the source of truth: `pnpm db:generate` writes a migration to `db/drizzle/`, `pnpm db:migrate` applies it. The baseline migration is idempotent (safe on fresh and existing databases). The raw SQL in `db/migrations/` is historical only.
- pg-boss owns the `pgboss` schema; never model or migrate its tables with Drizzle.
