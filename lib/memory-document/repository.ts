import "server-only";

import { and, eq } from "drizzle-orm";

import { type AppDb, getDb } from "@/db";
import { agentMemoryDocuments } from "@/db/schema";
import { getMemoryPolicyVersion } from "@/lib/memory/config";
import { canonicalJson, sha256 } from "@/lib/memory/redaction";
import { appendTraceEvents } from "@/lib/memory/trace";
import {
  MemoryDocumentValidationError,
  projectMemoryDocument,
  validateMemoryEntries,
} from "@/lib/memory-document/format";
import type {
  MemoryDocument,
  MemoryDocumentEntry,
  MemoryWriteMetadata,
  MemoryWriteSource,
} from "@/lib/memory-document/types";

export type CommitMemoryDocumentInput = {
  agentId: string;
  expectedVersion: number;
  entries: MemoryDocumentEntry[];
  source: MemoryWriteSource;
  metadata: MemoryWriteMetadata;
  sessionId?: string | null;
  messageId?: string | null;
  now?: Date;
};

export type CommitMemoryDocumentResult =
  | { status: "applied"; version: number }
  | { status: "conflict"; version: number };

export function emptyMemoryDocument(agentId: string): MemoryDocument {
  return {
    agentId,
    version: 0,
    indexBody: "",
    details: [],
    indexTokenCount: 0,
    detailsTokenCount: 0,
    createdAt: null,
    updatedAt: null,
  };
}

export async function readMemoryDocument(
  agentId: string,
  db: AppDb = getDb(),
): Promise<MemoryDocument> {
  const [row] = await db
    .select()
    .from(agentMemoryDocuments)
    .where(eq(agentMemoryDocuments.agentId, agentId))
    .limit(1);
  if (!row) return emptyMemoryDocument(agentId);

  const document: MemoryDocument = {
    agentId: row.agentId,
    version: row.version,
    indexBody: row.indexBody,
    details: row.details,
    indexTokenCount: row.indexTokenCount,
    detailsTokenCount: row.detailsTokenCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  validateStoredDocument(document);
  return document;
}

export async function commitMemoryDocument(
  input: CommitMemoryDocumentInput,
  db: AppDb = getDb(),
): Promise<CommitMemoryDocumentResult> {
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw new MemoryDocumentValidationError("Expected memory version must be non-negative.");
  }
  const projection = validateMemoryEntries(input.entries);
  if (
    input.metadata.entryCount !== projection.details.length ||
    input.metadata.indexTokenCount !== projection.indexTokenCount ||
    input.metadata.detailsTokenCount !== projection.detailsTokenCount
  ) {
    throw new MemoryDocumentValidationError("Memory write metadata does not match its document.");
  }
  const resultingVersion = input.expectedVersion + 1;
  const now = input.now ?? new Date();

  return db.transaction(async (tx) => {
    const values = {
      agentId: input.agentId,
      version: resultingVersion,
      indexBody: projection.indexBody,
      details: projection.details,
      indexTokenCount: projection.indexTokenCount,
      detailsTokenCount: projection.detailsTokenCount,
      updatedAt: now,
    };
    const changed =
      input.expectedVersion === 0
        ? await tx
            .insert(agentMemoryDocuments)
            .values({ ...values, createdAt: now })
            .onConflictDoNothing({ target: agentMemoryDocuments.agentId })
            .returning({ version: agentMemoryDocuments.version })
        : await tx
            .update(agentMemoryDocuments)
            .set(values)
            .where(
              and(
                eq(agentMemoryDocuments.agentId, input.agentId),
                eq(agentMemoryDocuments.version, input.expectedVersion),
              ),
            )
            .returning({ version: agentMemoryDocuments.version });

    if (changed.length === 0) {
      const [winner] = await tx
        .select({ version: agentMemoryDocuments.version })
        .from(agentMemoryDocuments)
        .where(eq(agentMemoryDocuments.agentId, input.agentId))
        .limit(1);
      return { status: "conflict", version: winner?.version ?? input.expectedVersion };
    }

    const payload = {
      source: input.source,
      version: resultingVersion,
      affectedKeys: input.metadata.affectedKeys,
      newKeys: input.metadata.newKeys,
      droppedKeys: input.metadata.droppedKeys,
      indexTokenCount: projection.indexTokenCount,
      detailsTokenCount: projection.detailsTokenCount,
    };
    await appendTraceEvents(
      [
        {
          agentId: input.agentId,
          traceId: `memory-document:${input.agentId}:${resultingVersion}`,
          sequenceNo: 0,
          sessionId: input.sessionId ?? null,
          sourceMessageId: input.messageId ?? null,
          eventType: "explicit_memory_write",
          actor: input.source === "tool" ? "tool" : "user",
          trustClass: "user_assertion",
          payload,
          contentHash: sha256(canonicalJson(payload)),
          idempotencyKey: `memory-document:${input.agentId}:v${resultingVersion}`,
          retentionClass: "audit",
          policyVersion: getMemoryPolicyVersion(),
          occurredAt: now,
        },
      ],
      tx,
    );

    return { status: "applied", version: resultingVersion };
  });
}

function validateStoredDocument(document: MemoryDocument): void {
  if (!Number.isInteger(document.version) || document.version < 0) {
    throw new MemoryDocumentValidationError("Stored memory version is invalid.");
  }
  const projection = validateMemoryEntries(document.details, { safety: false });
  if (
    projection.indexBody !== document.indexBody ||
    projection.indexTokenCount !== document.indexTokenCount ||
    projection.detailsTokenCount !== document.detailsTokenCount
  ) {
    throw new MemoryDocumentValidationError("Stored memory projections or estimates do not agree.");
  }
}

export function buildDocumentFromEntries(
  agentId: string,
  version: number,
  entries: readonly MemoryDocumentEntry[],
): MemoryDocument {
  const projection = projectMemoryDocument(entries);
  return {
    agentId,
    version,
    indexBody: projection.indexBody,
    details: projection.details,
    indexTokenCount: projection.indexTokenCount,
    detailsTokenCount: projection.detailsTokenCount,
    createdAt: null,
    updatedAt: null,
  };
}
