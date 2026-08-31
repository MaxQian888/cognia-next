/**
 * Which provider/driver pairs have a production lifecycle adapter.
 *
 * This replaces a hardcoded `row.provider === "docker" && row.driver ===
 * "computer-server"` test that lived inside the Docker call path. Keeping the
 * question in one table means adding a provider is a table entry rather than
 * an edit to an unrelated adapter, and it means the "is there an adapter"
 * answer that gates the UI is the same one the dispatch path uses.
 *
 * A pair that is absent here has no adapter. That is deliberately
 * indistinguishable from an unsupported capability: both refuse with a typed
 * error, and neither falls back to the user's own machine.
 */

import type { SandboxClient } from "@/lib/automation/sandbox-client"
import { sandboxClient } from "@/lib/automation/sandbox-client"
import type {
  SandboxConnectionDriver,
  SandboxConnectionProvider,
  SandboxConnectionRow,
  SandboxLifecycleOperation,
} from "@/types/sandbox"
import { buildDockerSandboxAdapter, type DockerAdapterOutcome } from "./docker-adapter"
import type { SandboxProviderAdapter } from "./lifecycle-contract"

/** Builds the adapter for one row and one operation. */
export type SandboxAdapterFactory = (
  row: SandboxConnectionRow,
  client: SandboxClient,
  outcome: DockerAdapterOutcome,
  operation: SandboxLifecycleOperation
) => SandboxProviderAdapter

type PairKey = `${SandboxConnectionProvider}:${SandboxConnectionDriver}`

function pairKey(provider: SandboxConnectionProvider, driver: SandboxConnectionDriver): PairKey {
  return `${provider}:${driver}`
}

/**
 * The adapters that exist. Provider documentation is not an implementation:
 * `cua-cloud` and `lume` stay absent until something in this repository can
 * actually drive them.
 */
const ADAPTERS: Partial<Record<PairKey, SandboxAdapterFactory>> = {
  "docker:computer-server": buildDockerSandboxAdapter,
}

/** The adapter factory for a row, or null when the pair has none. */
export function sandboxAdapterFactoryFor(row: SandboxConnectionRow): SandboxAdapterFactory | null {
  // A row whose `provider` and `config.provider` disagree has no usable
  // config, so it has no adapter either. Catching it here keeps the UI from
  // offering actions that would refuse the moment they were pressed.
  if (row.config.provider !== row.provider) return null
  return ADAPTERS[pairKey(row.provider, row.driver)] ?? null
}

/** Whether this row is backed by a production lifecycle adapter. */
export function hasSandboxAdapter(row: SandboxConnectionRow): boolean {
  return sandboxAdapterFactoryFor(row) !== null
}

/** The provider/driver pairs that have an adapter, for tests and diagnostics. */
export function adapterPairs(): PairKey[] {
  return Object.keys(ADAPTERS) as PairKey[]
}

export { sandboxClient }
