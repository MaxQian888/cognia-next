/**
 * LSP configuration types — re-export shim (ADR-0068 E5). The definitions
 * moved to `@cognia/agent-config-types/lsp-config` (they are part of the
 * AppSettings type hub's dependency closure); existing `@/types/lsp/config`
 * importers keep working unchanged through this shim.
 */

export * from "@cognia/agent-config-types/lsp-config"
