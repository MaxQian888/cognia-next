// Re-export shim. Cognia's components import from
// `@/lib/ai/infrastructure/api-test`; we ported the module to
// `@/lib/ai/providers/api-test`. Keeping this shim avoids touching every
// component's import.
export * from "@cognia/provider-core/providers/api-test"
