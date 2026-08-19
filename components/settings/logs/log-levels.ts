import type { LogLevel } from "@/lib/logging"

/**
 * Severity order, low → high. Shared by every panel that renders a level
 * `<Select>` so the options never drift between the global threshold, the
 * per-module overrides and the per-transport minimums.
 */
export const LOG_LEVELS: readonly LogLevel[] = ["trace", "debug", "info", "warn", "error", "fatal"]
