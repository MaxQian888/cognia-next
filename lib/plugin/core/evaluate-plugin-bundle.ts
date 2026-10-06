import { assertNoHostPrivateImports } from "../security/import-boundary"
import { createPluginRequire } from "./shared-modules"

/**
 * The plugin's code was retrieved and then threw while evaluating.
 *
 * Distinct from a transport failure so `importModule` can stop walking its
 * fallback chain: another transport would fetch the same bytes and throw the
 * same way, and continuing would bury the author's real error.
 */
export class PluginEvaluationError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown
  ) {
    super(message)
    this.name = "PluginEvaluationError"
  }
}

/** Evaluate a bundled CJS entry against primed host modules, without a module cache. */
export function evaluatePluginBundle(code: string, originalPath: string): Record<string, unknown> {
  assertNoHostPrivateImports(code, originalPath)
  const pluginExports: Record<string, unknown> = {}
  const pluginModule = { exports: pluginExports }
  const wrappedCode = `(function(module, exports, require) { ${code}\n})`
  try {
    const factory = (0, eval)(wrappedCode)
    factory(pluginModule, pluginExports, createPluginRequire(originalPath))
    return pluginModule.exports
  } catch (error) {
    throw new PluginEvaluationError(
      `Failed to evaluate plugin code from ${originalPath}: ${error}`,
      error
    )
  }
}

let browserEvaluationSequence = 0

/**
 * Browsers execute an external Blob script under script-src blob:, without
 * unsafe-eval. The short-lived handoff is removed before author code runs;
 * each invocation owns its exports and the host's whitelisted require.
 * Node and DOM-only test shims retain the synchronous CJS evaluator.
 */
export async function evaluatePluginBundleAsync(
  code: string,
  originalPath: string,
  { timeoutMs = 15_000 }: { timeoutMs?: number } = {}
): Promise<Record<string, unknown>> {
  assertNoHostPrivateImports(code, originalPath)
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") {
    return evaluatePluginBundle(code, originalPath)
  }
  const key = `__cogniaPluginEvaluation_${Date.now()}_${++browserEvaluationSequence}`
  const pluginModule = { exports: {} as Record<string, unknown> }
  const script = document.createElement("script")
  const globalRecord = globalThis as unknown as Record<string, unknown>
  return new Promise((resolve, reject) => {
    let settled = false
    let url: string | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const cleanup = () => {
      if (timer) clearTimeout(timer)
      delete globalRecord[key]
      script.onload = null
      script.onerror = null
      script.remove()
      window.removeEventListener("error", onError)
      if (url) URL.revokeObjectURL(url)
    }
    const finish = (error?: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      if (error !== undefined) {
        reject(
          new PluginEvaluationError(
            `Failed to evaluate plugin code from ${originalPath}: ${error}`,
            error
          )
        )
      } else resolve(pluginModule.exports)
    }
    const onError = (event: ErrorEvent) => {
      if (url && event.filename === url) {
        event.preventDefault()
        finish(event.error ?? new Error(event.message))
      }
    }
    try {
      Object.defineProperty(globalRecord, key, {
        configurable: true,
        value: {
          module: pluginModule,
          require: createPluginRequire(originalPath),
          done: () => finish(),
          fail: (error: unknown) =>
            finish(error ?? new Error("Plugin threw without an error value")),
        },
      })
      const source = `(()=>{const bridge=globalThis[${JSON.stringify(key)}];delete globalThis[${JSON.stringify(key)}];if(!bridge)return;try{(function(module,exports,require){\n${code}\n})(bridge.module,bridge.module.exports,bridge.require);bridge.done();}catch(error){bridge.fail(error);}})();`
      url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }))
      script.src = url
      script.async = true
      script.onerror = () => finish(new Error("Plugin script was blocked or failed to load"))
      script.onload = () => {
        if (!settled) finish(new Error("Plugin script loaded without completing evaluation"))
      }
      window.addEventListener("error", onError)
      timer = setTimeout(
        () => finish(new Error(`Plugin script evaluation timed out after ${timeoutMs}ms`)),
        timeoutMs
      )
      document.head.appendChild(script)
    } catch (error) {
      finish(error)
    }
  })
}
