// Registers the engine's Live2D render pipe with pixi's extension system ONCE,
// up front, before any Pixi renderer is created.
//
// Why this exists: `untitled-pixi-live2d-engine` otherwise registers its render
// pipe lazily on the first render and logs a deprecation warning ("Lazy Live2D
// render pipe registration is deprecated. Register Live2DPlugin explicitly with
// `extensions.add(Live2DPlugin)` before creating the Pixi renderer.") on EVERY
// frame. Under `next dev` those per-frame browser console messages are forwarded
// to the dev server and buffered unboundedly; a timer that `join`s the buffer
// eventually blows the 4 GB dev heap and OOM-crashes the server. Registering the
// plugin once silences the warning and removes the leak — and drops a per-frame
// `console.warn` cost in production too.
//
// The DI seams keep pixi + the engine lazy (they must never enter the main
// bundle — both are `import()`ed on demand) and let tests inject fakes. The
// module-level `registered` flag makes repeat calls a no-op: pixi's own
// `extensions.add` warns on a double add, and the canvas re-mounts under React
// strict mode. `resetLive2dPluginForTests` clears the flag between tests
// (mirrors `resetCubismCoreLoaderForTests` in ./core-loader).

/** Pixi's extension registry — only the `add` this module calls is typed. */
interface PixiExtensions {
  add: (...extensions: unknown[]) => unknown
}

export interface RegisterPluginDeps {
  /** Import pixi.js for its `extensions` registry. */
  importPixi?: () => Promise<{ extensions: PixiExtensions }>
  /** Import the engine for its `Live2DPlugin` render pipe. */
  importEngine?: () => Promise<{ Live2DPlugin: unknown }>
}

let registered = false

/** Clear the one-time registration guard. Test-only. */
export function resetLive2dPluginForTests(): void {
  registered = false
}

/**
 * Register the Live2D render pipe with pixi exactly once. Safe to call on every
 * canvas mount — after the first success it returns immediately. Rejects if pixi
 * or the engine fail to import (callers treat registration as best-effort: the
 * engine still self-registers lazily as a fallback).
 */
export async function ensureLive2dPluginRegistered(deps: RegisterPluginDeps = {}): Promise<void> {
  if (registered) return

  const importPixi =
    deps.importPixi ??
    (() => import("pixi.js") as unknown as Promise<{ extensions: PixiExtensions }>)
  const importEngine =
    deps.importEngine ??
    (() =>
      import("untitled-pixi-live2d-engine/cubism") as unknown as Promise<{ Live2DPlugin: unknown }>)

  const [{ extensions }, { Live2DPlugin }] = await Promise.all([importPixi(), importEngine()])
  extensions.add(Live2DPlugin)
  registered = true
}
