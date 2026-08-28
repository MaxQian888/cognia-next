/**
 * Node reader for the generated browser built-in plugin chunks.
 *
 * Five built-ins (`cognia-office`, `cognia-pdf`, `cognia-documents`,
 * `cognia-presentations`, `cognia-visualize`) are no longer part of the app
 * bundle: `pnpm plugin:builtin:build` compiles each to its own chunk under
 * `public/_cognia/builtin-plugins/` and the loader fetches it by the
 * root-relative URL recorded in `browser-builtin-assets.generated.json`.
 *
 * A root-relative URL only resolves against a document origin. Under Node
 * `fetch("/_cognia/…")` rejects with `TypeError: Failed to parse URL`, so every
 * one of those built-ins failed to enable on the CLI and the supervised brain —
 * three of them (`documents`, `presentations`, `visualize`) declare headless
 * support and contribute agent tools, so the failure silently cost the headless
 * agent its authoring/validation tools rather than merely hiding UI.
 *
 * This fetcher resolves the same URL path against the chunk tree staged beside
 * the bundle (`scripts/build/lib/stage-builtin-plugin-assets.mjs`) and returns
 * the bytes as a `Response`, so the digest verification in
 * `fetchAndVerifyBrowserBuiltinAsset` runs exactly as it does in a browser.
 * Anything outside `/_cognia/builtin-plugins/` falls through to real `fetch`.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

/** URL prefix every generated built-in chunk is published under. */
export const BUILTIN_ASSET_URL_PREFIX = "/_cognia/builtin-plugins/"

/**
 * Directory suffixes searched at each walk-up level. The staged layout keeps
 * the URL path verbatim (`<layout>/_cognia/builtin-plugins/…`); the second
 * entry is the repo's own `public/` tree, so `pnpm cli:dev` and a `tsx` run
 * work against a checkout that never ran the CLI build.
 */
const ASSET_ROOT_CANDIDATES = ["", "public"] as const

export interface BuiltinAssetFetcherOptions {
  /**
   * Not `NodeJS.ProcessEnv`: the app augments that with a required
   * `NODE_ENV`, which every caller here would have to supply for the one
   * variable this actually reads. `process.env` still satisfies it.
   */
  env?: Readonly<Record<string, string | undefined>>
  execPath?: string
  exists?: (candidate: string) => boolean
  readFile?: (file: string) => Buffer
  /** Directory to start the walk-up from; defaults to this module's directory. */
  moduleDir?: string
  /** Delegate for URLs this reader does not own. */
  fallbackFetch?: typeof fetch
}

function moduleDirectory(): string {
  try {
    return path.dirname(fileURLToPath(import.meta.url))
  } catch {
    return typeof __dirname === "string" ? __dirname : process.cwd()
  }
}

/**
 * Locate the directory the chunk URLs are resolved against — the one that
 * CONTAINS `_cognia/builtin-plugins`, so `path.join(base, urlPath)` is the
 * whole resolution step.
 *
 * Order: an explicit `COGNIA_BUILTIN_PLUGIN_ASSETS` override (returned even
 * when empty, so a typo surfaces as "the tree you pointed at has no chunk"
 * rather than silently loading a different build), then the packaged layout
 * next to the executable, then a bounded walk up from this module.
 */
export function resolveBuiltinAssetRoot(
  options: BuiltinAssetFetcherOptions = {}
): string | undefined {
  const env = options.env ?? process.env
  const exists = options.exists ?? fs.existsSync

  const override = env.COGNIA_BUILTIN_PLUGIN_ASSETS?.trim()
  if (override) return override

  const hasChunks = (base: string) =>
    ASSET_ROOT_CANDIDATES.map((suffix) => (suffix ? path.join(base, suffix) : base)).find((dir) =>
      exists(path.join(dir, "_cognia", "builtin-plugins"))
    )

  const adjacent = hasChunks(path.dirname(options.execPath ?? process.execPath))
  if (adjacent) return adjacent

  let dir = options.moduleDir ?? moduleDirectory()
  for (let i = 0; i < 10; i++) {
    const found = hasChunks(dir)
    if (found) return found
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/**
 * Build the `builtinAssetFetcher` the CLI hands the plugin manager.
 *
 * Fails closed and loudly: a missing chunk tree or a missing chunk throws with
 * the path it looked for and the command that produces it, because the loader
 * would otherwise report only Node's opaque `Failed to parse URL`.
 */
export function makeNodeBuiltinAssetFetcher(
  options: BuiltinAssetFetcherOptions = {}
): typeof fetch {
  const readFile = options.readFile ?? fs.readFileSync
  const fallbackFetch = options.fallbackFetch ?? fetch

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (!url.startsWith(BUILTIN_ASSET_URL_PREFIX)) return fallbackFetch(input, init)

    const root = resolveBuiltinAssetRoot(options)
    if (!root) {
      throw new Error(
        `No built-in plugin chunk tree found for ${url}. Expected ` +
          `_cognia/builtin-plugins/ beside the bundle — run \`pnpm plugin:builtin:build\` ` +
          `(or set COGNIA_BUILTIN_PLUGIN_ASSETS to the directory containing it).`
      )
    }

    const segments = url.slice(1).split("/")
    // The catalog is generated, but the path is still joined onto a real
    // directory — refuse traversal rather than trust the provenance.
    if (segments.some((segment) => segment === ".." || segment === "" || segment === ".")) {
      throw new Error(`Refusing to resolve built-in plugin chunk with an unsafe path: ${url}`)
    }
    const file = path.join(root, ...segments)
    let bytes: Buffer
    try {
      bytes = readFile(file)
    } catch (error) {
      throw new Error(`Built-in plugin chunk ${url} is not readable at ${file}: ${String(error)}`)
    }
    // `Uint8Array` (not the Buffer view) so `arrayBuffer()` yields exactly the
    // chunk's bytes — a pooled Buffer's `.buffer` is the whole 8 KiB slab, and
    // hashing that would fail the integrity check on every load.
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: { "content-type": "text/javascript" },
    })
  }) as typeof fetch
}
