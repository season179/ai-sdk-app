import { safeValidateUIMessages, type UIMessage } from "ai";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";

import { getDb } from "@/db";
import { agentChatMessages, agentChatSessions } from "@/db/schema";
import { DEFAULT_AGENT_ID } from "@/lib/skills/skills";
import type { ChatMessageMetadata } from "@/lib/token-usage";

type ChatUIMessage = UIMessage<ChatMessageMetadata>;

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

export type SaveChatSessionInput = {
  sessionId: string;
  messages: ChatUIMessage[];
  agentId?: string;
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
    session: {
      id: session.id,
      title: session.title,
      lastMessageAt: session.lastMessageAt?.toISOString() ?? null,
      createdAt: session.createdAt.toISOString(),
      updatedAt: session.updatedAt.toISOString(),
    },
    messages: validation.success ? validation.data : stored,
  };
}

/**
 * Persist the whole transcript in one transaction via delete-all-then-insert:
 * deterministic, correct for edit/regenerate truncation, and free of the
 * ordinal-shift collisions a per-row upsert would hit. Refuses soft-deleted
 * sessions so a stale tab can't resurrect or hidden-append to one.
 */
export async function saveChatSession({
  sessionId,
  messages,
  agentId = DEFAULT_AGENT_ID,
}: SaveChatSessionInput): Promise<void> {
  // The composite PK (sessionId, id) would make the bulk insert throw on a
  // duplicate id, so reject it up front with a typed error.
  const uniqueIds = new Set(messages.map((message) => message.id));
  if (uniqueIds.size !== messages.length) {
    throw new ChatSessionInputError("Chat messages must have unique ids within a session.");
  }

  await getDb().transaction(async (tx) => {
    const existing = await tx
      .select({ deletedAt: agentChatSessions.deletedAt })
      .from(agentChatSessions)
      .where(eq(agentChatSessions.id, sessionId));

    if (existing[0]?.deletedAt) {
      throw new ChatSessionInputError(`Chat session '${sessionId}' was deleted; refusing to save.`);
    }

    // Create on first save; bump activity + updated timestamps thereafter.
    await tx
      .insert(agentChatSessions)
      .values({ id: sessionId, agentId, lastMessageAt: sql`now()` })
      .onConflictDoUpdate({
        target: agentChatSessions.id,
        set: { lastMessageAt: sql`now()`, updatedAt: sql`now()` },
      });

    await tx.delete(agentChatMessages).where(eq(agentChatMessages.sessionId, sessionId));

    if (messages.length > 0) {
      await tx.insert(agentChatMessages).values(
        messages.map((message, index) => ({
          id: message.id,
          sessionId,
          role: message.role,
          parts: message.parts,
          metadata: message.metadata ?? null,
          ordinal: index,
        })),
      );
    }
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
  opts: { agentId?: string; createIfMissing?: boolean } = {},
): Promise<void> {
  if (messages.length === 0) {
    return;
  }

  // The composite PK (sessionId, id) would make the bulk insert throw on a
  // duplicate id within this batch, so reject it up front with a typed error.
  const uniqueIds = new Set(messages.map((message) => message.id));
  if (uniqueIds.size !== messages.length) {
    throw new ChatSessionInputError("Chat messages must have unique ids within a batch.");
  }

  await getDb().transaction(async (tx) => {
    const existing = await tx
      .select({ deletedAt: agentChatSessions.deletedAt })
      .from(agentChatSessions)
      .where(eq(agentChatSessions.id, sessionId));

    if (existing.length === 0) {
      if (!opts.createIfMissing) {
        throw new ChatSessionNotFoundError(sessionId);
      }
      await tx
        .insert(agentChatSessions)
        .values({
          id: sessionId,
          agentId: opts.agentId ?? DEFAULT_AGENT_ID,
          lastMessageAt: sql`now()`,
        })
        .onConflictDoNothing();
    } else if (existing[0]?.deletedAt) {
      throw new ChatSessionInputError(
        `Chat session '${sessionId}' was deleted; refusing to append.`,
      );
    }

    // Continue ordinals from the current max. -1 + 1 = 0 for an empty session.
    const [{ nextOrdinal }] = await tx
      .select({
        nextOrdinal: sql<number>`coalesce(max(${agentChatMessages.ordinal}), -1) + 1`,
      })
      .from(agentChatMessages)
      .where(eq(agentChatMessages.sessionId, sessionId));

    await tx
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
      .onConflictDoNothing();

    await tx
      .update(agentChatSessions)
      .set({ lastMessageAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(agentChatSessions.id, sessionId));
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
): Promise<void> {
  const conds = [
    eq(agentChatMessages.sessionId, sessionId),
    gt(agentChatMessages.ordinal, ordinal),
  ];
  if (opts.preserveScheduled) {
    conds.push(sql`(${agentChatMessages.metadata} ->> 'origin') is distinct from 'scheduled'`);
  }
  await getDb()
    .delete(agentChatMessages)
    .where(and(...conds));
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
