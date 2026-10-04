/**
 * Outgoing ToolEnvelope construction. Every value a latex_* tool returns is
 * built and schema-validated here before it leaves the adapter — a bad
 * envelope is a bug, so validation failure throws rather than degrading.
 */
import { randomUUID } from "node:crypto";
import {
  ERROR_CODES,
  WorkbenchError,
  formatErrors,
  validators,
  type ToolData,
  type ToolEnvelope,
  type ToolError,
} from "@latexwb/contracts";

const validateEnvelope = validators.ToolEnvelope;

export function makeRequestId(): string {
  return `req-${randomUUID()}`;
}

// ---------------------------------------------------------------------------
// SECURITY-11: terminal-hygiene on model-facing text. A build diagnostic or
// file payload can carry ANSI CSI/OSC sequences or C0/C1 controls that would
// inject terminal state into the host transcript (OSC-8 hyperlinks, color,
// title-set). Before serialization every envelope string is cleaned:
//   - ANSI OSC sequences (incl. OSC-8 hyperlinks) are removed entirely —
//     they are markup, not content;
//   - ANSI CSI sequences (colors, cursor movement) are removed;
//   - other ESC-initiated sequences (charset/designation) are removed;
//   - remaining C0 controls (except \n and \t), DEL, and C1 controls become
//     U+FFFD so the deletion is visible, never silent;
//   - CRLF / lone CR normalize to \n.
// Nothing is fabricated: text is stripped or marked, never replaced with
// invented content.
// ---------------------------------------------------------------------------

const ANSI_OSC = /\x1b\][^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)|\x9d[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)/g;
const ANSI_CSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x9b[0-?]*[ -/]*[@-~]/g;
const ANSI_ESC = /\x1b[ -/]*[@-~]/g;
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;

export function sanitizeText(text: string): string {
  return text
    .replace(ANSI_OSC, "")
    .replace(ANSI_CSI, "")
    .replace(ANSI_ESC, "")
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL, "\uFFFD");
}

/** Recursively sanitize every string in a JSON-shaped envelope value. */
export function sanitizeForModel(value: unknown): unknown {
  if (typeof value === "string") return sanitizeText(value);
  if (Array.isArray(value)) return value.map(sanitizeForModel);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      out[key] = sanitizeForModel(v);
    }
    return out;
  }
  return value;
}

export function toToolError(err: unknown): ToolError {
  if (err instanceof WorkbenchError) {
    return { code: err.code, message: err.message, retryable: err.retryable };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    code: ERROR_CODES.INVALID_REQUEST,
    message: `unexpected adapter failure: ${message}`,
    retryable: false,
  };
}

export interface EnvelopeParts {
  requestId: string;
  projectId: string;
  snapshotId: string | null;
  execution: ToolEnvelope["execution"];
  data: ToolData | null;
  error: ToolError | null;
  diagnostics?: ToolEnvelope["diagnostics"];
  artifacts?: ToolEnvelope["artifacts"];
}

export function buildEnvelope(parts: EnvelopeParts): ToolEnvelope {
  const envelope: ToolEnvelope = {
    schemaVersion: 1,
    requestId: parts.requestId,
    projectId: parts.projectId,
    snapshotId: parts.snapshotId,
    execution: parts.execution,
    data: parts.data,
    error: parts.error,
    diagnostics: parts.diagnostics ?? [],
    artifacts: parts.artifacts ?? [],
  };
  if (!validateEnvelope(envelope)) {
    throw new WorkbenchError(
      ERROR_CODES.SCHEMA_VALIDATION_FAILED,
      `adapter produced an invalid ToolEnvelope: ${formatErrors(validateEnvelope.errors)}`,
    );
  }
  return envelope;
}

/**
 * Convert any failure into a schema-valid error envelope. This is the last
 * line of defence in every tool's execute(): nothing unstructured escapes.
 */
export function failureEnvelope(
  requestId: string,
  projectId: string | null,
  snapshotId: string | null,
  err: unknown,
): ToolEnvelope {
  const error = toToolError(err);
  return buildEnvelope({
    requestId,
    projectId: projectId ?? "unbound",
    snapshotId,
    execution: "failed",
    data: null,
    error,
  });
}

/** The honest answer for surfaces that exist in the contract but not yet in code. */
export function blockedEnvelope(
  requestId: string,
  projectId: string,
  snapshotId: string | null,
  milestone: string,
  surface: string,
): ToolEnvelope {
  return buildEnvelope({
    requestId,
    projectId,
    snapshotId,
    execution: "blocked",
    data: null,
    error: {
      code: ERROR_CODES.NOT_IMPLEMENTED,
      message: `${surface} is not implemented in M2; it is scheduled for ${milestone}`,
      retryable: false,
    },
  });
}
