/**
 * Compression settings types — re-export shim (ADR-0068 E5). The definitions
 * moved to `@cognia/agent-config-types/compression` (they are part of the
 * AppSettings type hub's dependency closure); existing
 * `@/types/system/compression` importers keep working unchanged.
 */

export * from "@cognia/agent-config-types/compression"
