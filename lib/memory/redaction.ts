import { createHash } from "node:crypto";

import {
  TRACE_ARTIFACT_EXCERPT_MAX_CHARS,
  TRACE_ARTIFACT_MAX_BYTES,
  TRACE_PAYLOAD_MAX_BYTES,
} from "@/lib/memory/config";

export type TraceArtifactInput = {
  artifactHash: string;
  mediaType: string;
  byteSize: number;
  encoding: string | null;
  redactedExcerpt: string;
  content: Buffer | null;
  sensitivityClass: "normal" | "sensitive" | "restricted";
  expiresAt?: Date | null;
};

export type SanitizedTracePayload = {
  payload: Record<string, unknown>;
  contentHash: string;
  artifact?: TraceArtifactInput;
  sensitivityClass: "normal" | "sensitive" | "restricted";
  secretDetected: boolean;
  injectionDetected: boolean;
};

const PRIVATE_KEY =
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi;
const PROVIDER_TOKEN =
  /\b(?:sk-(?:proj-)?|sk-or-v1-|ghp_|github_pat_|xox[baprs]-|AIza)[A-Za-z0-9_\-.]{12,}/g;
const CREDENTIAL_ASSIGNMENT =
  /\b(?:api[_-]?key|access[_-]?token|secret|password|passwd)\s*[:=]\s*["']?[^\s,"'}]{6,}/gi;
const INJECTION_PATTERNS = [
  /ignore\s+(?:all\s+)?(?:previous|prior|system)\s+instructions/i,
  /reveal\s+(?:the\s+)?(?:system prompt|hidden instructions|secrets?)/i,
  /(?:send|exfiltrate|upload)\s+.{0,40}(?:credentials?|tokens?|secrets?)/i,
  /override\s+(?:safety|permissions?|policy)/i,
];

export function detectSecret(value: string): boolean {
  return [PRIVATE_KEY, BEARER, PROVIDER_TOKEN, CREDENTIAL_ASSIGNMENT].some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  });
}

export function detectPromptInjection(value: string): boolean {
  return INJECTION_PATTERNS.some((pattern) => pattern.test(value));
}

export function redactText(value: string): { text: string; secretDetected: boolean } {
  let secretDetected = false;
  let text = value;
  for (const pattern of [PRIVATE_KEY, BEARER, PROVIDER_TOKEN, CREDENTIAL_ASSIGNMENT]) {
    pattern.lastIndex = 0;
    text = text.replace(pattern, () => {
      secretDetected = true;
      return "[REDACTED_SECRET]";
    });
  }
  return { text, secretDetected };
}

function sanitizeValue(value: unknown, state: { secretDetected: boolean }): unknown {
  if (typeof value === "string") {
    const redacted = redactText(value);
    state.secretDetected ||= redacted.secretDetected;
    return redacted.text;
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, state));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      if (
        /reasoning|reasoningText|requestBody|providerRequest|apiContent|injectedMessages/i.test(key)
      ) {
        continue;
      }
      out[key] = sanitizeValue((value as Record<string, unknown>)[key], state);
    }
    return out;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map(
      (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
    )
    .join(",")}}`;
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sanitizeTracePayload(input: Record<string, unknown>): SanitizedTracePayload {
  const state = { secretDetected: false };
  const sanitized = sanitizeValue(input, state) as Record<string, unknown>;
  const serialized = canonicalJson(sanitized);
  const serializedBytes = Buffer.from(serialized);
  const contentHash = sha256(serializedBytes);
  const injectionDetected = detectPromptInjection(serialized);
  const sensitivityClass = state.secretDetected ? "sensitive" : "normal";
  let artifact: TraceArtifactInput | undefined;

  if (serializedBytes.byteLength > TRACE_PAYLOAD_MAX_BYTES) {
    const bounded = serializedBytes.subarray(0, TRACE_ARTIFACT_MAX_BYTES);
    // Identity covers the entire redacted payload; storage is capped separately.
    artifact = {
      artifactHash: contentHash,
      mediaType: "application/json",
      byteSize: serializedBytes.byteLength,
      encoding: "utf-8",
      redactedExcerpt: bounded.toString("utf8").slice(0, TRACE_ARTIFACT_EXCERPT_MAX_CHARS),
      content: bounded,
      sensitivityClass,
    };
    for (const key of Object.keys(sanitized)) delete sanitized[key];
    sanitized.overflow = {
      artifactHash: contentHash,
      originalByteSize: serializedBytes.byteLength,
      storedByteSize: bounded.byteLength,
      truncated: bounded.byteLength < serializedBytes.byteLength,
    };
  }

  return {
    payload: sanitized,
    contentHash,
    artifact,
    sensitivityClass,
    secretDetected: state.secretDetected,
    injectionDetected,
  };
}
