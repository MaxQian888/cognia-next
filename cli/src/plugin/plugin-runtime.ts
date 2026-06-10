/**
 * Headless plugin runtime for the CLI.
 *
 * The desktop loads its in-tree first-party plugins (web-tools, workspace-tools,
 * screenshot, …) through `PluginManager` + the Zustand `usePluginStore`, and
 * `resolveSendOptions` builds the agent's plugin-tool manifest from that store.
 * The standalone CLI has no browser, so those subsystems crash on import (they
 * read `window`/`localStorage`/`sessionStorage` and dispatch DOM events). This
 * module installs the minimal shims, configures the trust posture for
 * first-party plugins, and bootstraps the real `PluginManager` (browser profile)
 * so the SAME `buildPluginToolsManifest` the desktop uses sees the in-tree
 * plugins — no reimplementation.
 *
 * Trust posture (CLI-specific, legitimate): in-tree plugins are compiled into
 * the binary (not user-installed), so signature enforcement is disabled; and the
 * SDK permission gate is the CLI's real consent layer, so the renderer-only
 * plugin consent broker is bypassed via the guard's silent-grant posture. Both
 * mirror documented host options (`signatureRequired:false`,
 * `confirmDangerousByDefault:false`).
 *
 * Everything is wrapped so a bootstrap failure degrades gracefully — the chat
 * keeps working, the agent just sees no plugin tools.
 */
import { installFakeIndexedDb } from "../db/bootstrap"

/** A Map-backed `Storage` for the localStorage / sessionStorage shims. */
function makeStorage(): Storage {
  const map = new Map<string, string>()
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size
    },
  } as Storage
}

const PLUGIN_POLICY_KEY = "cognia.plugins.policy"

/**
 * Install the browser globals the plugin subsystem reads, and seed the plugin
 * policy so first-party plugins load without a signature. Idempotent and
 * non-clobbering (a real jsdom/browser env is left untouched). Exposed for tests.
 */
export function installPluginRuntimeShims(
  g: Record<string, unknown> = globalThis as unknown as Record<string, unknown>
): void {
  if (!g.localStorage) g.localStorage = makeStorage()
  if (!g.sessionStorage) g.sessionStorage = makeStorage()
  if (typeof g.CustomEvent !== "function") {
    g.CustomEvent = class {
      type: string
      detail: unknown
      constructor(type: string, init?: { detail?: unknown }) {
        this.type = type
        this.detail = init?.detail
      }
    }
  }
  // Plugin store + manager dispatch DOM events / use EventTarget methods. The
  // CLI has no consumers, so no-ops are correct (consent is handled by the SDK
  // gate, not these events).
  if (typeof g.dispatchEvent !== "function") g.dispatchEvent = () => true
  if (typeof g.addEventListener !== "function") g.addEventListener = () => {}
  if (typeof g.removeEventListener !== "function") g.removeEventListener = () => {}
  // Seed the plugin policy: in-tree plugins are trusted-by-construction.
  const ls = g.localStorage as Storage
  if (!ls.getItem(PLUGIN_POLICY_KEY)) {
    ls.setItem(PLUGIN_POLICY_KEY, JSON.stringify({ signatureRequired: false, autoUpdate: false }))
  }
}

export interface PluginRuntimeResult {
  ok: boolean
  /** Number of plugin-tool manifest entries available after bootstrap. */
  toolCount: number
  /** Failure reason when `ok` is false. */
  error?: string
}

/** Injectable seams (tests). Defaults wire the real desktop modules. */
export interface PluginRuntimeDeps {
  installShims?: (g?: Record<string, unknown>) => void
  installIndexedDb?: () => Promise<void>
  configureGuard?: () => void
  initManager?: () => Promise<void>
  manifestCount?: () => number
}

let cached: Promise<PluginRuntimeResult> | null = null

async function bootstrap(deps: PluginRuntimeDeps): Promise<PluginRuntimeResult> {
  try {
    ;(deps.installShims ?? installPluginRuntimeShims)()
    await (deps.installIndexedDb ?? installFakeIndexedDb)()

    const configureGuard =
      deps.configureGuard ??
      (() => {
        // Silent-grant posture so plugin permissions don't fire the renderer
        // consent broker (the SDK gate is the CLI's consent layer). Must run
        // before the manager registers plugins.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { getPermissionGuard } = require("@/lib/plugin/security/permission-guard")
        getPermissionGuard({ confirmDangerousByDefault: false })
      })
    configureGuard()

    const initManager =
      deps.initManager ??
      (async () => {
        const { initializePluginManager } = await import("@/lib/plugin/core/manager")
        await initializePluginManager({
          pluginDirectory: "",
          runtimeProfile: "browser",
          enablePython: false,
        })
      })
    await initManager()

    const manifestCount =
      deps.manifestCount ??
      (() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { buildPluginToolsManifest } = require("@/lib/plugin/bridge/sidecar-tools-bridge")
        return buildPluginToolsManifest({}).length as number
      })
    return { ok: true, toolCount: manifestCount() }
  } catch (err) {
    return { ok: false, toolCount: 0, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Bootstrap the in-tree plugin runtime once (cached). Never throws — returns a
 * result describing success + tool count, or the failure reason. Safe to call on
 * every session; only the first call does the work.
 */
export function ensurePluginRuntime(deps: PluginRuntimeDeps = {}): Promise<PluginRuntimeResult> {
  if (!cached) cached = bootstrap(deps)
  return cached
}

/** Test-only: forget the cached bootstrap so the next call re-runs. */
export function __resetPluginRuntimeForTesting(): void {
  cached = null
}
