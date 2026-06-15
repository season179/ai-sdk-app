import { safeValidateUIMessages, type UIMessage } from "ai";
import { and, desc, eq, isNull, sql } from "drizzle-orm";

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
