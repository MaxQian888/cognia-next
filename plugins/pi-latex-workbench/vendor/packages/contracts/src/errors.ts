/**
 * Single source of truth for error codes.
 * Families: IMPLEMENTATION_SPEC §9 diagnostic/build families, plus the
 * protocol-level codes used by API_CONTRACT / service semantics.
 */

export const ERROR_CODES = {
  // --- Build/diagnostic families (IMPLEMENTATION_SPEC §9) ---
  UNDEFINED_CONTROL_SEQUENCE: "UNDEFINED_CONTROL_SEQUENCE",
  MISSING_PACKAGE: "MISSING_PACKAGE",
  MISSING_FONT: "MISSING_FONT",
  ENGINE_MISMATCH: "ENGINE_MISMATCH",
  MISMATCHED_ENVIRONMENT: "MISMATCHED_ENVIRONMENT",
  UNDEFINED_REFERENCE: "UNDEFINED_REFERENCE",
  UNDEFINED_CITATION: "UNDEFINED_CITATION",
  DUPLICATE_LABEL: "DUPLICATE_LABEL",
  MISSING_GLYPH: "MISSING_GLYPH",
  MISSING_ASSET: "MISSING_ASSET",
  OVERFULL_BOX: "OVERFULL_BOX",
  BIBLIOGRAPHY_FAILURE: "BIBLIOGRAPHY_FAILURE",
  BUILD_TIMEOUT: "BUILD_TIMEOUT",
  RESOURCE_LIMIT: "RESOURCE_LIMIT",
  INVALID_ARTIFACT: "INVALID_ARTIFACT",

  // --- Protocol / service-level codes (API_CONTRACT, SPEC §4-§8) ---
  STALE_BASE: "STALE_BASE",
  POLICY_DENIED: "POLICY_DENIED",
  TARGET_AMBIGUOUS: "TARGET_AMBIGUOUS",
  UNSUPPORTED_PATH: "UNSUPPORTED_PATH",
  SOURCE_CHANGED_DURING_SNAPSHOT: "SOURCE_CHANGED_DURING_SNAPSHOT",
  CHECKS_NOT_EXECUTED: "CHECKS_NOT_EXECUTED",
  CURSOR_EXPIRED: "CURSOR_EXPIRED",

  // --- Generic service semantics (HTTP mapping §6.3) ---
  INVALID_REQUEST: "INVALID_REQUEST",
  NOT_FOUND: "NOT_FOUND",
  IDEMPOTENCY_CONFLICT: "IDEMPOTENCY_CONFLICT",
  INPUT_TOO_LARGE: "INPUT_TOO_LARGE",
  CONFIG_INVALID: "CONFIG_INVALID",
  QUOTA_EXCEEDED: "QUOTA_EXCEEDED",
  RUNTIME_UNAVAILABLE: "RUNTIME_UNAVAILABLE",
  SCHEMA_VALIDATION_FAILED: "SCHEMA_VALIDATION_FAILED",
  DIGEST_MISMATCH: "DIGEST_MISMATCH",
  MIGRATION_CHECKSUM_MISMATCH: "MIGRATION_CHECKSUM_MISMATCH",

  // --- Explicitly unimplemented surfaces (AGENTS.md: no fake completion) ---
  NOT_IMPLEMENTED: "NOT_IMPLEMENTED",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/**
 * HTTP status hint for adapters that map errors onto the optional HTTP
 * surface (API_CONTRACT §6.3). Undefined means no canonical mapping.
 */
export const ERROR_HTTP_STATUS: Readonly<Partial<Record<ErrorCode, number>>> = {
  INVALID_REQUEST: 400,
  SCHEMA_VALIDATION_FAILED: 400,
  POLICY_DENIED: 403,
  NOT_FOUND: 404,
  STALE_BASE: 409,
  IDEMPOTENCY_CONFLICT: 409,
  SOURCE_CHANGED_DURING_SNAPSHOT: 409,
  INPUT_TOO_LARGE: 413,
  CONFIG_INVALID: 422,
  CHECKS_NOT_EXECUTED: 422,
  QUOTA_EXCEEDED: 429,
  RUNTIME_UNAVAILABLE: 503,
  NOT_IMPLEMENTED: 501,
};

export class WorkbenchError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly httpStatus: number | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    options: { retryable?: boolean; httpStatus?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : {});
    this.name = "WorkbenchError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.httpStatus = options.httpStatus ?? ERROR_HTTP_STATUS[code];
  }
}

/**
 * Thrown by every surface that is specified but not yet implemented.
 * Never substitute fake data, fixed passes, or empty objects (AGENTS.md).
 */
export class NotImplementedError extends WorkbenchError {
  readonly surface: string;

  constructor(surface: string, detail?: string) {
    super(
      ERROR_CODES.NOT_IMPLEMENTED,
      detail === undefined ? `Not implemented: ${surface}` : `Not implemented: ${surface}: ${detail}`,
      { retryable: false },
    );
    this.name = "NotImplementedError";
    this.surface = surface;
  }
}
