import { createHash } from "node:crypto";

import {
  TRACE_ARTIFACT_EXCERPT_MAX_CHARS,
  TRACE_ARTIFACT_MAX_BYTES,
  TRACE_PAYLOAD_MAX_BYTES,
} from "@/lib/memory/config";
import { redactReadProjection } from "@/lib/memory/projection-safety";

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
  /\b(?:api[_-]?key|access[_-]?token|secret|password|passwd)\s*[:=]\s*["']?[^\s,"'}]{4,}/gi;
const NATURAL_LANGUAGE_CREDENTIAL =
  /\b(?:my\s+)?(?:password|passcode|pin|otp|one[-\s]?time\s+(?:password|code)|verification\s+code|recovery\s+(?:code|key)|backup\s+code|private\s+key|secret\s+key|api\s+key|access\s+token)\s+(?:is|was|equals?|reads?)\s+["']?[^\s,"'}]{3,}/gi;
// Connector-free credentials need a value-like token so ordinary phrases such
// as "password manager" and "api key rotation" remain safe.
const APPOSITIONAL_CREDENTIAL =
  /\b(?:(?:my|the|your|our|their)\s+)?(?:password|passcode|pin|otp|one[-\s]?time\s+(?:password|code)|verification\s+code|recovery\s+(?:code|key)|backup\s+code|private\s+key|secret\s+key|api\s+key|access\s+token)\s+["']?(?=[^\s,"'}]{3,}(?:[\s,"'}]|$))(?=[^\s,"'}]*(?:\d|[-_=+/~]))[^\s,"'}]+["']?/gi;
const HIGH_RISK_IDENTIFIER =
  /\b(?:social\s+security\s+number|ssn|seed\s+phrase)\s*(?:is|:|=)\s*["']?[A-Za-z0-9][A-Za-z0-9\s-]{5,}/gi;
const CARD_CANDIDATE =
  /\b(?:my\s+)?(?:(?:credit|debit)\s+)?card(?:\s+number)?\s+(?:is|was|equals?|reads?)\s+["']?([0-9][0-9 -]{11,22}[0-9])/gi;
const CARD_SECURITY_CODE =
  /\b(?:my\s+)?(?:cvv|cvc|card\s+security\s+code)\s+(?:is|was|equals?|reads?)\s+["']?\d{3,4}\b/gi;
const INJECTION_PATTERNS = [
  /(?:ignor(?:e|es|ed|ing)|disregard(?:s|ed|ing)?|overrid(?:e|es|den|ing)|overrode|forget(?:s|ting)?|forgot(?:ten)?|bypass(?:es|ed|ing)?|do\s+not\s+follow)\s+(?:the\s+)?(?:all\s+)?(?:previous|prior|earlier|system|developer|safety)?\s*(?:instructions|directions|rules|policy|prompt)/i,
  /reveal\s+(?:the\s+)?(?:system prompt|developer message|hidden instructions|secrets?)/i,
  /(?:send|exfiltrate|upload|leak)\s+.{0,60}(?:credentials?|tokens?|secrets?|private data)/i,
  /(?:overrid(?:e|es|den|ing)|overrode|disabl(?:e|es|ed|ing)|chang(?:e|es|ed|ing)|grant(?:s|ed|ing)?|elevat(?:e|es|ed|ing))\s+.{0,30}(?:safety|permissions?|policy|authorization|access)/i,
  /(?:always|must|immediately)\s+(?:call|invoke|execute|run|use)\s+[a-z][a-z0-9_.-]{2,}/i,
  /(?:call|invoke|execute|run|use)\s+(?:the\s+)?(?:tool|function)\s+[a-z][a-z0-9_.-]{2,}/i,
  /(?:you\s+are\s+now|act\s+as|treat\s+(?:this|me)\s+as)\s+(?:a\s+)?(?:system|developer|administrator|root)/i,
  /(?:system|developer|assistant)\s*(?:message|instructions?)\s*:/i,
  /(?:^|\n)\s*```(?:system|developer|assistant|tool|prompt)?/i,
  /<\/?(?:system|developer|assistant|tool|profile_text)\b/i,
  /(?:begin|end)\s+(?:system|developer|hidden)\s+(?:prompt|instructions|message)/i,
];

const SECRET_PATTERNS = [
  PRIVATE_KEY,
  BEARER,
  PROVIDER_TOKEN,
  CREDENTIAL_ASSIGNMENT,
  NATURAL_LANGUAGE_CREDENTIAL,
  APPOSITIONAL_CREDENTIAL,
  HIGH_RISK_IDENTIFIER,
];

export function detectSecret(value: string): boolean {
  if (
    SECRET_PATTERNS.some((pattern) => {
      pattern.lastIndex = 0;
      return pattern.test(value);
    })
  ) {
    return true;
  }
  CARD_SECURITY_CODE.lastIndex = 0;
  if (CARD_SECURITY_CODE.test(value)) return true;
  return cardCandidates(value).some((candidate) => passesLuhn(candidate));
}

export function detectPromptInjection(value: string): boolean {
  if (redactReadProjection(value).contaminated) return true;
  return INJECTION_PATTERNS.some((pattern) => pattern.test(value));
}

export function redactText(value: string): { text: string; secretDetected: boolean } {
  let secretDetected = false;
  let text = value;
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    text = text.replace(pattern, () => {
      secretDetected = true;
      return "[REDACTED_SECRET]";
    });
  }
  CARD_SECURITY_CODE.lastIndex = 0;
  text = text.replace(CARD_SECURITY_CODE, () => {
    secretDetected = true;
    return "[REDACTED_SECRET]";
  });
  CARD_CANDIDATE.lastIndex = 0;
  text = text.replace(CARD_CANDIDATE, (match, candidate: string) => {
    if (!passesLuhn(candidate)) return match;
    secretDetected = true;
    return "[REDACTED_SECRET]";
  });
  return { text, secretDetected };
}

function cardCandidates(value: string): string[] {
  CARD_CANDIDATE.lastIndex = 0;
  return [...value.matchAll(CARD_CANDIDATE)].map((match) => match[1]);
}

function passesLuhn(value: string): boolean {
  const digits = value.replace(/[^0-9]/g, "");
  if (digits.length < 13 || digits.length > 19 || /^(\d)\1+$/u.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
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
