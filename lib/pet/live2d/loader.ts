// Drives loading a validated model into the Live2D engine. The engine import is
// behind a DI seam (`importEngine`) so it never enters the main bundle and tests
// can inject a fake. Flow: ensure core → import engine → build a blob-URL
// resolver over the entries → parse the settings JSON → construct
// CubismModelSettings → rewrite every resource path to a blob URL via
// `replaceFiles` → `Live2DModel.from(settings)`. Every failure leg is a typed
// code, and `dispose` revokes the object URLs and destroys the model.

import { ensureCubismCore } from "./core-loader"
import { readBlobText } from "./read-blob-text"
import type { Live2DManifest, ModelFileEntry } from "./types"
import { createUrlResolver } from "./url-resolver"

/** Minimal slice of the engine module the loader depends on. */
export interface EngineModule {
  Live2DModel: {
    from(source: unknown, options?: unknown): Promise<unknown>
  }
  CubismModelSettings: new (json: Record<string, unknown> & { url: string }) => {
    replaceFiles(replacer: (file: string, path: string) => string): void
  }
  MotionPriority: Record<string, number>
}

interface LoadedModelLike {
  destroy?: () => void
}

export interface LoaderDeps {
  ensureCore?: typeof ensureCubismCore
  importEngine?: () => Promise<EngineModule>
}

export type LoadResult =
  | { ok: true; model: unknown; dispose(): void }
  | { ok: false; code: "coreMissing" | "engineFailed" | "modelFailed" }

export interface LoadArgs {
  manifest: Live2DManifest
  entries: ModelFileEntry[]
}

/** Directory portion of a POSIX path. */
function dirname(path: string): string {
  const slash = path.lastIndexOf("/")
  return slash === -1 ? "" : path.slice(0, slash)
}

/** Join the settings dir with a relative ref into a full entry path. */
function joinFromSettings(settingsDir: string, ref: string): string {
  return settingsDir ? `${settingsDir}/${ref}` : ref
}

export interface Live2dLoader {
  load(args: LoadArgs): Promise<LoadResult>
}

export function createLive2dLoader(deps: LoaderDeps = {}): Live2dLoader {
  const ensureCore = deps.ensureCore ?? ensureCubismCore
  const importEngine =
    deps.importEngine ??
    (() => import("untitled-pixi-live2d-engine/cubism") as unknown as Promise<EngineModule>)

  return {
    async load(args: LoadArgs): Promise<LoadResult> {
      const coreReady = await ensureCore()
      if (!coreReady) {
        return { ok: false, code: "coreMissing" }
      }

      let engine: EngineModule
      try {
        engine = await importEngine()
      } catch {
        return { ok: false, code: "engineFailed" }
      }

      const settingsDir = dirname(args.manifest.settingsPath)
      // Tracked for the catch block; the resolver itself is a const once built
      // so the replaceFiles / dispose closures keep its non-undefined type.
      let cleanup: (() => void) | undefined
      try {
        const rawSettings = args.entries.find((e) => e.path === args.manifest.settingsPath)?.blob
        if (!rawSettings) {
          return { ok: false, code: "modelFailed" }
        }
        // Created inside the try so object-URL failures degrade to `modelFailed`.
        const resolver = createUrlResolver(args.entries)
        cleanup = () => resolver.revokeAll()

        const json = JSON.parse(await readBlobText(rawSettings)) as Record<string, unknown>

        const settings = new engine.CubismModelSettings({
          ...json,
          url: args.manifest.settingsPath,
        })
        settings.replaceFiles((_file, path) => {
          return resolver.resolve(joinFromSettings(settingsDir, path)) ?? _file
        })

        const model = (await engine.Live2DModel.from(settings)) as LoadedModelLike

        return {
          ok: true,
          model,
          dispose(): void {
            resolver.revokeAll()
            model.destroy?.()
          },
        }
      } catch {
        cleanup?.()
        return { ok: false, code: "modelFailed" }
      }
    },
  }
}
