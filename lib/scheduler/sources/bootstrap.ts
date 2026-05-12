/**
 * Module-init bootstrap for the scheduler source registry.
 *
 * Called from the scheduler page on mount via `useEffect` so the registry
 * isn't populated during SSR / test-time module evaluation. Idempotent —
 * re-registers cleanly when an HMR update re-runs this module.
 */

import { getSchedulerSourceRegistry } from "./registry"
import { createAppSource } from "./app-source"
import { createWorkflowSource } from "./workflow-source"
import { createBackupSource } from "./backup-source"
import { createPluginSource } from "./plugin-source"
import { createSystemSource } from "./system-source"
import { createConnectorSource } from "./connector-source"

let bootstrapped = false

export function bootstrapSchedulerSources(): void {
  if (bootstrapped) return
  const registry = getSchedulerSourceRegistry()
  registry.register(createAppSource())
  registry.register(createWorkflowSource())
  registry.register(createBackupSource())
  registry.register(createPluginSource())
  registry.register(createSystemSource())
  registry.register(createConnectorSource())
  bootstrapped = true
}

/** Test-only: reset the bootstrap latch so the next call re-registers. */
export function resetSchedulerSourceBootstrap(): void {
  bootstrapped = false
}
