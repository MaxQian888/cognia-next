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
import os from "node:os"

import { isHeadlessHost } from "@/lib/platform/detect"

import { installFakeIndexedDb } from "../db/bootstrap"
import { resolveHome } from "../config/load"
import { readDisabledPlugins } from "./plugin-state"

/** Minimal slice of the plugin-runtime store the disabled-set reconciler needs. */
interface PluginStatusStore {
  plugins: Record<string, { status: string }>
  setPluginStatus: (id: string, status: "enabled" | "disabled") => void
}

/** Plugin ids this process forced off, so a later toggle-back-on can restore
 * exactly those (and never force-enable a plugin disabled for other reasons,
 * e.g. a load failure). Reset by {@link __resetPluginRuntimeForTesting}. */
const forcedDisabled = new Set<string>()

/**
 * Reconcile the plugin store against the CLI's `/plugin disable` set. The store
 * is the source `buildPluginToolsManifest` reads (only `status === "enabled"`
 * plugins surface their tools), but it has no notion of the CLI's file-based
 * disabled overlay — so without this, `/plugin disable X` was inert. We only
 * flip the lightweight status flag (no teardown/re-activation): a plugin's tools
 * stay loaded, they just drop out of the manifest until re-enabled.
 */
export function applyDisabledPluginsToStore(
  disabledIds: Set<string>,
  store: PluginStatusStore
): void {
  // Restore anything we previously forced off that's no longer disabled.
  for (const id of [...forcedDisabled]) {
    if (!disabledIds.has(id)) {
      if (store.plugins[id]?.status === "disabled") store.setPluginStatus(id, "enabled")
      forcedDisabled.delete(id)
    }
  }
  // Force off every currently-enabled plugin named in the disabled set.
  for (const id of disabledIds) {
    if (store.plugins[id]?.status === "enabled") {
      store.setPluginStatus(id, "disabled")
      forcedDisabled.add(id)
    }
  }
}

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
 * Disk roots shared by standalone CLI and the supervised headless brain.
 * `COGNIA_DATA_DIR` is appended because cognia-server installs remote plugins
 * into `<data>/.cognia/plugins`, while a standalone CLI keeps the established
 * project/home discovery locations.
 */
export function pluginDiscoveryRoots(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
  home = resolveHome(env, os.homedir())
): string[] {
  return [...new Set([cwd, home, env.COGNIA_DATA_DIR].filter((root): root is string => !!root))]
}

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
  configureGuard?: () => void | Promise<void>
  initManager?: () => Promise<void>
  /** Reconcile the loaded plugins against the CLI `/plugin disable` overlay.
   * Defaults to reading `~/.cognia/plugin-state.json` and flipping the runtime
   * store. Injected in tests. */
  applyDisabled?: () => void | Promise<void>
  /** Register disk plugins (`~/.cognia/plugins/<id>`) into the manager and
   * load+enable the supported, non-disabled ones. Defaults to the real host
   * wiring. Injected in tests. */
  registerDisk?: () => void | Promise<void>
  /** Register the repo's in-tree `plugins/<id>` as live dev plugins (only when
   * {@link devPluginsDir} resolves). Defaults to the real host wiring + repo
   * discovery. Injected in tests. */
  registerDev?: () => void | Promise<void>
  /** Resolved repo `plugins/` directory to load as dev plugins. Absent ⇒ skip. */
  devPluginsDir?: string
  manifestCount?: () => number | Promise<number>
}

let cached: Promise<PluginRuntimeResult> | null = null

async function bootstrap(deps: PluginRuntimeDeps): Promise<PluginRuntimeResult> {
  try {
    ;(deps.installShims ?? installPluginRuntimeShims)()
    await (deps.installIndexedDb ?? installFakeIndexedDb)()

    const configureGuard =
      deps.configureGuard ??
      (async () => {
        // Silent-grant posture so plugin permissions don't fire the renderer
        // consent broker (the SDK gate is the CLI's consent layer). Must run
        // before the manager registers plugins. ESM dynamic import (not
        // `require`, which is undefined under tsx/ESM and resolves to a DISTINCT
        // module instance under the esbuild bundle — the latter split the plugin
        // store so the manifest read an empty copy and surfaced zero tools).
        const { getPermissionGuard } = await import("@/lib/plugin/security/permission-guard")
        getPermissionGuard({ confirmDangerousByDefault: false })
      })
    await configureGuard()

    const initManager =
      deps.initManager ??
      (async () => {
        const { initializePluginManager } = await import("@/lib/plugin/core/manager")
        const { makeNodeFrontendImporter } = await import("./node-importer")
        const headless = isHeadlessHost()
        const nodeHostInvoker = headless
          ? async <T>(command: string, args: Record<string, unknown>): Promise<T> => {
              const { transport } = await import("@/lib/tauri")
              return transport.call<T>(command, args)
            }
          : undefined
        await initializePluginManager({
          pluginDirectory: "",
          runtimeProfile: headless ? "headless" : "browser",
          // The supervised brain owns the host-neutral Python subprocess
          // registry through its service transport. A standalone CLI has no
          // companion service, so it keeps the established browser-only path.
          enablePython: headless,
          // Frontend plugins load via dynamic `import()` under Node — the
          // Tauri/fetch/eval strategies in the loader don't exist here.
          frontendImporter: makeNodeFrontendImporter(),
          nodeHostInvoker,
        })
      })
    await initManager()

    // Honor the CLI's `/plugin disable` overlay against the just-loaded plugins.
    // Best-effort: failing to read the file or reach the store must never break
    // chat — the agent just sees the un-filtered tool set.
    const applyDisabled =
      deps.applyDisabled ??
      (async () => {
        const home = resolveHome(process.env, os.homedir())
        const disabled = readDisabledPlugins(home)
        const { usePluginStore } = await import("@/stores/plugin-runtime")
        applyDisabledPluginsToStore(disabled, usePluginStore.getState() as PluginStatusStore)
      })
    try {
      await applyDisabled()
    } catch {
      // ignore — disabled-set reconciliation is non-critical
    }

    // Register disk plugins (`~/.cognia/plugins/<id>`) onto the same manager so
    // their tools reach the model and lifecycle (enable/disable/reload/uninstall)
    // is real. Best-effort: a failure leaves the builtins-only tool set intact.
    const registerDisk =
      deps.registerDisk ??
      (async () => {
        const home = resolveHome(process.env, os.homedir())
        const roots = pluginDiscoveryRoots(process.env, process.cwd(), home)
        const disabled = readDisabledPlugins(home)
        const { getPluginManager } = await import("@/lib/plugin/core/manager")
        const { usePluginStore } = await import("@/stores/plugin-runtime")
        const { makeHostManager } = await import("./host-manager")
        const { registerDiskPlugins, defaultDiscoverDiskPlugins } = await import("./host")
        const manager = makeHostManager({
          manager: getPluginManager() as never,
          getPlugins: () =>
            usePluginStore.getState().plugins as unknown as Record<
              string,
              { manifest: import("@/types/plugin").PluginManifest; path: string; status: string }
            >,
        })
        await registerDiskPlugins({
          manager,
          discover: () => defaultDiscoverDiskPlugins(roots),
          disabled,
          notify: () => {},
        })
      })
    try {
      await registerDisk()
    } catch {
      // ignore — disk-plugin registration is non-critical
    }

    // Register the repo's in-tree `plugins/<id>` as live dev plugins (dev mode).
    // Supplements the compiled-in builtins: ids already in the store are skipped
    // so re-registering them doesn't fail. Best-effort, like disk registration.
    const devPluginsDir = deps.devPluginsDir
    const registerDev =
      deps.registerDev ??
      (devPluginsDir
        ? async () => {
            const home = resolveHome(process.env, os.homedir())
            const disabled = readDisabledPlugins(home)
            const { getPluginManager } = await import("@/lib/plugin/core/manager")
            const { usePluginStore } = await import("@/stores/plugin-runtime")
            const { makeHostManager } = await import("./host-manager")
            const { registerDiskPlugins } = await import("./host")
            const { discoverDevPlugins } = await import("./dev-plugins")
            const getPlugins = () =>
              usePluginStore.getState().plugins as unknown as Record<
                string,
                { manifest: import("@/types/plugin").PluginManifest; path: string; status: string }
              >
            const manager = makeHostManager({ manager: getPluginManager() as never, getPlugins })
            const skipIds = new Set(Object.keys(getPlugins()))
            await registerDiskPlugins({
              manager,
              discover: () => discoverDevPlugins(devPluginsDir, skipIds),
              disabled,
              notify: () => {},
            })
          }
        : () => {})
    try {
      await registerDev()
    } catch {
      // ignore — dev-plugin registration is non-critical
    }

    const manifestCount =
      deps.manifestCount ??
      (async () => {
        const { buildPluginToolsManifest } =
          await import("@/lib/plugin/bridge/sidecar-tools-bridge")
        return buildPluginToolsManifest({}).length as number
      })
    return { ok: true, toolCount: await manifestCount() }
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
  forcedDisabled.clear()
}
