"use client"

import { useCallback, useEffect, useState } from "react"

import { agentInvoke, supportsExternalAgents } from "@/lib/ai/agent/external/agent-transport"
import {
  buildDshChannelManifest,
  doctorDshRuntime,
  type DshDoctorReport,
} from "@/lib/ai/agent/external/dsh-runtime-install"
import type { DshProfileId } from "@/types/agent/dsh-runtime-channel"

/**
 * Lifecycle for the Cognia-managed DeepSeek Harness runtime.
 *
 * One flow on every host. Desktop (Rust) and CLI/headless (Node) expose the
 * same four commands, and both return *facts* rather than a verdict — the
 * verdict is rendered here by the shared {@link doctorDshRuntime}, so the two
 * hosts cannot disagree about what "healthy" means.
 *
 * Install is two-phase for the same reason: the host stages and reports
 * digests, this hook builds the channel manifest (the profile and capability
 * vocabulary lives in TypeScript), and the host writes it and swaps the tree in.
 * Until finalize succeeds the previously certified runtime is still live.
 */

/** Facts a host gathers from disk. Mirrored by `DshRuntimeFacts` in Rust. */
interface DshHostFacts {
  manifestJson: string | null
  lockfileDigest: string
  compositionDigest: string
  nodeVersion: string
  platform: string
  strayPatchPaths: string[]
  hasNativeToolchain: boolean
}

interface DshInstallDigests {
  lockfileDigest: string
  compositionDigest: string
}

export interface UseDshRuntimeResult {
  /** False in hosts with no subprocess (web, Capacitor). */
  supported: boolean
  /** Undefined until the first check completes. */
  report?: DshDoctorReport
  busy: boolean
  error?: string
  installed: boolean
  refresh: () => Promise<void>
  install: () => Promise<void>
  remove: () => Promise<void>
}

/**
 * A runtime is "installed" when doctor had a manifest to judge.
 *
 * `channel-malformed` is what doctor returns when nothing is installed at all,
 * so its absence means a runtime exists even if otherwise unhealthy — which is
 * what decides whether the UI offers Install or Reinstall.
 */
function isInstalled(report: DshDoctorReport | undefined): boolean {
  if (!report) return false
  return !report.findings.some((finding) => finding.code === "channel-malformed")
}

/** Turn host facts into a verdict using the shared policy. */
function verdictFrom(facts: DshHostFacts, profileId: DshProfileId): DshDoctorReport {
  let manifest: unknown = null
  if (facts.manifestJson) {
    try {
      manifest = JSON.parse(facts.manifestJson)
    } catch {
      // Leave it null; the schema check reports `channel-malformed`.
      manifest = null
    }
  }
  return doctorDshRuntime(manifest, facts, profileId)
}

export function useDshRuntime(profileId: DshProfileId): UseDshRuntimeResult {
  const supported = supportsExternalAgents()
  const [report, setReport] = useState<DshDoctorReport | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  const run = useCallback(async (action: () => Promise<void>) => {
    setBusy(true)
    setError(undefined)
    try {
      await action()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [])

  const check = useCallback(async () => {
    const facts = await agentInvoke<DshHostFacts>("dsh_runtime_facts", {})
    setReport(verdictFrom(facts, profileId))
  }, [profileId])

  const refresh = useCallback(async () => {
    if (!supported) return
    await run(check)
  }, [supported, run, check])

  const install = useCallback(async () => {
    if (!supported) return
    await run(async () => {
      const digests = await agentInvoke<DshInstallDigests>("dsh_runtime_install", {})
      const manifest = buildDshChannelManifest(digests)
      await agentInvoke("dsh_runtime_finalize", { manifestJson: JSON.stringify(manifest, null, 2) })
      // Re-read rather than assuming success implies health: the install may
      // have succeeded while the platform or Node version still fails preflight.
      await check()
    })
  }, [supported, run, check])

  const remove = useCallback(async () => {
    if (!supported) return
    await run(async () => {
      await agentInvoke("dsh_runtime_remove", { activeSessionCount: 0 })
      await check()
    })
  }, [supported, run, check])

  useEffect(() => {
    if (!supported) return
    // Deferred into an async IIFE with a mounted guard rather than calling
    // `refresh()` directly: `react-hooks/set-state-in-effect` is enabled for
    // `hooks/**`, and the guard also stops a slow check from writing state
    // after the settings pane has closed.
    let active = true
    void (async () => {
      let next: DshDoctorReport | undefined
      let failure: string | undefined
      try {
        const facts = await agentInvoke<DshHostFacts>("dsh_runtime_facts", {})
        next = verdictFrom(facts, profileId)
      } catch (cause) {
        failure = cause instanceof Error ? cause.message : String(cause)
      }
      if (!active) return
      if (failure) setError(failure)
      else setReport(next)
    })()
    return () => {
      active = false
    }
  }, [supported, profileId])

  return {
    supported,
    report,
    busy,
    error,
    installed: isInstalled(report),
    refresh,
    install,
    remove,
  }
}
