/**
 * Trusted calling context (API_CONTRACT §1). Constructed by the HOST from its
 * authenticated session — never assembled from LLM tool parameters. The
 * factory therefore takes every identity field explicitly and validates it;
 * there is no path that reads workspaceId/principalId out of a ToolRequest.
 */
import { randomUUID } from "node:crypto";
import { WorkbenchError, ERROR_CODES } from "@latexwb/contracts";
import { isCapability, type Capability } from "./capabilities.ts";

export interface RequestContext {
  readonly workspaceId: string;
  readonly principalId: string;
  readonly sessionId: string;
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly policyId: string;
  readonly grantedCapabilities: ReadonlySet<Capability>;
  readonly signal: AbortSignal;
}

export interface RequestContextInput {
  workspaceId: string;
  principalId: string;
  sessionId: string;
  /** Host-generated; defaults to a fresh UUID when the host does not supply one. */
  requestId?: string | undefined;
  /** Host-generated; defaults to a fresh UUID when the host does not supply one. */
  idempotencyKey?: string | undefined;
  policyId: string;
  grantedCapabilities: Iterable<Capability>;
  signal?: AbortSignal | undefined;
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

/**
 * Host principal ids are deliberately wider than structural ids: operators
 * are normally identified email-style (`alice@example.com`) or with plus
 * tags (`alice+review@example.com`). Still rejected: whitespace, control
 * characters, `/`, quotes, and empty strings — nothing that can break a
 * path component, a log line, or a principal match.
 */
export const PRINCIPAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:@+-]*$/;

export function checkPrincipalId(name: string, value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 160 ||
    !PRINCIPAL_ID_PATTERN.test(value)
  ) {
    throw new WorkbenchError(
      ERROR_CODES.INVALID_REQUEST,
      `RequestContext: invalid ${name} ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function checkId(name: string, value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 160 || !ID_PATTERN.test(value)) {
    throw new WorkbenchError(
      ERROR_CODES.INVALID_REQUEST,
      `RequestContext: invalid ${name} ${JSON.stringify(value)}`,
    );
  }
  return value;
}

export function createRequestContext(input: RequestContextInput): RequestContext {
  const granted = new Set<Capability>();
  for (const cap of input.grantedCapabilities) {
    if (!isCapability(cap)) {
      throw new WorkbenchError(
        ERROR_CODES.INVALID_REQUEST,
        `RequestContext: unknown capability ${JSON.stringify(cap)}`,
      );
    }
    granted.add(cap);
  }
  const requestId = input.requestId ?? randomUUID();
  const idempotencyKey = input.idempotencyKey ?? randomUUID();
  return {
    workspaceId: checkId("workspaceId", input.workspaceId),
    principalId: checkPrincipalId("principalId", input.principalId),
    sessionId: checkId("sessionId", input.sessionId),
    requestId: checkId("requestId", requestId),
    idempotencyKey: checkId("idempotencyKey", idempotencyKey),
    policyId: checkId("policyId", input.policyId),
    grantedCapabilities: granted,
    signal: input.signal ?? new AbortController().signal,
  };
}
