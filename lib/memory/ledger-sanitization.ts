import type { SensitivityClass } from "@/db/schema";
import { canonicalJson, sanitizeTracePayload, sha256 } from "@/lib/memory/redaction";

const ARRAY_MAX_ITEMS = 16;
const ARRAY_ITEM_MAX_CHARS = 500;
const METRICS_MAX_BYTES = 8_192;

function text(value: string | null | undefined, max: number): string | null {
  if (value == null) return null;
  return value.trim().slice(0, max);
}

function list(values: string[] | undefined): string[] {
  return (values ?? [])
    .slice(0, ARRAY_MAX_ITEMS)
    .map((value) => value.trim().slice(0, ARRAY_ITEM_MAX_CHARS))
    .filter(Boolean);
}

function boundedMetrics(value: Record<string, unknown> | undefined) {
  const sanitized = sanitizeTracePayload({ metrics: value ?? {} });
  const metrics =
    sanitized.payload.metrics &&
    typeof sanitized.payload.metrics === "object" &&
    !Array.isArray(sanitized.payload.metrics)
      ? (sanitized.payload.metrics as Record<string, unknown>)
      : {};
  const serialized = canonicalJson(metrics);
  return {
    metrics:
      Buffer.byteLength(serialized) <= METRICS_MAX_BYTES
        ? metrics
        : { truncated: true, contentHash: sha256(serialized) },
    secretDetected: sanitized.secretDetected,
    injectionDetected: sanitized.injectionDetected,
  };
}

export type SanitizedLedger<T> = {
  value: T;
  sensitivityClass: SensitivityClass;
  injectionDetected: boolean;
};

export function sanitizeDecisionLedger(input: {
  selectedOption: string;
  declaredOptions?: string[];
  declaredRationale: string;
  assumptions?: string[];
  expectedOutcome?: string | null;
  successCriteria: string[];
  constraints?: string[];
}): SanitizedLedger<{
  selectedOption: string;
  declaredOptions: string[];
  declaredRationale: string;
  assumptions: string[];
  expectedOutcome: string | null;
  successCriteria: string[];
  constraints: string[];
}> {
  const bounded = {
    selectedOption: text(input.selectedOption, 500) ?? "",
    declaredOptions: list(input.declaredOptions),
    declaredRationale: text(input.declaredRationale, 2_000) ?? "",
    assumptions: list(input.assumptions),
    expectedOutcome: text(input.expectedOutcome, 2_000),
    successCriteria: list(input.successCriteria),
    constraints: list(input.constraints),
  };
  if (!bounded.selectedOption || !bounded.declaredRationale) {
    throw new Error("Decision option and rationale are required after sanitization.");
  }
  const sanitized = sanitizeTracePayload(bounded);
  return {
    value: sanitized.payload as typeof bounded,
    sensitivityClass: sanitized.sensitivityClass,
    injectionDetected: sanitized.injectionDetected,
  };
}

export function sanitizeOutcomeLedger(input: {
  observedState: string;
  metrics?: Record<string, unknown>;
}): SanitizedLedger<{ observedState: string; metrics: Record<string, unknown> }> {
  const metrics = boundedMetrics(input.metrics);
  const bounded = {
    observedState: text(input.observedState, 4_000) ?? "",
    metrics: metrics.metrics,
  };
  if (!bounded.observedState) throw new Error("Outcome observed state is required.");
  const sanitized = sanitizeTracePayload(bounded);
  return {
    value: sanitized.payload as typeof bounded,
    sensitivityClass: sanitized.secretDetected || metrics.secretDetected ? "sensitive" : "normal",
    injectionDetected: sanitized.injectionDetected || metrics.injectionDetected,
  };
}
