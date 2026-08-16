import { and, asc, desc, eq, gte, isNull, lt, sql } from "drizzle-orm";

import { type AppDbClient, getDb } from "@/db";
import { agentChatMessages, agentChatSessions, type ChatMessageRole } from "@/db/schema";
import { redactReadProjection } from "@/lib/memory/projection-safety";
import { redactText } from "@/lib/memory/redaction";

export const CONVERSATION_SEARCH_DEFAULT_LIMIT = 5;
export const CONVERSATION_SEARCH_MAX_LIMIT = 20;
export const CONVERSATION_SEARCH_MAX_SPAN_DAYS = 90;
export const CONVERSATION_SEARCH_EXCERPT_MAX_CHARS = 500;
export const CONVERSATION_SEARCH_TOTAL_OUTPUT_MAX_CHARS = 6_000;

const MAX_CURSOR_LENGTH = 4_096;
const MAX_CURSOR_MESSAGE_ID_LENGTH = 1_000;
const NANOSECONDS_PER_MILLISECOND = 1_000_000n;
const NANOSECONDS_PER_DAY = 86_400_000_000_000n;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO_INSTANT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/;

export type ConversationSearchOrder = "asc" | "desc";

export type ConversationSearchInput = {
  from: string;
  to: string;
  order?: ConversationSearchOrder;
  role?: ChatMessageRole;
  limit?: number;
  cursor?: string;
};

export type ConversationSearchResult = {
  sessionId: string;
  title: string | null;
  messageId: string;
  role: ChatMessageRole;
  occurredAt: string;
  excerpt: string;
};

export type ConversationSearchResponse = {
  results: ConversationSearchResult[];
  nextCursor: string | null;
};

export type ConversationCursor = {
  createdAt: string;
  sessionId: string;
  messageId: string;
};

type ParsedInstant = {
  source: string;
  epochNanoseconds: bigint;
};

export type ParsedConversationSearch = {
  from: ParsedInstant;
  to: ParsedInstant;
  order: ConversationSearchOrder;
  role?: ChatMessageRole;
  limit: number;
  cursor?: ConversationCursor;
};

export type ConversationSearchStorageRow = {
  sessionId: string;
  title: string | null;
  messageId: string;
  role: ChatMessageRole;
  parts: unknown;
  createdAt: string;
};

export type ConversationSearchQuery = (
  input: ParsedConversationSearch & { agentId: string },
) => Promise<ConversationSearchStorageRow[]>;

export class ConversationSearchInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConversationSearchInputError";
  }
}

/** Strict ISO-8601 instant parsing: full date/time and an explicit UTC offset are required. */
export function parseIsoInstant(value: unknown, fieldName = "timestamp"): ParsedInstant {
  if (typeof value !== "string") {
    throw new ConversationSearchInputError(`${fieldName} must be an ISO-8601 instant.`);
  }

  const match = ISO_INSTANT_PATTERN.exec(value);
  if (!match) {
    throw new ConversationSearchInputError(
      `${fieldName} must be a complete ISO-8601 instant with Z or a numeric UTC offset.`,
    );
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7] ?? "";
  const offsetSign = match[9];
  const offsetHour = Number(match[10] ?? 0);
  const offsetMinute = Number(match[11] ?? 0);

  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 14 ||
    offsetMinute > 59 ||
    (offsetHour === 14 && offsetMinute !== 0)
  ) {
    throw new ConversationSearchInputError(`${fieldName} is not a valid ISO-8601 instant.`);
  }

  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, second, 0);
  const offsetMilliseconds =
    (offsetSign === "-" ? -1 : 1) * (offsetHour * 60 + offsetMinute) * 60_000;
  const epochMilliseconds = local.getTime() - offsetMilliseconds;
  if (!Number.isFinite(epochMilliseconds)) {
    throw new ConversationSearchInputError(`${fieldName} is outside the supported date range.`);
  }

  const fractionNanoseconds = BigInt((fraction || "0").padEnd(9, "0"));
  return {
    source: value,
    epochNanoseconds: BigInt(epochMilliseconds) * NANOSECONDS_PER_MILLISECOND + fractionNanoseconds,
  };
}

export function parseConversationSearchInput(
  input: ConversationSearchInput,
): ParsedConversationSearch {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ConversationSearchInputError("Search input must be an object.");
  }

  const from = parseIsoInstant(input.from, "from");
  const to = parseIsoInstant(input.to, "to");
  if (from.epochNanoseconds >= to.epochNanoseconds) {
    throw new ConversationSearchInputError("from must be earlier than to.");
  }
  if (
    to.epochNanoseconds - from.epochNanoseconds >
    BigInt(CONVERSATION_SEARCH_MAX_SPAN_DAYS) * NANOSECONDS_PER_DAY
  ) {
    throw new ConversationSearchInputError(
      `The requested interval cannot exceed ${CONVERSATION_SEARCH_MAX_SPAN_DAYS} days.`,
    );
  }

  const order = input.order ?? "desc";
  if (order !== "asc" && order !== "desc") {
    throw new ConversationSearchInputError("order must be 'asc' or 'desc'.");
  }

  const role = input.role;
  if (role !== undefined && role !== "user" && role !== "assistant" && role !== "system") {
    throw new ConversationSearchInputError("role must be 'user', 'assistant', or 'system'.");
  }

  const limit = input.limit ?? CONVERSATION_SEARCH_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > CONVERSATION_SEARCH_MAX_LIMIT) {
    throw new ConversationSearchInputError(
      `limit must be an integer from 1 to ${CONVERSATION_SEARCH_MAX_LIMIT}.`,
    );
  }

  const cursor = input.cursor === undefined ? undefined : decodeConversationCursor(input.cursor);
  if (cursor) {
    const cursorInstant = parseIsoInstant(cursor.createdAt, "cursor timestamp");
    if (
      cursorInstant.epochNanoseconds < from.epochNanoseconds ||
      cursorInstant.epochNanoseconds >= to.epochNanoseconds
    ) {
      throw new ConversationSearchInputError("cursor timestamp is outside the requested interval.");
    }
  }

  return { from, to, order, role, limit, cursor };
}

export function encodeConversationCursor(cursor: ConversationCursor): string {
  validateCursorTuple(cursor);
  return Buffer.from(
    JSON.stringify([cursor.createdAt, cursor.sessionId, cursor.messageId]),
    "utf8",
  ).toString("base64url");
}

export function decodeConversationCursor(value: unknown): ConversationCursor {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_CURSOR_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new ConversationSearchInputError("cursor is invalid.");
  }

  let decoded: unknown;
  try {
    const buffer = Buffer.from(value, "base64url");
    if (buffer.toString("base64url") !== value) {
      throw new Error("non-canonical base64url");
    }
    decoded = JSON.parse(buffer.toString("utf8"));
  } catch {
    throw new ConversationSearchInputError("cursor is invalid.");
  }

  if (!Array.isArray(decoded) || decoded.length !== 3) {
    throw new ConversationSearchInputError("cursor is invalid.");
  }

  const cursor = {
    createdAt: decoded[0],
    sessionId: decoded[1],
    messageId: decoded[2],
  };
  validateCursorTuple(cursor);
  return cursor;
}

/** Deterministic tuple comparator used by tests and non-SQL callers. */
export function compareConversationTuples(
  left: ConversationCursor,
  right: ConversationCursor,
  order: ConversationSearchOrder = "asc",
): number {
  const leftTime = parseIsoInstant(left.createdAt, "createdAt").epochNanoseconds;
  const rightTime = parseIsoInstant(right.createdAt, "createdAt").epochNanoseconds;
  let comparison = leftTime < rightTime ? -1 : leftTime > rightTime ? 1 : 0;
  if (comparison === 0) comparison = compareText(left.sessionId, right.sessionId);
  if (comparison === 0) comparison = compareText(left.messageId, right.messageId);
  return order === "asc" ? comparison : -comparison;
}

export async function searchConversationsByTime(
  input: ConversationSearchInput,
  options: {
    agentId: string;
    db?: AppDbClient;
    query?: ConversationSearchQuery;
  },
): Promise<ConversationSearchResponse> {
  const parsed = parseConversationSearchInput(input);
  const query = options.query ?? ((queryInput) => queryConversationRows(queryInput, options.db));
  const rows = await query({ ...parsed, agentId: options.agentId });
  const candidates = rows.slice(0, parsed.limit);
  const results: ConversationSearchResult[] = [];

  for (const row of candidates) {
    const excerpt = truncateCodePoints(
      visibleText(row.parts),
      CONVERSATION_SEARCH_EXCERPT_MAX_CHARS,
    );
    const tuple = {
      createdAt: row.createdAt,
      sessionId: row.sessionId,
      messageId: row.messageId,
    };
    // Validate storage-derived cursor fields before returning an unusable cursor.
    validateCursorTuple(tuple);
    const result: ConversationSearchResult = {
      sessionId: row.sessionId,
      title: row.title,
      messageId: row.messageId,
      role: row.role,
      occurredAt: row.createdAt,
      excerpt,
    };
    // A cursor is included conservatively while packing so the serialized response,
    // not only excerpt text, remains within the hard output budget. Shorten only
    // the current excerpt when needed; never skip a row that can still carry its tuple.
    const nextCursor = encodeConversationCursor(tuple);
    if (
      packedResponseLength(results, result, nextCursor) > CONVERSATION_SEARCH_TOTAL_OUTPUT_MAX_CHARS
    ) {
      const points = Array.from(result.excerpt);
      let low = 0;
      let high = points.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        result.excerpt = points.slice(0, middle).join("");
        if (
          packedResponseLength(results, result, nextCursor) <=
          CONVERSATION_SEARCH_TOTAL_OUTPUT_MAX_CHARS
        ) {
          low = middle;
        } else {
          high = middle - 1;
        }
      }
      result.excerpt = points.slice(0, low).join("");
    }
    if (
      packedResponseLength(results, result, nextCursor) > CONVERSATION_SEARCH_TOTAL_OUTPUT_MAX_CHARS
    ) {
      break;
    }
    results.push(result);
  }

  const hasMore = rows.length > results.length;
  const last = results.at(-1);
  const response = {
    results,
    nextCursor:
      hasMore && last
        ? encodeConversationCursor({
            createdAt: last.occurredAt,
            sessionId: last.sessionId,
            messageId: last.messageId,
          })
        : null,
  };
  if (codePointLength(JSON.stringify(response)) > CONVERSATION_SEARCH_TOTAL_OUTPUT_MAX_CHARS) {
    throw new Error("Conversation search output exceeded its hard limit.");
  }
  return response;
}

async function queryConversationRows(
  input: ParsedConversationSearch & { agentId: string },
  db: AppDbClient = getDb(),
): Promise<ConversationSearchStorageRow[]> {
  const conditions = [
    eq(agentChatSessions.agentId, input.agentId),
    eq(agentChatSessions.origin, "chat"),
    isNull(agentChatSessions.deletedAt),
    gte(agentChatMessages.createdAt, sql`${input.from.source}::timestamptz`),
    lt(agentChatMessages.createdAt, sql`${input.to.source}::timestamptz`),
  ];
  if (input.role) conditions.push(eq(agentChatMessages.role, input.role));
  if (input.cursor) {
    const operator = input.order === "asc" ? sql`>` : sql`<`;
    conditions.push(sql`(
      ${agentChatMessages.createdAt}, ${agentChatMessages.sessionId}, ${agentChatMessages.id}
    ) ${operator} (
      ${input.cursor.createdAt}::timestamptz,
      ${input.cursor.sessionId}::uuid,
      ${input.cursor.messageId}
    )`);
  }

  const direction = input.order === "asc" ? asc : desc;
  return db
    .select({
      sessionId: agentChatMessages.sessionId,
      title: agentChatSessions.title,
      messageId: agentChatMessages.id,
      role: agentChatMessages.role,
      parts: agentChatMessages.parts,
      // Preserve PostgreSQL microseconds; converting through Date would truncate to milliseconds.
      createdAt: sql<string>`to_char(
        ${agentChatMessages.createdAt} at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      )`,
    })
    .from(agentChatMessages)
    .innerJoin(agentChatSessions, eq(agentChatSessions.id, agentChatMessages.sessionId))
    .where(and(...conditions))
    .orderBy(
      direction(agentChatMessages.createdAt),
      direction(agentChatMessages.sessionId),
      direction(agentChatMessages.id),
    )
    .limit(input.limit + 1);
}

function validateCursorTuple(cursor: {
  createdAt: unknown;
  sessionId: unknown;
  messageId: unknown;
}): asserts cursor is ConversationCursor {
  parseIsoInstant(cursor.createdAt, "cursor timestamp");
  if (typeof cursor.sessionId !== "string" || !UUID_PATTERN.test(cursor.sessionId)) {
    throw new ConversationSearchInputError("cursor session id is invalid.");
  }
  if (
    typeof cursor.messageId !== "string" ||
    cursor.messageId.length === 0 ||
    cursor.messageId.length > MAX_CURSOR_MESSAGE_ID_LENGTH ||
    Array.from(cursor.messageId).some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127;
    })
  ) {
    throw new ConversationSearchInputError("cursor message id is invalid.");
  }
}

function visibleText(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  const text = parts
    .flatMap((part) =>
      part &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string"
        ? [(part as { text: string }).text]
        : [],
    )
    .join("\n")
    .trim();
  return redactText(redactReadProjection(text).text).text;
}

function truncateCodePoints(value: string, max: number): string {
  const points = Array.from(value);
  return points.length <= max ? value : points.slice(0, max).join("");
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function packedResponseLength(
  results: ConversationSearchResult[],
  result: ConversationSearchResult,
  nextCursor: string,
): number {
  return codePointLength(JSON.stringify({ results: [...results, result], nextCursor }));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}
