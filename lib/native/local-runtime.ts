/**
 * Local-runtime diagnostics — captures the environment in which the app is
 * running so crash bundles surface the platform, build flavor, and any
 * available Tauri identity plus bounded health summaries for the runtime
 * subsystems that most often explain a failed Support session. Raw subsystem
 * error messages, server definitions, plugin paths, and log bodies are never
 * retained here.
 */

import { isTauri } from "@/lib/tauri"
import type { LocalRuntimeDiagnostics } from "@/lib/logging/crash-log"

export type { LocalRuntimeDiagnostics }

interface SyncHealthState {
  lastSyncAt: number | null
  since: number
  lastError: string | null
}

export interface LocalRuntimeHealthReaders {
  readSidecarStatus: () => Promise<{ ready: boolean }>
  readSyncStates: () => Promise<Record<string, SyncHealthState>>
  readPluginStatuses: () => Promise<string[]>
  readMcpTransports: () => Promise<string[]>
  readRecentErrorCount: () => Promise<number>
}

async function readTauriEnv(): Promise<Record<string, unknown>> {
  if (!isTauri()) return {}

  const env: Record<string, unknown> = {}
  try {
    const os = await import("@tauri-apps/plugin-os")
    // platform/version/arch/family are synchronous in plugin-os v2; only
    // locale and hostname remain async.
    try {
      env.platform = os.platform()
    } catch {
      /* unsupported */
    }
    try {
      env.osVersion = os.version()
    } catch {
      /* unsupported */
    }
    try {
      env.arch = os.arch()
    } catch {
      /* unsupported */
    }
    try {
      env.family = os.family()
    } catch {
      /* unsupported */
    }
    env.locale = await os.locale().catch(() => undefined)
    env.hostname = await os.hostname().catch(() => undefined)
  } catch {
    // OS plugin not registered — leave env minimal.
  }

  try {
    const { getName, getVersion, getTauriVersion } = await import("@tauri-apps/api/app")
    env.appName = await getName().catch(() => undefined)
    env.appVersion = await getVersion().catch(() => undefined)
    env.tauriVersion = await getTauriVersion().catch(() => undefined)
  } catch {
    // App module unavailable — skip.
  }

  return env
}

function readWebEnv(): Record<string, unknown> {
  if (typeof navigator === "undefined") {
    return { runtime: "server" }
  }
  return {
    runtime: "browser",
    userAgent: navigator.userAgent,
    language: navigator.language,
    platform: typeof navigator.platform === "string" ? navigator.platform : undefined,
    online: typeof navigator.onLine === "boolean" ? navigator.onLine : undefined,
  }
}

const defaultHealthReaders: LocalRuntimeHealthReaders = {
  readSidecarStatus: async () => {
    const { getSidecarStatus } = await import("@/lib/claude/ipc")
    return getSidecarStatus()
  },
  readSyncStates: async () => {
    const { snapshotSyncStates } = await import("@/lib/sync/companion-sync")
    return snapshotSyncStates()
  },
  readPluginStatuses: async () => {
    const { usePluginStore } = await import("@/stores/plugin-runtime/plugin-store")
    return Object.values(usePluginStore.getState().plugins).map((plugin) => plugin.status)
  },
  readMcpTransports: async () => {
    const { listEnabledMcpServers } = await import("@/lib/db/mcp-servers")
    return (await listEnabledMcpServers()).map((server) => server.transport)
  },
  readRecentErrorCount: async () => {
    const { getRecentErrorLogs } = await import("@cognia/logging/recent-errors")
    return getRecentErrorLogs().length
  },
}

async function safeHealth<T>(
  name: string,
  read: () => Promise<T>,
  summarize: (value: T) => Record<string, unknown>
): Promise<Record<string, unknown>> {
  try {
    return summarize(await read())
  } catch {
    return { status: "unavailable", code: `${name}_unavailable` }
  }
}

function summarizeSync(states: Record<string, SyncHealthState>): Record<string, unknown> {
  const values = Object.values(states)
  const failedTables = values.filter((state) => Boolean(state.lastError)).length
  const latest = values.reduce<number | null>(
    (current, state) => Math.max(current ?? 0, state.lastSyncAt ?? 0) || null,
    null
  )
  return {
    status: failedTables > 0 ? "error" : "ok",
    trackedTables: values.length,
    failedTables,
    lastSuccessAt: latest ? new Date(latest).toISOString() : null,
  }
}

function summarizePlugins(statuses: string[]): Record<string, unknown> {
  const failed = statuses.filter((status) => status === "error").length
  return {
    status: failed > 0 ? "error" : "ok",
    total: statuses.length,
    enabled: statuses.filter((status) => status === "enabled").length,
    failed,
  }
}

function summarizeMcp(transports: string[]): Record<string, unknown> {
  const counts: Record<string, number> = {}
  for (const transport of transports) counts[transport] = (counts[transport] ?? 0) + 1
  return { status: "ok", enabled: transports.length, transports: counts }
}

async function readRuntimeHealth(
  overrides: Partial<LocalRuntimeHealthReaders>
): Promise<Record<string, Record<string, unknown>>> {
  const readers = { ...defaultHealthReaders, ...overrides }
  const sidecar = isTauri()
    ? await safeHealth("sidecar", readers.readSidecarStatus, ({ ready }) => ({
        status: ready ? "ok" : "not-ready",
        ready,
      }))
    : { status: "not-applicable" }
  const [sync, plugins, mcp, recentErrors] = await Promise.all([
    safeHealth("sync", readers.readSyncStates, summarizeSync),
    safeHealth("plugins", readers.readPluginStatuses, summarizePlugins),
    safeHealth("mcp", readers.readMcpTransports, summarizeMcp),
    safeHealth("recent_errors", readers.readRecentErrorCount, (count) => ({
      status: count > 0 ? "error" : "ok",
      count,
    })),
  ])
  return { sidecar, sync, plugins, mcp, recentErrors }
}

export async function getLocalRuntimeDiagnostics(
  healthReaderOverrides: Partial<LocalRuntimeHealthReaders> = {}
): Promise<LocalRuntimeDiagnostics | null> {
  try {
    const tauriEnv = await readTauriEnv()
    const webEnv = readWebEnv()
    const health = await readRuntimeHealth(healthReaderOverrides)
    const unhealthy = Object.values(health).some(({ status }) =>
      ["error", "not-ready", "unavailable"].includes(String(status))
    )
    return {
      status: unhealthy ? "error" : "ok",
      capturedAt: new Date().toISOString(),
      isTauri: isTauri(),
      health,
      ...webEnv,
      ...tauriEnv,
    }
  } catch (err) {
    return {
      status: "error",
      lastError: err instanceof Error ? err.message : String(err),
      capturedAt: new Date().toISOString(),
      isTauri: isTauri(),
    }
  }
}
