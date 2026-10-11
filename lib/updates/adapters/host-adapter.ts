"use client"

/**
 * Always-on host updates (ADR-0224 A10).
 *
 * A host is not installed by this app: it checks the signed catalog itself,
 * waits until it is idle, swaps its server and brain and proves the new
 * version or rolls back. So this adapter only asks each paired always-on host
 * what it has found, one row per host, and its action asks the host to update
 * now. The row then rests in `awaiting-host` until the host reports back on
 * a later check.
 */

import type { UpdateCandidate, UpdateChannel, UpdateCriticality } from "@cognia/agent-config-types"

import { HostUpdateUnsupportedError, type HostUpdateStatus } from "@/lib/remote-host/host-update"

import type {
  UpdateAdapter,
  UpdateApplyContext,
  UpdateApplyResult,
  UpdateCheckContext,
} from "../adapter"

export interface PairedHostRef {
  id: string
  label: string
}

export interface HostAdapterDeps {
  /** Paired always-on hosts. */
  listHosts: () => PairedHostRef[]
  readStatus: (hostId: string) => Promise<HostUpdateStatus>
  install: (hostId: string) => Promise<HostUpdateStatus>
}

const CRITICALITIES: readonly UpdateCriticality[] = ["routine", "recommended", "critical"]

function criticalityOf(raw: string): UpdateCriticality {
  return (CRITICALITIES as readonly string[]).includes(raw) ? (raw as UpdateCriticality) : "routine"
}

function channelOf(raw: string, fallback: UpdateChannel): UpdateChannel {
  return raw === "stable" || raw === "beta" ? raw : fallback
}

/** The host's own finding as an Update Center candidate, if it can act on it. */
export function hostCandidate(
  host: PairedHostRef,
  status: HostUpdateStatus,
  fallbackChannel: UpdateChannel
): UpdateCandidate | null {
  // A host that cannot install updates itself says why in its own panel.
  if (!status.available || status.install === "unmanaged") return null
  return {
    assetId: host.id,
    kind: "host-server",
    executor: "cognia-host",
    displayName: host.label,
    currentVersion: status.currentVersion,
    targetVersion: status.available.version,
    channel: channelOf(status.channel, fallbackChannel),
    criticality: criticalityOf(status.available.criticality),
    releaseNotes: status.available.releaseNotes,
    releasedAt: status.available.releasedAt,
    source: "catalog",
    // The host verified the signed catalog before it reported this.
    provenance: "verified",
  }
}

export function createHostAdapter(deps: HostAdapterDeps): UpdateAdapter {
  return {
    kind: "host-server",
    executor: "cognia-host",
    isSupported: () => deps.listHosts().length > 0,

    async check(context: UpdateCheckContext): Promise<UpdateCandidate[]> {
      const hosts = deps.listHosts()
      const answers = await Promise.allSettled(
        hosts.map(async (host) => ({ host, status: await deps.readStatus(host.id) }))
      )
      // An offline host, or one from before self-update, has nothing to
      // offer here; its panel says which.
      return answers.flatMap((answer) => {
        if (answer.status !== "fulfilled") return []
        const candidate = hostCandidate(answer.value.host, answer.value.status, context.channel)
        return candidate ? [candidate] : []
      })
    },

    async apply(
      candidate: UpdateCandidate,
      _context: UpdateApplyContext
    ): Promise<UpdateApplyResult> {
      try {
        await deps.install(candidate.assetId)
        return { state: "awaiting-host" }
      } catch (error) {
        if (error instanceof HostUpdateUnsupportedError) {
          return {
            state: "failed",
            failure: { kind: "unsupported", code: "host_update_unsupported" },
          }
        }
        return {
          state: "failed",
          failure: { kind: "unknown", code: "host_update_refused", recoveryActionKey: "retry" },
        }
      }
    },
  }
}
