/**
 * Runtime Context Helpers
 */

import type { LogOrigin, LogRuntime } from "./log-level"

export interface LogRuntimeContextOptions extends Record<string, unknown> {
  runtime: LogRuntime
  origin: LogOrigin
  tags?: string[]
}
