import { randomUUID } from "node:crypto";

import { safeValidateUIMessages, type UIMessage } from "ai";
import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";

import { getDb } from "@/db";
import { agentChatMessages, agentChatSessions } from "@/db/schema";
import { ingestUserTurn } from "@/lib/consolidation/observations";
import { isMemoryWriteEnabled } from "@/lib/memory/config";
import { canonicalJson } from "@/lib/memory/redaction";
import { appendTraceEvents, type TraceEventInput } from "@/lib/memory/trace";
import { DEFAULT_AGENT_ID } from "@/lib/skills/skills";
import type { ChatMessageMetadata } from "@/lib/token-usage";

export type ChatUIMessage = UIMessage<ChatMessageMetadata>;

const MAX_TITLE_LENGTH = 200;

export type ChatSessionSummary = {
  id: string;
  title: string | null;
  lastMessageAt: string | null;
  createdAt: string;
};

export type ChatSession = {
  id: string;
  title: string | null;
  lastMessageAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ChatSessionWithMessages = {
  session: ChatSession;
  messages: ChatUIMessage[];
};

export type ChatSessionForRun = {
  session: ChatSession;
  cleanMessages: ChatUIMessage[];
  modelMessages: ChatUIMessage[];
  apiPartMessageIds: string[];
  profileVersionIds: Record<string, string | null>;
  branchRevision: number;
};

export class ChatSessionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatSessionInputError";
  }
}

export class ChatSessionNotFoundError extends ChatSessionInputError {
  constructor(id: string) {
    super(`No chat session with id '${id}' was found.`);
    this.name = "ChatSessionNotFoundError";
  }
}

export class ChatBranchConflictError extends ChatSessionInputError {
  constructor(message = "The conversation changed while this turn was running. Retry the turn.") {
    super(message);
    this.name = "ChatBranchConflictError";
  }
}

export class ChatMessagePartsMismatchError extends ChatBranchConflictError {
  constructor(readonly winningParts: ChatUIMessage["parts"]) {
    super("The persisted message body differs from the projection source. Recompute and retry.");
    this.name = "ChatMessagePartsMismatchError";
  }
}

/** Newest-activity-first summaries for the sidebar; no message bodies. */
export async function listChatSessions(
  agentId: string = DEFAULT_AGENT_ID,
): Promise<ChatSessionSummary[]> {
  const rows = await getDb()
    .select({
      id: agentChatSessions.id,
      title: agentChatSessions.title,
      lastMessageAt: agentChatSessions.lastMessageAt,
      createdAt: agentChatSessions.createdAt,
    })
    .from(agentChatSessions)
    .where(and(eq(agentChatSessions.agentId, agentId), isNull(agentChatSessions.deletedAt)))
    .orderBy(
      desc(sql`coalesce(${agentChatSessions.lastMessageAt}, ${agentChatSessions.createdAt})`),
    )
    .limit(100);

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }));
}

/** Session + ordered messages, ready to feed useChat({ messages }). */
export async function getChatSession(
  id: string,
  agentId: string = DEFAULT_AGENT_ID,
): Promise<ChatSessionWithMessages | null> {
  const db = getDb();
  const sessionRows = await db
    .select()
    .from(agentChatSessions)
    .where(
      and(
        eq(agentChatSessions.id, id),
        eq(agentChatSessions.agentId, agentId),
        isNull(agentChatSessions.deletedAt),
      ),
    );

  const session = sessionRows[0];

  if (!session) {
    return null;
  }

  const messageRows = await db
    .select()
    .from(agentChatMessages)
    .where(eq(agentChatMessages.sessionId, id))
    .orderBy(agentChatMessages.ordinal);

  const stored: ChatUIMessage[] = messageRows.map((row) => ({
    id: row.id,
    role: row.role,
    parts: row.parts,
    ...(row.metadata ? { metadata: row.metadata } : {}),
  }));

  // Persisted parts are untrusted-by-shape on the way back in: a stale tool or
  // metadata part could break model replay. Validate structurally and fall back
  // to the stored copy so a validation miss never hides the user's history.
  const validation = await safeValidateUIMessages<ChatUIMessage>({ messages: stored });

  if (!validation.success) {
    console.error(`Stored messages for chat session '${id}' failed validation`, validation.error);
  }

  return {
    session: mapSession(session),
    messages: validation.success ? validation.data : stored,
  };
}

/** Server-only history: clean transcript plus exact model-facing replay parts. */
export async function getChatSessionForRun(
  id: string,
  agentId: string = DEFAULT_AGENT_ID,
  expectedBranchRevision?: number,
): Promise<ChatSessionForRun | null> {
  return getDb().transaction(async (tx) => {
    const [session] = await tx
      .select()
      .from(agentChatSessions)
      .where(
        and(
          eq(agentChatSessions.id, id),
          eq(agentChatSessions.agentId, agentId),
          isNull(agentChatSessions.deletedAt),
        ),
      )
      .for("share");
    if (!session) return null;
    if (expectedBranchRevision !== undefined && session.branchRevision !== expectedBranchRevision) {
      throw new ChatBranchConflictError();
    }

    const rows = await tx
      .select()
      .from(agentChatMessages)
      .where(eq(agentChatMessages.sessionId, id))
      .orderBy(agentChatMessages.ordinal);
    const cleanMessages = rows.map((row) => mapMessage(row, row.parts));
    const modelMessages = rows.map((row) => mapMessage(row, row.apiParts ?? row.parts));
    const validation = await safeValidateUIMessages<ChatUIMessage>({ messages: modelMessages });
    if (!validation.success) {
      console.error(`Model messages for chat session '${id}' failed validation`, validation.error);
    }

    return {
      session: mapSession(session),
      cleanMessages,
      modelMessages: validation.success ? validation.data : modelMessages,
      apiPartMessageIds: rows.filter((row) => row.apiParts !== null).map((row) => row.id),
      profileVersionIds: Object.fromEntries(rows.map((row) => [row.id, row.profileVersionId])),
      branchRevision: session.branchRevision,
    };
  });
}

/** First-writer-wins run projection, bound to the clean winner and branch generation. */
export async function materializeMessageRunProjection(
  sessionId: string,
  messageId: string,
  expectedCleanParts: ChatUIMessage["parts"],
  projectedParts: ChatUIMessage["parts"],
  candidateProfileVersionId: string | null,
  expectedBranchRevision?: number,
): Promise<{ parts: ChatUIMessage["parts"]; profileVersionId: string | null }> {
  return getDb().transaction(async (tx) => {
    const [session] = await tx
      .select({ branchRevision: agentChatSessions.branchRevision })
      .from(agentChatSessions)
      .where(and(eq(agentChatSessions.id, sessionId), isNull(agentChatSessions.deletedAt)))
      .for("update");
    if (!session) throw new ChatBranchConflictError("The chat session no longer exists.");
    if (expectedBranchRevision !== undefined && session.branchRevision !== expectedBranchRevision) {
      throw new ChatBranchConflictError();
    }

    const [winner] = await tx
      .select({
        apiParts: agentChatMessages.apiParts,
        parts: agentChatMessages.parts,
        profileVersionId: agentChatMessages.profileVersionId,
      })
      .from(agentChatMessages)
      .where(and(eq(agentChatMessages.sessionId, sessionId), eq(agentChatMessages.id, messageId)));
    if (!winner) {
      throw new ChatBranchConflictError(
        `Message '${messageId}' is no longer on the current conversation branch.`,
      );
    }
    if (canonicalJson(winner.parts) !== canonicalJson(expectedCleanParts)) {
      throw new ChatMessagePartsMismatchError(winner.parts);
    }

    if (winner.apiParts === null) {
      await tx
        .update(agentChatMessages)
        .set({ apiParts: projectedParts, profileVersionId: candidateProfileVersionId })
        .where(
          and(
            eq(agentChatMessages.sessionId, sessionId),
            eq(agentChatMessages.id, messageId),
            isNull(agentChatMessages.apiParts),
          ),
        );
    }
    const [materialized] = await tx
      .select({
        apiParts: agentChatMessages.apiParts,
        parts: agentChatMessages.parts,
        profileVersionId: agentChatMessages.profileVersionId,
      })
      .from(agentChatMessages)
      .where(and(eq(agentChatMessages.sessionId, sessionId), eq(agentChatMessages.id, messageId)));
    return {
      parts: materialized?.apiParts ?? materialized?.parts ?? winner.parts,
      profileVersionId: materialized?.profileVersionId ?? null,
    };
  });
}

/**
 * Append-only persistence shared by the chat route and the scheduled-task
 * worker. Unlike saveChatSession (delete-all-then-insert), this never rewrites
 * existing rows: ordinals continue from the current max, and the composite PK
 * (sessionId, id) plus onConflictDoNothing make catch-up/retry inserts
 * idempotent. Two writers therefore never clobber each other.
 *
 * createIfMissing mints a bare session (origin 'chat') on first write — used by
 * the chat route so a brand-new conversation persists its opening turn. Dedicated
 * task sessions are created up front by createTaskSession instead.
 */
export async function appendSessionMessages(
  sessionId: string,
  messages: ChatUIMessage[],
  opts: {
    agentId?: string;
    createIfMissing?: boolean;
    expectedBranchRevision?: number;
    traceCapture?: {
      events: TraceEventInput[];
      groundedUserMessages?: ChatUIMessage[];
    };
  } = {},
): Promise<{
  traceCaptured: boolean;
  persistedMessages: ChatUIMessage[];
  insertedMessageIds: string[];
  branchRevision: number;
}> {
  if (messages.length === 0) {
    return {
      traceCaptured: false,
      persistedMessages: [],
      insertedMessageIds: [],
      branchRevision: 0,
    };
  }

  const uniqueIds = new Set(messages.map((message) => message.id));
  if (uniqueIds.size !== messages.length) {
    throw new ChatSessionInputError("Chat messages must have unique ids within a batch.");
  }

  return getDb().transaction(async (tx) => {
    let traceCaptured = false;
    if (opts.createIfMissing) {
      await tx
        .insert(agentChatSessions)
        .values({
          id: sessionId,
          agentId: opts.agentId ?? DEFAULT_AGENT_ID,
          lastMessageAt: sql`now()`,
        })
        .onConflictDoNothing();
    }
    const [session] = await tx
      .select({
        deletedAt: agentChatSessions.deletedAt,
        branchRevision: agentChatSessions.branchRevision,
      })
      .from(agentChatSessions)
      .where(eq(agentChatSessions.id, sessionId))
      .for("update");
    if (!session) throw new ChatSessionNotFoundError(sessionId);
    if (session.deletedAt) {
      throw new ChatSessionInputError(
        `Chat session '${sessionId}' was deleted; refusing to append.`,
      );
    }
    if (
      opts.expectedBranchRevision !== undefined &&
      session.branchRevision !== opts.expectedBranchRevision
    ) {
      throw new ChatBranchConflictError();
    }

    // The session row lock serializes ordinal allocation and transcript mutation.
    const [{ nextOrdinal }] = await tx
      .select({
        nextOrdinal: sql<number>`coalesce(max(${agentChatMessages.ordinal}), -1) + 1`,
      })
      .from(agentChatMessages)
      .where(eq(agentChatMessages.sessionId, sessionId));

    const inserted = await tx
      .insert(agentChatMessages)
      .values(
        messages.map((message, index) => ({
          id: message.id,
          sessionId,
          role: message.role,
          parts: message.parts,
          metadata: message.metadata ?? null,
          ordinal: Number(nextOrdinal) + index,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: agentChatMessages.id });
    const insertedIds = new Set(inserted.map((row) => row.id));
    const rows = await tx
      .select()
      .from(agentChatMessages)
      .where(
        and(
          eq(agentChatMessages.sessionId, sessionId),
          inArray(
            agentChatMessages.id,
            messages.map((message) => message.id),
          ),
        ),
      );
    const byId = new Map(rows.map((row) => [row.id, mapMessage(row, row.parts)]));
    const requestedById = new Map(messages.map((message) => [message.id, message]));
    const captureIds = new Set(
      rows.flatMap((row) => {
        const requested = requestedById.get(row.id);
        return requested && canonicalJson(row.parts) === canonicalJson(requested.parts)
          ? [row.id]
          : [];
      }),
    );

    // Same-body retries get an attempt-specific event and repoint grounded
    // evidence; a different-body loser can never journal request-local content.
    if (opts.traceCapture && captureIds.size > 0 && isMemoryWriteEnabled()) {
      try {
        await tx.transaction(async (savepoint) => {
          await savepoint.execute(sql`set local statement_timeout = '750ms'`);
          const events = opts.traceCapture?.events.filter(
            (event) => !event.sourceMessageId || captureIds.has(event.sourceMessageId),
          );
          const traceRows = await appendTraceEvents(events ?? [], savepoint);
          const traceEventIds = new Map(
            traceRows.flatMap((row) =>
              row.sourceMessageId ? ([[row.sourceMessageId, row.id]] as const) : [],
            ),
          );
          const grounded = opts.traceCapture?.groundedUserMessages?.filter((message) =>
            captureIds.has(message.id),
          );
          if (grounded?.length) {
            await ingestUserTurn(sessionId, grounded, {
              agentId: opts.agentId ?? DEFAULT_AGENT_ID,
              db: savepoint,
              traceEventIds,
            });
          }
          await savepoint.execute(sql`set local statement_timeout = 0`);
          traceCaptured = true;
        });
      } catch (error) {
        console.error("Chat trace capture failed; message persistence continues", error);
      }
    }

    if (insertedIds.size > 0) {
      await tx
        .update(agentChatSessions)
        .set({ lastMessageAt: sql`now()`, updatedAt: sql`now()` })
        .where(eq(agentChatSessions.id, sessionId));
    }
    return {
      traceCaptured,
      persistedMessages: messages.flatMap((message) => {
        const persisted = byId.get(message.id);
        return persisted ? [persisted] : [];
      }),
      insertedMessageIds: [...insertedIds],
      branchRevision: session.branchRevision,
    };
  });
}

/**
 * Explicit edit/regenerate truncation — what delete-all-then-insert used to do
 * implicitly. Drops conversational turns after the fork ordinal so the agent
 * re-runs on the forked history.
 *
 * With preserveScheduled (K3) it keeps worker turns (metadata.origin =
 * 'scheduled') and removes only normal turns. The preserve predicate is isolated
 * here so it can be reverted to plain truncation if the cross-edit context
 * desync (see the plan's K3 note) proves problematic — scheduled output is never
 * lost regardless, it lives in agent_scheduled_task_runs.
 */
export async function truncateConversationAfter(
  sessionId: string,
  ordinal: number,
  opts: { preserveScheduled?: boolean } = {},
): Promise<number> {
  return getDb().transaction(async (tx) => {
    await lockLiveSession(tx, sessionId);
    await deleteConversationAfter(tx, sessionId, ordinal, opts);
    return incrementBranchRevision(tx, sessionId);
  });
}

/** Atomically verifies the regenerate fork, truncates, and advances the branch. */
export async function truncateConversationAfterMessage(
  sessionId: string,
  messageId: string,
  opts: { preserveScheduled?: boolean } = {},
): Promise<number> {
  return getDb().transaction(async (tx) => {
    await lockLiveSession(tx, sessionId);
    const [target] = await tx
      .select({ ordinal: agentChatMessages.ordinal })
      .from(agentChatMessages)
      .where(and(eq(agentChatMessages.sessionId, sessionId), eq(agentChatMessages.id, messageId)));
    if (!target) {
      throw new ChatBranchConflictError(
        `Regenerate target '${messageId}' is no longer on the current conversation branch.`,
      );
    }
    await deleteConversationAfter(tx, sessionId, target.ordinal, opts);
    return incrementBranchRevision(tx, sessionId);
  });
}

type SessionTransaction = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

async function lockLiveSession(tx: SessionTransaction, sessionId: string) {
  const [session] = await tx
    .select({ deletedAt: agentChatSessions.deletedAt })
    .from(agentChatSessions)
    .where(eq(agentChatSessions.id, sessionId))
    .for("update");
  if (!session || session.deletedAt) throw new ChatBranchConflictError("The chat session is gone.");
}

async function deleteConversationAfter(
  tx: SessionTransaction,
  sessionId: string,
  ordinal: number,
  opts: { preserveScheduled?: boolean },
) {
  const conds = [
    eq(agentChatMessages.sessionId, sessionId),
    gt(agentChatMessages.ordinal, ordinal),
  ];
  if (opts.preserveScheduled) {
    conds.push(sql`(${agentChatMessages.metadata} ->> 'origin') is distinct from 'scheduled'`);
  }
  await tx.delete(agentChatMessages).where(and(...conds));
}

async function incrementBranchRevision(tx: SessionTransaction, sessionId: string) {
  const [updated] = await tx
    .update(agentChatSessions)
    .set({
      branchRevision: sql`${agentChatSessions.branchRevision} + 1`,
      updatedAt: sql`now()`,
    })
    .where(eq(agentChatSessions.id, sessionId))
    .returning({ branchRevision: agentChatSessions.branchRevision });
  if (!updated) throw new ChatBranchConflictError("The chat session is gone.");
  return updated.branchRevision;
}

/** A stored turn paired with its ordinal — the unit the SSE listener pushes. */
export type OrdinalChatMessage = { ordinal: number; message: ChatUIMessage };

/**
 * Highest ordinal currently in a session, or -1 when empty. The baseline an SSE
 * subscriber starts from (when it doesn't supply its own high-water mark) so it
 * receives only turns appended after it connected — not the whole transcript it
 * already loaded.
 */
export async function getSessionMaxOrdinal(sessionId: string): Promise<number> {
  const [row] = await getDb()
    .select({ maxOrdinal: sql<number>`coalesce(max(${agentChatMessages.ordinal}), -1)` })
    .from(agentChatMessages)
    .where(eq(agentChatMessages.sessionId, sessionId));

  return Number(row?.maxOrdinal ?? -1);
}

/**
 * Turns with ordinal strictly greater than afterOrdinal, ascending — the
 * incremental tail an SSE listener flushes on each append NOTIFY. Each row
 * carries its ordinal so the listener can advance its high-water mark; the
 * client dedupes by message id, so re-delivering a turn the tab already has is
 * harmless. Unlike getChatSession this skips safeValidateUIMessages: these rows
 * were just written by appendSessionMessages, not replayed from cold storage.
 */
export async function getSessionMessagesAfter(
  sessionId: string,
  afterOrdinal: number,
): Promise<OrdinalChatMessage[]> {
  const rows = await getDb()
    .select()
    .from(agentChatMessages)
    .where(
      and(eq(agentChatMessages.sessionId, sessionId), gt(agentChatMessages.ordinal, afterOrdinal)),
    )
    .orderBy(agentChatMessages.ordinal);

  return rows.map((row) => ({
    ordinal: row.ordinal,
    message: {
      id: row.id,
      role: row.role,
      parts: row.parts,
      ...(row.metadata ? { metadata: row.metadata } : {}),
    },
  }));
}

/**
 * Map a message id to its ordinal within a session — the fork point the chat
 * route needs to drive truncateConversationAfter on edit/regenerate. Returns
 * null when the id isn't in the session (e.g. a turn that errored before it was
 * ever persisted), in which case the caller skips truncation and re-runs as-is.
 */
export async function getMessageOrdinal(
  sessionId: string,
  messageId: string,
): Promise<number | null> {
  const rows = await getDb()
    .select({ ordinal: agentChatMessages.ordinal })
    .from(agentChatMessages)
    .where(and(eq(agentChatMessages.sessionId, sessionId), eq(agentChatMessages.id, messageId)));

  return rows[0]?.ordinal ?? null;
}

/**
 * Create the dedicated home session a standalone scheduled task owns — a task
 * created without an originating chat (via API or the tasks UI). The session is
 * tagged origin = 'scheduled_task' and task_id = taskId; the partial-unique
 * index (agent_chat_sessions_task_id_uniq) guarantees at most one per task.
 *
 * Idempotent: if a dedicated session already exists for the task it's returned
 * as-is rather than inserting a duplicate the unique index would reject, so a
 * retried createScheduledTask never strands a second session. Returns the home
 * session id.
 */
export async function createTaskSession(
  taskId: string,
  title?: string | null,
  agentId: string = DEFAULT_AGENT_ID,
): Promise<string> {
  const db = getDb();

  const existing = await db
    .select({ id: agentChatSessions.id })
    .from(agentChatSessions)
    .where(eq(agentChatSessions.taskId, taskId));

  if (existing[0]) {
    return existing[0].id;
  }

  const id = randomUUID();
  // Mirror the session title CHECK (1..200 chars or null): a long task title
  // would otherwise violate it.
  const trimmedTitle = title?.trim().slice(0, MAX_TITLE_LENGTH) || null;

  const inserted = await db
    .insert(agentChatSessions)
    .values({ id, agentId, origin: "scheduled_task", taskId, title: trimmedTitle })
    .onConflictDoNothing()
    .returning({ id: agentChatSessions.id });

  if (inserted[0]) {
    return inserted[0].id;
  }

  // Lost a race to a concurrent writer; re-read the session it created.
  const winner = await db
    .select({ id: agentChatSessions.id })
    .from(agentChatSessions)
    .where(eq(agentChatSessions.taskId, taskId));

  return winner[0]?.id ?? id;
}

/** User-initiated rename — unconditional (always overwrites), unlike the auto-title path. */
export async function renameChatSession(
  id: string,
  title: string,
  agentId: string = DEFAULT_AGENT_ID,
): Promise<ChatSession> {
  const trimmed = title.trim();

  if (!trimmed) {
    throw new ChatSessionInputError("A chat session title cannot be empty.");
  }

  if (trimmed.length > MAX_TITLE_LENGTH) {
    throw new ChatSessionInputError(
      `A chat session title must be ${MAX_TITLE_LENGTH} characters or fewer.`,
    );
  }

  const rows = await getDb()
    .update(agentChatSessions)
    .set({ title: trimmed, updatedAt: sql`now()` })
    .where(
      and(
        eq(agentChatSessions.id, id),
        eq(agentChatSessions.agentId, agentId),
        isNull(agentChatSessions.deletedAt),
      ),
    )
    .returning({
      id: agentChatSessions.id,
      title: agentChatSessions.title,
      lastMessageAt: agentChatSessions.lastMessageAt,
      createdAt: agentChatSessions.createdAt,
      updatedAt: agentChatSessions.updatedAt,
    });

  const updated = rows[0];

  if (!updated) {
    throw new ChatSessionNotFoundError(id);
  }

  return {
    id: updated.id,
    title: updated.title,
    lastMessageAt: updated.lastMessageAt?.toISOString() ?? null,
    createdAt: updated.createdAt.toISOString(),
    updatedAt: updated.updatedAt.toISOString(),
  };
}

/**
 * Cheap precheck for the title path: is the session live and still untitled?
 * Lets the chat route skip the (paid, stream-blocking) title-model call on
 * regenerate or any later turn once a title exists. setSessionTitleIfUnset
 * still applies the same predicate atomically, so this is an optimization, not
 * the correctness guard.
 */
export async function sessionNeedsTitle(
  id: string,
  agentId: string = DEFAULT_AGENT_ID,
): Promise<boolean> {
  const rows = await getDb()
    .select({ id: agentChatSessions.id })
    .from(agentChatSessions)
    .where(
      and(
        eq(agentChatSessions.id, id),
        eq(agentChatSessions.agentId, agentId),
        isNull(agentChatSessions.title),
        isNull(agentChatSessions.deletedAt),
      ),
    );

  return rows.length > 0;
}

/**
 * Auto-title write from the title path: conditional on the session still being
 * untitled (and live), so concurrent completions can't clobber each other and a
 * deleted session is never titled. Returns whether a row was updated.
 */
export async function setSessionTitleIfUnset(
  id: string,
  title: string,
  agentId: string = DEFAULT_AGENT_ID,
): Promise<boolean> {
  const trimmed = title.trim().slice(0, MAX_TITLE_LENGTH);

  if (!trimmed) {
    return false;
  }

  const rows = await getDb()
    .update(agentChatSessions)
    .set({ title: trimmed, updatedAt: sql`now()` })
    .where(
      and(
        eq(agentChatSessions.id, id),
        eq(agentChatSessions.agentId, agentId),
        isNull(agentChatSessions.title),
        isNull(agentChatSessions.deletedAt),
      ),
    )
    .returning({ id: agentChatSessions.id });

  return rows.length > 0;
}

/** Soft delete, mirroring agent_skills. */
export async function deleteChatSession(
  id: string,
  agentId: string = DEFAULT_AGENT_ID,
): Promise<void> {
  const rows = await getDb()
    .update(agentChatSessions)
    .set({ deletedAt: sql`now()`, updatedAt: sql`now()` })
    .where(
      and(
        eq(agentChatSessions.id, id),
        eq(agentChatSessions.agentId, agentId),
        isNull(agentChatSessions.deletedAt),
      ),
    )
    .returning({ id: agentChatSessions.id });

  if (rows.length === 0) {
    throw new ChatSessionNotFoundError(id);
  }
}

function mapSession(session: typeof agentChatSessions.$inferSelect): ChatSession {
  return {
    id: session.id,
    title: session.title,
    lastMessageAt: session.lastMessageAt?.toISOString() ?? null,
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
  };
}

function mapMessage(
  row: typeof agentChatMessages.$inferSelect,
  parts: ChatUIMessage["parts"],
): ChatUIMessage {
  return {
    id: row.id,
    role: row.role,
    parts,
    ...(row.metadata ? { metadata: row.metadata } : {}),
  };
}

/** Top of the sidebar list — drives auto-resume on load. */
export async function getMostRecentSessionId(
  agentId: string = DEFAULT_AGENT_ID,
): Promise<string | null> {
  const rows = await getDb()
    .select({ id: agentChatSessions.id })
    .from(agentChatSessions)
    .where(and(eq(agentChatSessions.agentId, agentId), isNull(agentChatSessions.deletedAt)))
    .orderBy(
      desc(sql`coalesce(${agentChatSessions.lastMessageAt}, ${agentChatSessions.createdAt})`),
    )
    .limit(1);

  return rows[0]?.id ?? null;
}
