/**
 * Which host's schedule the scheduler UI manages (spec 2026-08-16, decisions
 * 2 / 13 / 14 and grill Q29).
 *
 * Placement is HOST-OWNED: every host keeps its own `CogniaSchedulerDB` and
 * nothing hands tasks between hosts. What a client can choose is which of
 * the two reachable schedules it looks at:
 *
 *   - `local`  — this device's own schedule (the local scheduler ticks it);
 *   - `paired` — the schedule of the host this client is paired with / driving
 *     (a desktop driving a remote Cognia via ADR-0082, or a phone / cloud
 *     companion browser whose transport already points at the paired
 *     desktop or cognia-server), managed through the `scheduled_task_*` RPCs.
 *
 * Defaults: a companion prefers `paired` (the paired host is always-on; the
 * local webview schedule only ticks while the app is open); a desktop prefers
 * `paired` while it drives a remote host (its local scheduler is suspended in
 * that state); everything else is `local`. The preference is remembered per
 * device and can be flipped from the scheduler host bar.
 *
 * Pure leaf over `lib/platform` + `lib/tauri/transport-routing`; the data
 * source (`scheduler-data-source.ts`) and the store read
 * {@link getEffectiveSchedulerHostTarget}.
 */

import { detectHostProfile } from "@/lib/platform/capabilities"
import { isRemoteHostActive } from "@/lib/tauri/transport-routing"
import type { CapabilityId } from "@/lib/platform/capabilities"
import type { Platform } from "@/lib/platform/detect"
import { describeLocalSchedulerHost, type SchedulerHostDescriptor } from "./host-support"

export type SchedulerHostTarget = "local" | "paired"

const STORAGE_KEY = "cognia.scheduler.hostTarget.v1"

let preferred: SchedulerHostTarget | null | undefined
const listeners = new Set<() => void>()

function readStoredPreference(): SchedulerHostTarget | null {
  try {
    if (typeof localStorage === "undefined") return null
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw === "local" || raw === "paired" ? raw : null
  } catch {
    return null
  }
}

function writeStoredPreference(target: SchedulerHostTarget | null): void {
  try {
    if (typeof localStorage === "undefined") return
    if (target) localStorage.setItem(STORAGE_KEY, target)
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Storage unavailable (private mode / quota) — preference stays in memory.
  }
}

/** True when a paired/remote host's schedule is reachable from this client. */
export function isPairedSchedulerHostAvailable(): boolean {
  if (isRemoteHostActive()) return true
  const profile = detectHostProfile()
  return profile === "cloud-companion" || profile === "mobile-companion"
}

/** The default target for this client shape (see module docs). */
export function defaultSchedulerHostTarget(): SchedulerHostTarget {
  return isPairedSchedulerHostAvailable() ? "paired" : "local"
}

/** The user's remembered preference, or `null` when they never chose. */
export function getPreferredSchedulerHostTarget(): SchedulerHostTarget | null {
  if (preferred === undefined) preferred = readStoredPreference()
  return preferred
}

/** Remember (or clear with `null`) the preferred target and notify subscribers. */
export function setPreferredSchedulerHostTarget(target: SchedulerHostTarget | null): void {
  preferred = target
  writeStoredPreference(target)
  for (const listener of listeners) listener()
}

/**
 * The target actually in effect: the preference when it is satisfiable,
 * else the default. A remembered `paired` silently degrades to `local` while
 * no paired host is reachable (and comes back when it is).
 */
export function getEffectiveSchedulerHostTarget(): SchedulerHostTarget {
  const wanted = getPreferredSchedulerHostTarget() ?? defaultSchedulerHostTarget()
  if (wanted === "paired" && !isPairedSchedulerHostAvailable()) return "local"
  return wanted
}

export function subscribeSchedulerHostTarget(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Test seam. */
export function __resetSchedulerHostTargetForTesting(): void {
  preferred = undefined
  listeners.clear()
  writeStoredPreference(null)
}

// ── Describing the target host for the type picker ─────────────────────────

const PAIRED_HOST_CACHE_TTL_MS = 60_000
let pairedHostCache: { at: number; value: SchedulerHostDescriptor } | null = null

interface HostCapabilitiesResponse {
  platform?: Platform
  capabilities?: CapabilityId[]
}

/**
 * Platform + capabilities of the host whose schedule `target` refers to.
 * `local` is the process baseline; `paired` asks the host through the
 * `host_capabilities` RPC (answered in TS on both the desktop and the brain,
 * so the answer is authoritative for that host). Falls back to a conservative
 * server-backed guess when the RPC fails so the picker never crashes.
 */
export async function describeSchedulerTargetHost(
  target: SchedulerHostTarget = getEffectiveSchedulerHostTarget(),
  deps: {
    call?: <T>(name: string, args?: Record<string, unknown>) => Promise<T>
    now?: () => number
  } = {}
): Promise<SchedulerHostDescriptor> {
  if (target === "local") return describeLocalSchedulerHost()
  const now = deps.now ?? Date.now
  if (pairedHostCache && now() - pairedHostCache.at < PAIRED_HOST_CACHE_TTL_MS) {
    return pairedHostCache.value
  }
  try {
    const call =
      deps.call ??
      (async <T>(name: string, args?: Record<string, unknown>) => {
        const { transport } = await import("@/lib/tauri")
        return transport.call<T>(name, args)
      })
    const response = await call<HostCapabilitiesResponse>("host_capabilities")
    const platform: Platform =
      response?.platform === "tauri" || response?.platform === "headless"
        ? response.platform
        : "headless"
    const value: SchedulerHostDescriptor = {
      platform,
      capabilities: Array.isArray(response?.capabilities) ? response.capabilities : [],
    }
    pairedHostCache = { at: now(), value }
    return value
  } catch {
    // Unknown paired host: assume the server-backed execution plane so the
    // picker leans towards "available"; the executor's own gate is authoritative.
    return {
      platform: "headless",
      capabilities: [
        "shell",
        "sidecar",
        "keyring",
        "always-on",
        "connector-runtime",
        "mcp-runtime",
        "headless",
      ],
    }
  }
}

/** Test seam. */
export function __resetSchedulerTargetHostCacheForTesting(): void {
  pairedHostCache = null
}
