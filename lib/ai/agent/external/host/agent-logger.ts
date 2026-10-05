/**
 * The app's `AgentLogger` (ADR-0217): integration packages log through this,
 * never through `@cognia/logging` directly.
 *
 * The contract says the host bounds each entry. Integrations hand over raw
 * values (a subprocess stderr burst, a whole notification payload); this
 * adapter caps every top-level string with `truncateForLog` before it reaches
 * the logging core, so no integration can forget to and wedge the dev logger.
 */

import type { AgentLogger } from "@cognia/agent-contracts/host"
import type { Logger } from "@cognia/logging"
import { truncateForLog } from "@cognia/logging/truncate"

function bounded(data?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!data) return data
  let changed = false
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === "string") {
      const capped = truncateForLog(value)
      if (capped !== value) changed = true
      out[key] = capped
    } else {
      out[key] = value
    }
  }
  return changed ? out : data
}

export function createAgentLogger(target: Logger): AgentLogger {
  return {
    debug: (message, data) => target.debug(message, bounded(data)),
    info: (message, data) => target.info(message, bounded(data)),
    warn: (message, data) => target.warn(message, bounded(data)),
    error: (message, data) => target.error(message, bounded(data)),
  }
}
