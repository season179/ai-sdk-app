# Legacy raw migrations (historical)

These hand-written SQL files built the original schema and were applied by the
old `scripts/migrate.ts` runner, which tracked them in a `public.schema_migrations`
table. They are kept for history only — **do not add new files here.**

The source of truth for our tables is now [`db/schema.ts`](../schema.ts), with
migrations generated into [`db/drizzle/`](../drizzle/) by Drizzle:

```bash
pnpm db:generate   # diff db/schema.ts -> new db/drizzle/<n>_*.sql
pnpm db:migrate    # apply pending db/drizzle migrations
```

The baseline migration `db/drizzle/0000_init_existing_tables.sql` is idempotent,
so `pnpm db:migrate` is safe on a fresh database (creates the tables) and on a
database that already has them (creates nothing). pg-boss continues to manage
its own schema and is not modeled by Drizzle.
