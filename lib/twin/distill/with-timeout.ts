/**
 * Backward-compat re-export. The implementation moved to
 * `lib/utils/with-timeout.ts` in PR-B of the plugin system
 * optimization (see `plans/noble-hatching-mango.md`) so the plugin
 * loader can reuse it without crossing twin's bounded context.
 *
 * Twin's distill orchestrator keeps importing from this path — adding
 * a thin re-export here avoids churn in the orchestrator and its
 * tests.
 */

export {
  DEFAULT_AGENT_TIMEOUT_MS,
  TimeoutError,
  withTimeout,
  withTimeoutOrFallback,
} from "@cognia/primitives"
