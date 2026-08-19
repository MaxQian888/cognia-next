"use client"

import { useCallback, useEffect, useMemo, useState } from "react"

import { EXTERNAL_AGENT_PRESETS } from "@/lib/ai/agent/external/presets"
import { resolveCapabilities, shellHasImageSource } from "@/lib/onboarding/capabilities"
import { probeVendors } from "@/lib/agent-migration/probe"
import {
  EMPTY_SCAN,
  SCAN_HARD_TIMEOUT_MS,
  SCAN_SOFT_TIMEOUT_MS,
  resolveScanPhase,
  shellRunsMachineScan,
  type ScanPhase,
  type ScanResult,
  type ScannedRuntime,
} from "@/lib/onboarding/scan"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { loggers } from "@cognia/logging"
import type { MigrationVendor } from "@/lib/agent-migration/types"
import type { OnboardingShell } from "@cognia/agent-config-types"

const log = loggers.ui.child("onboarding-scan")

/** Poll cadence for the elapsed-time clock that drives the phase machine. */
const TICK_MS = 500

/**
 * Which external-agent preset each migration vendor corresponds to. The probe
 * answers "is this vendor's config on disk"; the preset is what the flow would
 * actually run the first output through.
 */
const VENDOR_RUNTIME: Record<MigrationVendor, string> = {
  "claude-code": "claude-code",
  codex: "codex",
  opencode: "opencode-server",
  // Added with the vendor itself. Its absence was not merely cosmetic: an
  // installed Pi resolved to `VENDOR_RUNTIME[p.vendor] === undefined`, so the
  // runtime row rendered with an undefined id and `hasModelAccess` could not
  // see it — an already-authenticated Pi still got asked for credentials.
  pi: "pi",
}

export interface MachineScan {
  phase: ScanPhase
  result: ScanResult
  /** Re-probe. The empty state offers this rather than only a Skip. */
  rescan: () => void
}

/**
 * Probe this machine for agent runtimes, importable setups, and the local
 * capabilities the starter cards gate on (ADR-0122).
 *
 * Reuses `probeVendors()` from the ADR-0107 migration subsystem verbatim
 * rather than adding a second detector — the question "is claude-code set up
 * here" already had one honest answer in this codebase, and two would drift.
 *
 * A vendor whose config file exists is reported as `authenticated`: those CLIs
 * write their config as part of signing in, so its presence is the available
 * evidence that the machine can already reach a model. It is evidence, not
 * proof — a revoked token leaves the file behind — which is why the provider
 * step it suppresses stays reachable from the residual finish-setup bar.
 */
export function useMachineScan(shell: OnboardingShell): MachineScan {
  const runs = shellRunsMachineScan(shell)
  const ocrSettings = useSettingsStore((s) => s.settings?.ocrSettings)

  // Only the probe half lives in state. Capabilities are derived
  // synchronously below, so the first-run step never briefly renders with no
  // cards while a filesystem probe it does not depend on is still running.
  const [probed, setProbed] = useState<Omit<ScanResult, "capabilities">>({
    runtimes: [],
    migratable: [],
  })
  const [pending, setPending] = useState(runs)
  const [startedAt, setStartedAt] = useState(() => Date.now())
  const [now, setNow] = useState(() => Date.now())
  const [nonce, setNonce] = useState(0)

  // An `"auto"` default routes to whatever is reachable, which on a desktop
  // always includes a local engine. A pinned cloud provider is only usable
  // once its credentials are in, and `providerEnabled` is where that lands.
  const ocrReady = useMemo(() => {
    const id = ocrSettings?.defaultProviderId ?? "auto"
    if (id === "auto") return true
    return ocrSettings?.providerEnabled?.[id] === true
  }, [ocrSettings])

  const capabilities = useMemo(
    () => resolveCapabilities({ shell, ocrReady, hasImageSource: shellHasImageSource(shell) }),
    [shell, ocrReady]
  )

  useEffect(() => {
    if (!runs) {
      // Nothing to probe off the desktop; settle immediately so the step body
      // (pairing, on a paired phone) renders without a spinner.
      return
    }
    let cancelled = false

    void (async () => {
      try {
        const probes = await probeVendors()
        if (cancelled) return
        const runtimes: ScannedRuntime[] = probes
          .filter((p) => p.installed)
          .map((p) => ({
            id: VENDOR_RUNTIME[p.vendor],
            label:
              EXTERNAL_AGENT_PRESETS[
                VENDOR_RUNTIME[p.vendor] as keyof typeof EXTERNAL_AGENT_PRESETS
              ]?.name ?? p.vendor,
            // A config file on disk is how these CLIs record a completed login.
            authenticated: Boolean(p.configPath),
          }))
        log.info("machine scan complete", {
          runtimes: runtimes.length,
          migratable: probes.filter((p) => p.installed).length,
        })
        setProbed({ runtimes, migratable: probes.filter((p) => p.installed) })
      } catch (err) {
        // A failed probe is "found nothing", not a dead end: the flow still has
        // the provider step and the requirement-free starter card.
        log.error("machine scan failed", err)
        if (!cancelled) setProbed({ runtimes: [], migratable: [] })
      } finally {
        if (!cancelled) setPending(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [runs, nonce])

  // Drives the soft/hard timeout policy. Stops once the phase can no longer
  // change, so a settled step does not hold a timer open.
  const elapsedMs = now - startedAt
  const settled = !pending || elapsedMs >= SCAN_HARD_TIMEOUT_MS
  useEffect(() => {
    if (!runs || settled) return
    const id = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(id)
  }, [runs, settled])

  const rescan = useCallback(() => {
    setProbed({ runtimes: [], migratable: [] })
    setPending(true)
    setStartedAt(Date.now())
    setNow(Date.now())
    setNonce((n) => n + 1)
  }, [])

  const result: ScanResult = { ...probed, capabilities }
  const found = probed.runtimes.length > 0 || probed.migratable.length > 0
  const phase: ScanPhase = runs
    ? resolveScanPhase({ found, pending, elapsedMs })
    : found
      ? "found"
      : "empty"

  // Off-desktop there is nothing probed, but the derived capabilities still
  // apply — that is what keeps the universal starter card available there.
  return { phase, result: runs ? result : { ...EMPTY_SCAN, capabilities }, rescan }
}

export { SCAN_HARD_TIMEOUT_MS, SCAN_SOFT_TIMEOUT_MS }
