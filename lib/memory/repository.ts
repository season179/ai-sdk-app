import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool, PoolClient } from "pg";

import type { AppDbTransaction } from "@/db";
import * as schema from "@/db/schema";
import { contentDedupeKey, dedupeGeneralRecall } from "@/lib/memory/ranking";
import type {
  DecisionRecallItem,
  GeneralRecallItem,
  RecallRepository,
  RecallRepositoryResult,
  RecallRequest,
  RecallScoreComponents,
} from "@/lib/memory/types";
import { getPool } from "@/lib/scheduler/db";

const MAX_DECISIONS = 3;
const MAX_GENERAL = 20;

export class PostgresRecallRepository implements RecallRepository {
  constructor(
    private readonly dependencies: {
      pool?: Pick<Pool, "connect">;
      now?: () => number;
    } = {},
  ) {}

  async recall(request: RecallRequest): Promise<RecallRepositoryResult> {
    const decisionLimit = boundedLimit(request.decisionLimit, MAX_DECISIONS, MAX_DECISIONS);
    const generalLimit = boundedLimit(request.generalLimit, MAX_GENERAL, MAX_GENERAL);
    const now = this.dependencies.now ?? Date.now;
    const client = await acquireRecallClient(
      this.dependencies.pool ?? getPool(),
      request.signal,
      request.deadlineAt,
      now,
    );
    try {
      throwIfRecallExpired(request.signal, request.deadlineAt, now);
      const db = drizzle(client, { schema });
      return await db.transaction(async (tx) => {
        await tx.execute(sql`set local statement_timeout = '1750ms'`);
        await tx.execute(sql`set local pg_trgm.similarity_threshold = '0.12'`);

        const decisions =
          request.includeDecisions === false
            ? []
            : await queryDecisions(tx, request, decisionLimit);
        const general = await queryGeneral(tx, request, generalLimit);

        return {
          decisions,
          general,
          candidateIds: [...decisions.map((item) => item.id), ...general.map((item) => item.id)],
        };
      });
    } finally {
      client.release();
    }
  }
}

export async function acquireRecallClient(
  pool: Pick<Pool, "connect">,
  signal?: AbortSignal,
  deadlineAt?: number,
  now: () => number = Date.now,
): Promise<PoolClient> {
  throwIfRecallExpired(signal, deadlineAt, now);
  const checkout = pool.connect();
  return new Promise<PoolClient>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      signal?.removeEventListener("abort", abort);
      if (timer) clearTimeout(timer);
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("recall_deadline_exceeded"));
    };
    const abort = () => fail();
    signal?.addEventListener("abort", abort, { once: true });
    if (deadlineAt !== undefined) {
      const remaining = deadlineAt - now();
      if (remaining <= 0) fail();
      else timer = setTimeout(fail, remaining);
    }
    checkout.then(
      (client) => {
        if (settled || signal?.aborted || (deadlineAt !== undefined && now() >= deadlineAt)) {
          client.release();
          fail();
          return;
        }
        settled = true;
        cleanup();
        resolve(client);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

function throwIfRecallExpired(
  signal: AbortSignal | undefined,
  deadlineAt: number | undefined,
  now: () => number,
) {
  if (signal?.aborted || (deadlineAt !== undefined && now() >= deadlineAt)) {
    throw new Error("recall_deadline_exceeded");
  }
}

export const postgresRecallRepository: RecallRepository = new PostgresRecallRepository();

type DbTransaction = AppDbTransaction;

type DecisionRow = {
  id: string;
  supersedes_decision_id: string | null;
  subject_key: string;
  selected_option: string;
  declared_rationale: string;
  status: DecisionRecallItem["status"];
  confidence: number;
  authority: string;
  decided_at: Date | string;
  valid_from: Date | string | null;
  event_ids: string[] | null;
  outcome_id: string | null;
  outcome_summary: string | null;
  outcome_assessment: "supports" | "contradicts" | "inconclusive" | null;
  outcome_time: Date | string | null;
};

async function queryDecisions(
  tx: DbTransaction,
  request: RecallRequest,
  limit: number,
): Promise<DecisionRecallItem[]> {
  const terms = queryTerms(request.query);
  const termArray = sql`array[${sql.join(
    terms.map((term) => sql`${term}`),
    sql`, `,
  )}]::text[]`;
  const result = await tx.execute<DecisionRow>(sql`
    select
      d.id,
      d.supersedes_decision_id,
      d.subject_key,
      d.selected_option,
      d.declared_rationale,
      d.status,
      d.confidence,
      d.authority,
      d.decided_at,
      lower(d.valid_during) as valid_from,
      provenance.event_ids,
      latest_outcome.id as outcome_id,
      latest_outcome.observed_state as outcome_summary,
      latest_outcome.assessment as outcome_assessment,
      latest_outcome.occurred_at as outcome_time
    from agent_decisions d
    left join lateral (
      select o.id, o.observed_state, o.assessment, o.occurred_at
      from agent_outcomes o
      where o.decision_id = d.id
      order by o.occurred_at desc, o.id asc
      limit 1
    ) latest_outcome on true
    left join lateral (
      select jsonb_agg(source.event_id order by source.event_id) as event_ids
      from (
        select p.event_id
        from agent_decision_trace_events p
        where p.decision_id = d.id
        order by p.event_id
        limit 2
      ) source
    ) provenance on true
    where d.agent_id = ${request.agentId}::uuid
      and (
        (d.scope_type = 'agent' and d.scope_id = ${request.agentId}::text)
        or (
          ${request.sessionId ?? null}::uuid is not null
          and d.scope_type = 'session'
          and d.scope_id = ${request.sessionId ?? null}::text
        )
      )
      and d.status <> 'superseded'
      and d.revoked_at is null
      and d.tombstoned = false
      and d.injection_blocked = false
      and (d.valid_during is null or d.valid_during @> ${request.asOf}::timestamptz)
      and d.recorded_during @> ${request.asOf}::timestamptz
      and (d.status in ('open', 'unknown') or d.decided_at >= ${request.asOf}::timestamptz - interval '30 days')
    order by
      (d.scope_type = 'session' and d.scope_id = ${request.sessionId ?? null}::text) desc,
      (lower(d.subject_key) = any(${termArray})) desc,
      case d.status when 'open' then 0 when 'unknown' then 1 else 2 end,
      d.decided_at desc,
      d.id asc
    limit ${limit}
  `);

  return result.rows.map(mapDecisionRow);
}

type GeneralRow = {
  version_id: string;
  memory_id: string;
  kind: GeneralRecallItem["type"];
  memory_type: GeneralRecallItem["memoryType"];
  content: string;
  source: string;
  authority: string;
  confidence: number;
  observed_at: Date | string;
  valid_from: Date | string | null;
  event_ids: string[] | null;
  lexical_rank: number | string | null;
  trigram_rank: number | string | null;
  rrf: number | string;
  normalized_rrf: number | string;
  importance_feature: number | string;
  confidence_feature: number | string;
  freshness: number | string;
  risk_penalty: number | string;
  composite_score: number | string;
};

async function queryGeneral(
  tx: DbTransaction,
  request: RecallRequest,
  limit: number,
): Promise<GeneralRecallItem[]> {
  const result =
    request.query.trim() === "*"
      ? await queryBrowse(tx, request, limit)
      : await queryRanked(tx, request, limit);
  const rows = result.rows.map(mapGeneralRow);
  return dedupeGeneralRecall(rows).slice(0, limit);
}

function eligibleWhere(request: RecallRequest) {
  return sql`
    m.agent_id = ${request.agentId}::uuid
    and m.current_version_id = v.id
    and m.status = 'approved'
    and m.revoked_at is null
    and m.tombstoned = false
    and m.injection_blocked = false
    and (
      (m.scope_type = 'agent' and m.scope_id = ${request.agentId}::text)
      or (
        ${request.sessionId ?? null}::uuid is not null
        and m.scope_type = 'session'
        and m.scope_id = ${request.sessionId ?? null}::text
      )
    )
    and (v.valid_during is null or v.valid_during @> ${request.asOf}::timestamptz)
    and v.recorded_during @> ${request.asOf}::timestamptz
    and (v.expires_at is null or v.expires_at > ${request.asOf}::timestamptz)
    and not (v.structured ? 'profileDirective')
    and (${request.kind ?? null}::text is null or m.kind = ${request.kind ?? null}::text)
  `;
}

async function queryRanked(tx: DbTransaction, request: RecallRequest, limit: number) {
  return tx.execute<GeneralRow>(rankedRecallSql(request, limit));
}

function rankedRecallSql(request: RecallRequest, limit: number) {
  return sql`
    with lexical_matches as materialized (
      select
        v.id,
        ts_rank_cd(v.search_tsv, websearch_to_tsquery('english', ${request.query})) as raw_score
      from agent_memory_versions v
      where v.search_tsv @@ websearch_to_tsquery('english', ${request.query})
    ), trigram_matches as materialized (
      select v.id, similarity(v.content, ${request.query}) as raw_score
      from agent_memory_versions v
      where v.content % ${request.query}
    ), eligible as not materialized (
      select
        v.id as version_id,
        m.id as memory_id,
        m.kind,
        m.memory_type,
        v.content,
        v.source,
        v.authority,
        v.confidence,
        v.importance,
        v.sensitivity_class,
        coalesce(v.observed_at, v.source_reference_time, v.created_at) as observed_at,
        lower(v.valid_during) as valid_from,
        v.search_tsv
      from agent_memories m
      join agent_memory_versions v on v.id = m.current_version_id
      where ${eligibleWhere(request)}
    ), lexical as (
      select
        ranked.version_id as id,
        row_number() over (order by ranked.raw_score desc, ranked.version_id asc) as lane_rank
      from (
        select e.version_id, matches.raw_score
        from lexical_matches matches
        join eligible e on e.version_id = matches.id
        order by matches.raw_score desc, e.version_id asc
        limit 50
      ) ranked
    ), trigram as (
      select
        ranked.version_id as id,
        row_number() over (order by ranked.raw_score desc, ranked.version_id asc) as lane_rank
      from (
        select e.version_id, matches.raw_score
        from trigram_matches matches
        join eligible e on e.version_id = matches.id
        order by matches.raw_score desc, e.version_id asc
        limit 50
      ) ranked
    ), fused as (
      select
        id,
        max(lexical_rank) as lexical_rank,
        max(trigram_rank) as trigram_rank,
        sum(rrf_part) as rrf
      from (
        select id, lane_rank as lexical_rank, null::bigint as trigram_rank,
          0.65::double precision / (60 + lane_rank) as rrf_part
        from lexical
        union all
        select id, null::bigint, lane_rank,
          0.35::double precision / (60 + lane_rank) as rrf_part
        from trigram
      ) lanes
      group by id
    ), features as (
      select
        e.*,
        f.lexical_rank,
        f.trigram_rank,
        f.rrf::double precision as rrf,
        least(1.0, f.rrf * 61.0)::double precision as normalized_rrf,
        (e.importance::double precision / 100.0) as importance_feature,
        (e.confidence::double precision / 100.0) as confidence_feature,
        case
          when e.kind = 'episode' then power(2.0, -greatest(0, extract(epoch from (${request.asOf}::timestamptz - e.observed_at)) / 86400.0) / 90.0)
          when e.kind = 'fact' then power(2.0, -greatest(0, extract(epoch from (${request.asOf}::timestamptz - e.observed_at)) / 86400.0) / 180.0)
          else 1.0
        end::double precision as freshness,
        case e.sensitivity_class when 'restricted' then 0.30 when 'sensitive' then 0.15 else 0.0 end::double precision as risk_penalty
      from fused f
      join eligible e on e.version_id = f.id
    ), scored as (
      select features.*,
        (0.65 * normalized_rrf + 0.15 * importance_feature + 0.10 * confidence_feature + 0.10 * freshness - risk_penalty)::double precision as composite_score
      from features
    )
    select scored.*, provenance.event_ids
    from scored
    left join lateral (
      select jsonb_agg(source.event_id order by source.event_id) as event_ids
      from (
        select p.event_id
        from agent_memory_version_trace_events p
        where p.memory_version_id = scored.version_id
        order by p.event_id
        limit 2
      ) source
    ) provenance on true
    order by scored.composite_score desc, scored.rrf desc, scored.observed_at desc, scored.version_id asc
    limit ${limit}
  `;
}

/** Integration-only plan probe over the exact production ranked query. */
export async function explainRankedRecall(request: RecallRequest): Promise<unknown> {
  const client = await getPool().connect();
  try {
    const db = drizzle(client, { schema });
    return await db.transaction(async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      const result = await tx.execute<Record<string, unknown>>(
        sql`explain (format json) ${rankedRecallSql(request, MAX_GENERAL)}`,
      );
      return result.rows[0]?.["QUERY PLAN"];
    });
  } finally {
    client.release();
  }
}

async function queryBrowse(tx: DbTransaction, request: RecallRequest, limit: number) {
  return tx.execute<GeneralRow>(sql`
    with features as (
      select
        v.id as version_id,
        m.id as memory_id,
        m.kind,
        m.memory_type,
        v.content,
        v.source,
        v.authority,
        v.confidence,
        coalesce(v.observed_at, v.source_reference_time, v.created_at) as observed_at,
        lower(v.valid_during) as valid_from,
        null::bigint as lexical_rank,
        null::bigint as trigram_rank,
        0.0::double precision as rrf,
        0.0::double precision as normalized_rrf,
        (v.importance::double precision / 100.0) as importance_feature,
        (v.confidence::double precision / 100.0) as confidence_feature,
        case
          when m.kind = 'episode' then power(2.0, -greatest(0, extract(epoch from (${request.asOf}::timestamptz - coalesce(v.observed_at, v.source_reference_time, v.created_at))) / 86400.0) / 90.0)
          when m.kind = 'fact' then power(2.0, -greatest(0, extract(epoch from (${request.asOf}::timestamptz - coalesce(v.observed_at, v.source_reference_time, v.created_at))) / 86400.0) / 180.0)
          else 1.0
        end::double precision as freshness,
        case v.sensitivity_class when 'restricted' then 0.30 when 'sensitive' then 0.15 else 0.0 end::double precision as risk_penalty
      from agent_memories m
      join agent_memory_versions v on v.id = m.current_version_id
      where ${eligibleWhere(request)}
    ), scored as (
      select features.*,
        (0.15 * importance_feature + 0.10 * confidence_feature + 0.10 * freshness - risk_penalty)::double precision as composite_score
      from features
    )
    select scored.*, provenance.event_ids
    from scored
    left join lateral (
      select jsonb_agg(source.event_id order by source.event_id) as event_ids
      from (
        select p.event_id
        from agent_memory_version_trace_events p
        where p.memory_version_id = scored.version_id
        order by p.event_id
        limit 2
      ) source
    ) provenance on true
    order by scored.composite_score desc, scored.observed_at desc, scored.version_id asc
    limit ${limit}
  `);
}

function mapDecisionRow(row: DecisionRow): DecisionRecallItem {
  assertString(row.id, "decision id");
  assertString(row.subject_key, "decision subject");
  assertString(row.selected_option, "decision option");
  const confidence = Number(row.confidence);
  const freshness = 1;
  const score: RecallScoreComponents = {
    lexicalRank: null,
    trigramRank: null,
    rrf: 0,
    normalizedRrf: 0,
    importance: 1,
    confidence: confidence / 100,
    freshness,
    riskPenalty: 0,
    composite: 0.15 + 0.1 * (confidence / 100) + 0.1 * freshness,
  };
  return {
    category: "decision",
    id: row.id,
    lineageId: row.supersedes_decision_id ?? row.id,
    type: "decision",
    sourceKind: "decision",
    summary: row.selected_option,
    status: row.status,
    subjectKey: row.subject_key,
    rationale: row.declared_rationale,
    outcome:
      row.outcome_id && row.outcome_summary && row.outcome_assessment && row.outcome_time
        ? {
            id: row.outcome_id,
            summary: row.outcome_summary,
            assessment: row.outcome_assessment,
            occurredAt: iso(row.outcome_time),
          }
        : null,
    eventDate: iso(row.decided_at),
    validDate: row.valid_from ? iso(row.valid_from) : null,
    provenanceTraceIds: stringArray(row.event_ids),
    authority: row.authority,
    confidence,
    score,
  };
}

function mapGeneralRow(row: GeneralRow): GeneralRecallItem {
  assertString(row.version_id, "memory version id");
  assertString(row.memory_id, "memory id");
  assertString(row.content, "memory content");
  const score: RecallScoreComponents = {
    lexicalRank: nullableNumber(row.lexical_rank),
    trigramRank: nullableNumber(row.trigram_rank),
    rrf: Number(row.rrf),
    normalizedRrf: Number(row.normalized_rrf),
    importance: Number(row.importance_feature),
    confidence: Number(row.confidence_feature),
    freshness: Number(row.freshness),
    riskPenalty: Number(row.risk_penalty),
    composite: Number(row.composite_score),
  };
  if (Object.values(score).some((value) => typeof value === "number" && !Number.isFinite(value))) {
    throw new Error(`Malformed recall score for ${row.version_id}`);
  }
  return {
    category: "memory",
    id: row.memory_id,
    versionId: row.version_id,
    lineageId: row.memory_id,
    type: row.kind,
    memoryType: row.memory_type,
    sourceKind: row.source,
    summary: row.content,
    status: "approved",
    eventDate: iso(row.observed_at),
    validDate: row.valid_from ? iso(row.valid_from) : null,
    provenanceTraceIds: stringArray(row.event_ids),
    authority: row.authority,
    confidence: Number(row.confidence),
    contentKey: contentDedupeKey(row.content),
    score,
  };
}

function queryTerms(query: string): string[] {
  return [...new Set(query.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}_:-]+/gu) ?? [])].slice(
    0,
    32,
  );
}

function boundedLimit(value: number | undefined, fallback: number, max: number) {
  return Math.max(0, Math.min(max, Math.trunc(value ?? fallback)));
}

function nullableNumber(value: number | string | null) {
  return value == null ? null : Number(value);
}

function iso(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Malformed recall date");
  return date.toISOString();
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Malformed ${label}`);
}

function stringArray(value: string[] | null): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").slice(0, 2)
    : [];
}
