/**
 * The plugin contract's share of `lib/ai/agent/external/config/installed-runtimes.ts`, which re-exports these.
 */
/** How the host found (or failed to find) a runtime's command. */
export type RuntimeResolution = "installed" | "missing" | "package-runner" | "not-local"
