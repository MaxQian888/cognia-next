/**
 * Logging types — compat barrel (ADR-0068 E4). The pure type modules moved
 * to `@cognia/logging/types`; the crash-log and transport-health types stay
 * app-side because they reach into the native-logging readiness bridge.
 * Existing `@/types/logging` importers keep working unchanged through this
 * barrel.
 */

export * from "@cognia/logging/types"
export * from "./crash-log"
export * from "./transport-health"
