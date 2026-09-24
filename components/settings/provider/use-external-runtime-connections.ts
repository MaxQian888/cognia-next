"use client"

/**
 * Which agent runtimes can run turns WITHOUT a built-in provider key.
 *
 * AI Connections lists Cognia's built-in providers, and on a machine whose
 * work runs through an external agent (Pi, Codex, Claude Code, a
 * commandcode-backed Pi) every one of them reads "Unconfigured". That wall
 * implied the app had no working model while turns were running fine: those
 * agents sign in to their own providers, and their credentials live in the
 * External Agents settings, not here.
 *
 * Nothing is detected afresh. The rows come from `useAgentRuntimeCatalog`, the
 * same catalog the composer's runtime picker reads (configuration gate, host
 * pairing, block reasons, last-contact warnings), and the live state from the
 * external-agent store's connection status. Per-agent credential readiness is
 * the `AgentCredentialBadge` probe the composer's "No API key" fix already
 * defers to for external runtimes; the card renders it per row.
 */

import { useAgentRuntimeCatalog } from "@/hooks/agent/use-agent-runtime-catalog"
import { useExternalAgentStore } from "@/stores/agent/external-agent-store"
import type {
  AgentRuntimeDescriptor,
  AgentRuntimePlacement,
} from "@/lib/ai/agent/runtime-catalog/types"
import type { ExternalAgentConnectionStatus } from "@/types/agent/external-agent"

/**
 * One row's state. The ids match `externalAgent.readiness.states.*`, which is
 * where the labels already live.
 *
 *  - `ready`: a host-owned configuration the paired host reports ready. The
 *    catalog lists only ready, enabled host rows, and there is no local
 *    connection to report.
 *  - `checking`: a block that may clear itself (a host still handshaking, a
 *    plugin adapter still registering).
 */
export type ExternalRuntimeState =
  "connected" | "connecting" | "error" | "off" | "blocked" | "checking" | "ready"

export interface ExternalRuntimeConnection {
  key: string
  name: string
  protocolLabel?: string
  placement: AgentRuntimePlacement
  /**
   * The local agent id behind the row, when there is one: the credential probe
   * and the connection status are keyed by it. `null` for a host-only row.
   */
  localAgentId: string | null
  state: ExternalRuntimeState
  /** Block reason or last-contact warning, in the runtime's own wording. */
  detail: string | null
}

export interface ExternalRuntimeConnections {
  /** The External Agents master switch. */
  externalEnabled: boolean
  /** Locally configured agents, whether or not the switch is on. */
  configuredCount: number
  rows: ExternalRuntimeConnection[]
  /** Rows that can take a turn right now (connected locally, or ready on the host). */
  workingCount: number
}

function localAgentIdOf(row: AgentRuntimeDescriptor): string | null {
  if (row.ref.kind === "external") return row.ref.agentId
  if (row.alternateRef?.kind === "external") return row.alternateRef.agentId
  return null
}

function stateOf(
  row: AgentRuntimeDescriptor,
  localAgentId: string | null,
  connectionStatus: Record<string, ExternalAgentConnectionStatus | undefined>
): ExternalRuntimeState {
  if (row.blockedReason) return row.blockTransient ? "checking" : "blocked"
  // A row that runs on the host lane is admitted by the host, which only lists
  // it once it is ready. Its local copy's connection is not what runs it.
  if (row.ref.kind === "host") return "ready"
  const status = localAgentId ? connectionStatus[localAgentId] : undefined
  switch (status) {
    case "connected":
      return "connected"
    case "connecting":
    case "reconnecting":
      return "connecting"
    case "error":
      return "error"
    default:
      return "off"
  }
}

/** Pure: project catalog rows and live connection status into card rows. */
export function deriveExternalRuntimeConnections(input: {
  runtimes: readonly AgentRuntimeDescriptor[]
  connectionStatus: Record<string, ExternalAgentConnectionStatus | undefined>
  externalEnabled: boolean
  configuredCount: number
}): ExternalRuntimeConnections {
  const rows = input.runtimes
    .filter((row) => row.group !== "builtin")
    .map((row): ExternalRuntimeConnection => {
      const localAgentId = localAgentIdOf(row)
      return {
        key: row.key,
        name: row.name ?? row.key,
        ...(row.protocolLabel ? { protocolLabel: row.protocolLabel } : {}),
        placement: row.placement ?? (row.group === "host" ? "host" : "local"),
        localAgentId,
        state: stateOf(row, localAgentId, input.connectionStatus),
        detail: row.blockedReason ?? row.warning ?? null,
      }
    })
  return {
    externalEnabled: input.externalEnabled,
    configuredCount: input.configuredCount,
    rows,
    workingCount: rows.filter((row) => row.state === "connected" || row.state === "ready").length,
  }
}

export function useExternalRuntimeConnections(): ExternalRuntimeConnections {
  const { runtimes, externalEnabled, configuredExternalCount } = useAgentRuntimeCatalog()
  const connectionStatus = useExternalAgentStore((s) => s.connectionStatus)
  // `runtimes` is rebuilt on every render by design (see the catalog hook), so
  // memoizing on it would never hit, and the derivation is a handful of rows.
  return deriveExternalRuntimeConnections({
    runtimes,
    connectionStatus,
    externalEnabled,
    configuredCount: configuredExternalCount,
  })
}
