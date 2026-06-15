## Code intelligence

This project uses **codedb** (MCP server) as the primary tool for navigating and searching the
codebase, and **graphify** (knowledge graph at graphify-out/) for architecture-level questions.

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

### graphify — architecture and cross-cutting questions only
Use graphify when the question is conceptual/architectural rather than a precise lookup
(e.g. "what are the major subsystems", "how does auth relate to billing", surprising cross-file
connections):
- `graphify query "<question>"` — scoped subgraph
- `graphify path "<A>" "<B>"` — relationship between two concepts
- `graphify explain "<concept>"` — plain-language explanation of a node
- Read graphify-out/GRAPH_REPORT.md only for a broad architecture review.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

## Database

- Our tables (`agent_scheduled_tasks`, `agent_scheduled_task_runs`, `agent_skills`) are modeled with Drizzle ORM in `db/schema.ts` — the typed data-access layer. Query them through `getDb()` in `db/index.ts`, which binds Drizzle to the shared `pg` pool (`getPool()`); never open a second pool.
- `db/schema.ts` is the source of truth: `pnpm db:generate` writes a migration to `db/drizzle/`, `pnpm db:migrate` applies it. The baseline migration is idempotent (safe on fresh and existing databases). The raw SQL in `db/migrations/` is historical only.
- pg-boss owns the `pgboss` schema; never model or migrate its tables with Drizzle.
