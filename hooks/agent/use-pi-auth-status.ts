"use client"

import { useCallback, useEffect, useSyncExternalStore } from "react"

import {
  reconcilePiAuthVerdict,
  type PiAuthVerdict,
  type PiListedModel,
} from "@/lib/ai/agent/external/pi-auth"

/**
 * What the Pi credential diagnostic found (ADR-0119).
 *
 * `providers` is deliberately separate from `listing`: an empty provider list
 * under `listing: "ok"` is the real diagnosis this card exists to deliver.
 * Pi is running but cannot reach a single model, which otherwise only surfaces
 * as a failed first prompt. The same empty array under `listing: "unreadable"`
 * means the listing itself failed and says nothing about credentials.
 */
export interface PiAuthStatus {
  listing: "ok" | "unreadable" | "idle"
  verdicts: PiAuthVerdict[]
  /**
   * Every model Pi can run right now, from the same `--list-models` pass
   * that produced the provider set. Read by the card and by the composer's
   * model picker before a session exists, when the RPC `get_available_models`
   * has no process to ask.
   */
  models: PiListedModel[]
}

const EMPTY_STATUS: PiAuthStatus = { listing: "idle", verdicts: [], models: [] }

interface AgentProbe {
  status: PiAuthStatus
  loading: boolean
  available: boolean
  /** True once this agent has an answer, definitive or not. */
  settled: boolean
}

const IDLE: AgentProbe = { status: EMPTY_STATUS, loading: false, available: false, settled: false }

/**
 * One probe per agent, shared by every mount that asks about it.
 *
 * The probe is expensive in a way component state cannot express: `pi
 * --list-models` plus one `pi auth check --provider <id>` per provider, each a
 * sandboxed process spawn. The answer is about the agent, not about the
 * component looking at it, so it lives beside the agent.
 *
 * Per-mount state was fine while the only reader was one settings card. It
 * stopped being fine the moment the same verdict was wanted next to every row
 * of the runtime picker and on every card in the manager: N rows times M
 * providers spawned on every open, and again on the next open, for a fact that
 * had not moved. Keeping it here means the second reader is free and reopening
 * a menu costs nothing.
 */
const probes = new Map<string, AgentProbe>()
const listeners = new Map<string, Set<() => void>>()
const inFlight = new Map<string, Promise<void>>()
const issued = new Map<string, number>()

function probeOf(agentId: string): AgentProbe {
  return probes.get(agentId) ?? IDLE
}

function publish(agentId: string, next: AgentProbe): void {
  probes.set(agentId, next)
  for (const listener of listeners.get(agentId) ?? []) listener()
}

function subscribeToAgent(agentId: string, listener: () => void): () => void {
  const set = listeners.get(agentId) ?? new Set<() => void>()
  set.add(listener)
  listeners.set(agentId, set)
  return () => {
    set.delete(listener)
    if (set.size === 0) listeners.delete(agentId)
  }
}

/**
 * Run `pi --list-models` and then one `pi auth check` per provider it reports.
 *
 * Never on mount-without-connection, never concurrently with itself, and never
 * twice for an agent that already has an answer: each call spawns short-lived
 * `pi` processes through the sandboxed launcher, so this must not become
 * something that polls. Read-only by construction, since the adapter pins
 * `--no-refresh`, so the probe cannot mutate Pi's credential store.
 */
async function runProbe(agentId: string, connected: boolean, force: boolean): Promise<void> {
  if (!connected) {
    // A disconnect invalidates the answer rather than staling it: the next
    // connect may be a different process with different credentials.
    if (probes.has(agentId)) publish(agentId, IDLE)
    issued.set(agentId, (issued.get(agentId) ?? 0) + 1)
    inFlight.delete(agentId)
    return
  }
  const pending = inFlight.get(agentId)
  if (pending && !force) return pending
  if (!force && probeOf(agentId).settled) return

  const ticket = (issued.get(agentId) ?? 0) + 1
  issued.set(agentId, ticket)
  const publishCurrent = (next: AgentProbe) => {
    if (issued.get(agentId) === ticket) publish(agentId, next)
  }

  const run = (async () => {
    const { getExternalAgentManager } = await import("@/lib/ai/agent/external/manager")
    const adapter = getExternalAgentManager().getPiRpcAdapter(agentId)
    if (!adapter) {
      // Every agent except Pi. Settled, so the next mount does not look again.
      publishCurrent({ ...IDLE, settled: true })
      return
    }
    publishCurrent({ ...probeOf(agentId), available: true, loading: true })
    try {
      const listing = await adapter.listAgentModels()
      if (listing.status !== "ok") {
        publishCurrent({
          status: { listing: "unreadable", verdicts: [], models: [] },
          loading: false,
          available: true,
          settled: true,
        })
        return
      }
      const providers = [...new Set(listing.models.map((model) => model.provider))].sort()
      // Sequential on purpose: each check is a process spawn under the sandbox
      // launcher, and a user with many providers should not fan out a dozen at
      // once just to render a list of badges.
      //
      // Reconciled against the listing: `auth check` cannot see a provider an
      // extension registers and answers `provider_not_found` for it, which
      // rendered the user's working provider as "Not signed in".
      const verdicts: PiAuthVerdict[] = []
      for (const provider of providers) {
        verdicts.push(reconcilePiAuthVerdict(await adapter.checkProviderAuth(provider), providers))
      }
      publishCurrent({
        status: { listing: "ok", verdicts, models: listing.models },
        loading: false,
        available: true,
        settled: true,
      })
    } catch {
      // A spawn that never started, because `pi` is gone from PATH or this
      // host has no sandbox launcher, is exactly "could not check", and it
      // must be caught here: the effect below calls this as `void`, so a
      // rejection would escape as an unhandled promise rejection instead of
      // reaching the user as a diagnosis.
      publishCurrent({
        status: { listing: "unreadable", verdicts: [], models: [] },
        loading: false,
        available: true,
        settled: true,
      })
    }
  })().finally(() => {
    if (inFlight.get(agentId) === run) inFlight.delete(agentId)
  })

  inFlight.set(agentId, run)
  return run
}

/** Test seam: forget every shared probe so a case starts from nothing. */
export function __resetPiAuthStatusForTests(): void {
  probes.clear()
  inFlight.clear()
  issued.clear()
  listeners.clear()
}

export function usePiAuthStatus(
  agentId: string,
  connected: boolean
): {
  status: PiAuthStatus
  loading: boolean
  available: boolean
  refresh: () => Promise<void>
} {
  const probe = useSyncExternalStore(
    useCallback((listener: () => void) => subscribeToAgent(agentId, listener), [agentId]),
    useCallback(() => probeOf(agentId), [agentId]),
    () => IDLE
  )

  useEffect(() => {
    void runProbe(agentId, connected, false)
  }, [agentId, connected])

  const refresh = useCallback(() => runProbe(agentId, connected, true), [agentId, connected])

  return { status: probe.status, loading: probe.loading, available: probe.available, refresh }
}
