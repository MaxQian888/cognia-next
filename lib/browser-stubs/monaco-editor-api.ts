/**
 * Bundler-alias target for `monaco-editor/esm/vs/editor/editor.api.js`.
 *
 * # Why the specifier needs an alias at all
 *
 * `y-monaco@0.1.6` is the only thing in the graph that imports Monaco as a
 * *value*, and it reaches for the legacy deep path
 * `monaco-editor/esm/vs/editor/editor.api.js`. `monaco-editor@0.56` added an
 * `exports` map whose subpath patterns are already rooted at `esm/vs`:
 *
 *   "./*.js": "./esm/vs/*.js"
 *   "./*":    "./esm/vs/*.js"
 *
 * so that request now resolves to `esm/vs/esm/vs/editor/editor.api.js`, which
 * does not exist, and both bundlers fail the build with MODULE_NOT_FOUND.
 * y-monaco has no release that uses the post-`exports` path, so the specifier
 * has to be redirected here.
 *
 * # Why it is redirected here rather than at the real file
 *
 * Pointing the alias at `node_modules/monaco-editor/esm/vs/editor/editor.api.js`
 * would resolve, and would be wrong twice over. This app never bundles Monaco.
 * `scripts/build/copy-monaco-assets.mjs` copies the `min/vs` AMD build into
 * `public/monaco/vs/` and `@monaco-editor/react`'s loader pulls it at runtime,
 * which is what lets the Tauri build run offline under a strict CSP and what
 * keeps Monaco's several-megabyte source tree out of the static export.
 * Aliasing to the ESM tree would drag that whole graph into the canvas chunk
 * *and* leave two independent Monaco copies on the page: the AMD one every
 * editor model belongs to, and a bundled one whose `Range` and `Selection` are
 * different classes.
 *
 * So this module forwards to the instance that is already loaded. y-monaco
 * touches exactly three value-level members (`Range`, `Selection`,
 * `SelectionDirection`). Everything else it names from Monaco is a JSDoc type
 * and erases. `monaco-editor-api.test.ts` re-derives that set from the
 * installed package, so a y-monaco upgrade that reaches for a fourth member
 * fails the suite instead of failing in the browser.
 *
 * # Why every export resolves lazily
 *
 * The import is static and evaluates when the y-monaco chunk loads, but Monaco
 * arrives asynchronously. Each export below therefore reads the runtime
 * instance at *call* time, not at module eval. In practice the ordering is
 * never tight, because `bindMonacoEditor` runs from the canvas editor's
 * `onMount` and so an editor already exists. Its caller in
 * `hooks/canvas/use-canvas-collaborative-editor.ts` catches, logs and returns
 * null, so the thrown error degrades to "collaboration unavailable" rather
 * than taking the canvas down.
 */

import { loader } from "@monaco-editor/react"

import type * as MonacoApi from "monaco-editor"

type MonacoRuntime = typeof MonacoApi

/**
 * The Monaco the app's editors were actually created from.
 *
 * The loader's stored instance is preferred because it is by definition the
 * one `@monaco-editor/react` handed to `onMount`. `globalThis.monaco` is the
 * fallback, since the AMD bundle assigns it unconditionally and so covers a
 * Monaco loaded by something other than the React wrapper.
 */
function runtimeMonaco(): MonacoRuntime {
  const stored = loader.__getMonacoInstance() as MonacoRuntime | null
  const instance = stored ?? (globalThis as { monaco?: MonacoRuntime }).monaco
  if (!instance) {
    throw new Error(
      "monaco-editor requested before the runtime instance loaded. Monaco is " +
        "loaded on demand from public/monaco/vs by @monaco-editor/react, so " +
        "wait for the editor's onMount (or loadConfiguredMonaco()) before " +
        "importing y-monaco."
    )
  }
  return instance
}

/**
 * `new monaco.Range(...)`. A constructor that returns an object hands that
 * object back from `new`, so callers get a genuine runtime `Range`, the same
 * class Monaco's own `Range.isIRange` and decoration code check against.
 */
export const Range = function Range(
  this: unknown,
  ...args: ConstructorParameters<MonacoRuntime["Range"]>
) {
  return new (runtimeMonaco().Range)(...args)
} as unknown as MonacoRuntime["Range"]

/** `new monaco.Selection(...)`, plus the statics y-monaco reads off it. */
export const Selection = function Selection(
  this: unknown,
  ...args: ConstructorParameters<MonacoRuntime["Selection"]>
) {
  return new (runtimeMonaco().Selection)(...args)
} as unknown as MonacoRuntime["Selection"]

Object.defineProperty(Selection, "createWithDirection", {
  configurable: true,
  value: (...args: Parameters<MonacoRuntime["Selection"]["createWithDirection"]>) =>
    runtimeMonaco().Selection.createWithDirection(...args),
})

/**
 * `monaco.SelectionDirection.RTL`, read through to the runtime enum so the
 * numeric values compare equal to whatever `selection.getDirection()` returns.
 * A proxy rather than a copied object, because the enum is then read at access
 * time, which is what keeps this correct if Monaco has not loaded at module
 * eval.
 */
export const SelectionDirection: MonacoRuntime["SelectionDirection"] = new Proxy(
  {} as MonacoRuntime["SelectionDirection"],
  {
    get: (_target, key) =>
      (runtimeMonaco().SelectionDirection as unknown as Record<string | symbol, unknown>)[key],
    has: (_target, key) => key in (runtimeMonaco().SelectionDirection as object),
    ownKeys: () => Reflect.ownKeys(runtimeMonaco().SelectionDirection as object),
    getOwnPropertyDescriptor: (_target, key) =>
      Reflect.getOwnPropertyDescriptor(runtimeMonaco().SelectionDirection as object, key),
  }
)
