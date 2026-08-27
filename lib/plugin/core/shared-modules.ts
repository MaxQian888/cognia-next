/**
 * Shared-module whitelist for evaluated plugin bundles.
 *
 * Installed plugins are built with `esbuild --bundle --format=cjs` and run
 * through `(0, eval)` inside a CJS wrapper (see `evaluatePluginCode` in
 * `loader.ts`). Anything the bundle does not mark external gets inlined — and a
 * second inlined copy of React is fatal: hooks read the dispatcher off the
 * `react` module instance that called them, so a plugin component rendering
 * inside the host's tree with its own React throws `Invalid hook call`. The
 * host therefore hands out its own already-evaluated instances for a small,
 * closed set of specifiers, and `cognia plugin build` marks exactly those
 * external.
 *
 * `react-dom` is deliberately NOT shared. It would give plugins `createPortal`,
 * letting a slot contribution render anywhere in the document and escape both
 * the extension slot it was mounted into and the `@scope`-d stylesheet that
 * bounds it. Components that genuinely need layering come from
 * `@cognia/plugin-ui`, whose Radix portals the host mounts and controls.
 */

import { loggers } from "@cognia/logging"

const sharedModuleLogger = loggers.plugin.child("shared-modules")

/**
 * Specifiers a plugin bundle may leave external. Closed on purpose: every entry
 * is a public contract we then owe compatibility on, so subpaths a plugin might
 * plausibly reach for (`react/compiler-runtime`, `@cognia/plugin-ui/button`)
 * are absent until something needs them.
 */
export const PLUGIN_SHARED_MODULES = [
  "react",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "@cognia/plugin-sdk",
  "@cognia/plugin-ui",
  "lucide-react",
] as const

export type PluginSharedModule = (typeof PLUGIN_SHARED_MODULES)[number]

export function isSharedModuleSpecifier(specifier: string): specifier is PluginSharedModule {
  return (PLUGIN_SHARED_MODULES as readonly string[]).includes(specifier)
}

const registry = new Map<string, unknown>()
const priming = new Map<PluginSharedModule, Promise<void>>()
let allPriming: Promise<void> | null = null

const sharedModuleLoaders: Record<PluginSharedModule, () => Promise<unknown>> = {
  react: () => import("react"),
  "react/jsx-runtime": () => import("react/jsx-runtime"),
  "react/jsx-dev-runtime": () => import("react/jsx-dev-runtime"),
  "@cognia/plugin-sdk": () => import("@cognia/plugin-sdk"),
  "@cognia/plugin-ui": () => import("@cognia/plugin-ui"),
  "lucide-react": () =>
    import("@/lib/icons/lucide-require-compat").then((module) => module.lucideRequireCompat),
}

/**
 * Load every shared module into a synchronous lookup table.
 *
 * `require()` inside an evaluated bundle is synchronous, so the modules have to
 * be resolved *before* the plugin code runs. Each import settles independently:
 * one unavailable module (a profile that tree-shakes the SDK, a partial build)
 * must not deny the others, and the plugin that actually reaches for the
 * missing one gets a specific error at `require()` time instead.
 */
export function primeSharedModules(
  specifiers: readonly PluginSharedModule[] = PLUGIN_SHARED_MODULES
): Promise<void> {
  if (specifiers === PLUGIN_SHARED_MODULES && allPriming) return allPriming
  const result = Promise.all(
    specifiers.map((specifier) => {
      const existing = priming.get(specifier)
      if (existing) return existing

      const pending = (async () => {
        try {
          registry.set(specifier, normalizeInterop(await sharedModuleLoaders[specifier]()))
        } catch (error) {
          sharedModuleLogger.warn("shared module unavailable", {
            specifier,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      })()
      priming.set(specifier, pending)
      return pending
    })
  ).then(() => undefined)
  if (specifiers === PLUGIN_SHARED_MODULES) allPriming = result
  return result
}

/**
 * A CJS bundle written by esbuild reads `require("react").useState`, so the
 * namespace object an ESM `import()` yields has to be flattened past its
 * `default` when that default is the real CJS export object. Mirrors the
 * `__toESM`/`__toCJS` interop esbuild itself emits.
 */
function normalizeInterop(mod: unknown): unknown {
  if (mod && typeof mod === "object" && "default" in mod) {
    const candidate = (mod as { default: unknown }).default
    // Only unwrap when `default` looks like the whole module (a CJS export
    // object re-exported under `default`), not when it is one named export
    // among many that happens to be called `default`.
    if (candidate && (typeof candidate === "object" || typeof candidate === "function")) {
      const named = Object.keys(mod as object).filter((k) => k !== "default" && k !== "__esModule")
      const onDefault = new Set(Object.keys(candidate as object))
      if (named.length > 0 && named.every((k) => onDefault.has(k))) return candidate
    }
  }
  return mod
}

/**
 * Build the `require` a plugin bundle is invoked with. Non-whitelisted
 * specifiers keep throwing — the diagnostic names the offending specifier and
 * what the plugin can do about it, because the alternative (returning
 * `undefined`) surfaces later as an unreadable `undefined is not a function`
 * deep inside the plugin.
 */
export function createPluginRequire(originalPath: string): (specifier: string) => unknown {
  return (specifier: string) => {
    if (isSharedModuleSpecifier(specifier)) {
      if (registry.has(specifier)) return registry.get(specifier)
      throw new Error(
        `require("${specifier}") is shared by the host but was not available in this runtime. ` +
          `Path: ${originalPath}`
      )
    }
    throw new Error(
      `require("${specifier}") is not available to plugins. Bundle it into your plugin, ` +
        `or use one of the host-shared modules: ${PLUGIN_SHARED_MODULES.join(", ")}. ` +
        `Path: ${originalPath}`
    )
  }
}

/** Test seam — drops the primed table so a suite can re-prime with fresh mocks. */
export function __resetSharedModulesForTest(): void {
  registry.clear()
  priming.clear()
  allPriming = null
}
