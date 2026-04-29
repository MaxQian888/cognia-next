// Compat re-export so upstream imports of `@/stores/settings/settings-store`
// resolve to cognia-next's actual settings store at `@/stores/settings-store`.
//
// Code in this repo should import from `@/stores/settings-store` directly;
// keep this shim only for files copied verbatim from upstream.

export * from "@/stores/settings-store"
