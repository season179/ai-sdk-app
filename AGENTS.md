## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

## Database

- Our tables (`agent_scheduled_tasks`, `agent_scheduled_task_runs`, `agent_skills`) are modeled with Drizzle ORM in `db/schema.ts` — the typed data-access layer. Query them through `getDb()` in `db/index.ts`, which binds Drizzle to the shared `pg` pool (`getPool()`); never open a second pool.
- `db/schema.ts` is the source of truth: `pnpm db:generate` writes a migration to `db/drizzle/`, `pnpm db:migrate` applies it. The baseline migration is idempotent (safe on fresh and existing databases). The raw SQL in `db/migrations/` is historical only.
- pg-boss owns the `pgboss` schema; never model or migrate its tables with Drizzle.
