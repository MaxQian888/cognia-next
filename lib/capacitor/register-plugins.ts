"use client"

import { detectNativePlatform } from "./_shared"
import { loggers } from "@/lib/logging"

const log = loggers.shell

/**
 * Why this exists
 * ---------------
 * Capacitor Android (and iOS) injects ONLY `native-bridge.js` — the transport
 * layer (`window.Capacitor.nativePromise` / `nativeCallback`) plus the
 * per-launch `window.Capacitor.PluginHeaders` manifest. It does **not** create
 * the `window.Capacitor.Plugins.*` proxies. Those are built by
 * `@capacitor/core`'s `registerPlugin(name)`, which in a normal app runs as a
 * side effect of `import { Camera } from "@capacitor/camera"`.
 *
 * This app deliberately never imports the `@capacitor/*` packages: they are
 * mobile-workspace dependencies, not root dependencies, so the shared `out/`
 * build (`next build` at the repo root, consumed by Tauri **and** Capacitor)
 * cannot resolve or bundle them. The consequence on a real device:
 * `window.Capacitor.Plugins` stays empty, so every `lib/capacitor/*` wrapper
 * falls through `makeDefaultLoader` to a `webpackIgnore`'d dynamic import that
 * fails at runtime → `{ kind: "unsupported" }`. Camera, openSettings,
 * splash-hide, haptics, status-bar, toast … all silently no-op.
 *
 * The fix is to call `registerPlugin(name)` ourselves, exactly once, at mobile
 * boot, for every plugin the native runtime advertises in `PluginHeaders`.
 * `registerPlugin` only needs the header (not the plugin's JS package) to wire
 * each method straight to the native transport, so this populates
 * `window.Capacitor.Plugins.*` without bundling any plugin package.
 *
 * `@capacitor/core` is added as a **root** dependency so the root build can
 * bundle it. The dynamic `import("@capacitor/core")` below is a mobile-only
 * lazy chunk — it is gated behind `detectNativePlatform() === "mobile"`, so the
 * web and Tauri shells never fetch or evaluate it.
 */

interface PluginHeader {
  name: string
  methods?: Array<{ name: string; rtype?: string }>
}

interface CapacitorGlobal {
  PluginHeaders?: PluginHeader[]
  Plugins?: Record<string, unknown>
}

type WinWithCapacitor = { Capacitor?: CapacitorGlobal }

export type RegisterPluginFn = (pluginName: string) => unknown

export type RegisterNativePluginsResult = {
  /**
   * - `registered`  — ran on mobile and registered ≥1 plugin proxy.
   * - `skipped`     — not the mobile shell (web / Tauri); nothing to do.
   * - `unavailable` — mobile, but the native bridge exposed no PluginHeaders
   *                   or `@capacitor/core` failed to load. Wrappers will keep
   *                   reporting `unsupported`; this is the signal to debug the
   *                   native bridge, not the JS.
   */
  kind: "registered" | "skipped" | "unavailable"
  /** Plugin names successfully registered onto `window.Capacitor.Plugins`. */
  registered: string[]
  /** Plugin names the native runtime advertised via `PluginHeaders`. */
  available: string[]
}

type CoreLoader = () => Promise<{ registerPlugin: RegisterPluginFn }>

const defaultCoreLoader: CoreLoader = () =>
  import("@capacitor/core") as Promise<{ registerPlugin: RegisterPluginFn }>

/**
 * Register every native Capacitor plugin advertised by `PluginHeaders` onto
 * `window.Capacitor.Plugins`. Idempotent (Capacitor's `registerPlugin` returns
 * the existing proxy on a repeat call). No-op off mobile.
 *
 * @param opts.registerFn  Inject Capacitor's `registerPlugin` directly (reuse);
 *                          defaults to loading it via `coreLoader`.
 * @param opts.coreLoader  Inject the `@capacitor/core` module loader (tests);
 *                          defaults to a lazy `import("@capacitor/core")`.
 * @param opts.win         Window-like object holding `Capacitor`; defaults to
 *                          `globalThis`.
 */
export async function registerNativePlugins(
  opts: {
    registerFn?: RegisterPluginFn
    coreLoader?: CoreLoader
    win?: WinWithCapacitor
  } = {}
): Promise<RegisterNativePluginsResult> {
  if (detectNativePlatform() !== "mobile") {
    return { kind: "skipped", registered: [], available: [] }
  }

  const win = opts.win ?? (globalThis as unknown as WinWithCapacitor)
  const cap = win.Capacitor
  const headers = cap?.PluginHeaders ?? []
  const available = headers.map((h) => h.name)

  if (!cap || headers.length === 0) {
    log.warn("capacitor: native bridge exposed no PluginHeaders — plugins cannot be registered", {
      hasCapacitor: Boolean(cap),
    })
    return { kind: "unavailable", registered: [], available }
  }

  let registerFn = opts.registerFn
  if (!registerFn) {
    try {
      const core = await (opts.coreLoader ?? defaultCoreLoader)()
      registerFn = core.registerPlugin
    } catch (err) {
      log.warn("capacitor: failed to load @capacitor/core registerPlugin", {
        error: err instanceof Error ? err.message : String(err),
      })
      return { kind: "unavailable", registered: [], available }
    }
  }

  const registered: string[] = []
  for (const header of headers) {
    try {
      registerFn(header.name)
      registered.push(header.name)
    } catch (err) {
      log.warn("capacitor: registerPlugin failed", {
        plugin: header.name,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // Startup self-check: makes on-device verification a single logcat line —
  // confirms the native bridge is wired and which plugins are live.
  log.info("capacitor: native plugins registered", {
    registered,
    available,
    missing: available.filter((name) => !registered.includes(name)),
  })

  return { kind: "registered", registered, available }
}
