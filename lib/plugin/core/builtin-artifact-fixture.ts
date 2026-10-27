/**
 * Test seam for host suites that drive a real first-party plugin.
 *
 * A host test that wants "the real plugin" gets what the app ships: the
 * built-in chunk staged from the plugin artifact set into
 * `public/_cognia/builtin-plugins/` (`pnpm plugin:builtin:build`), verified
 * against the digest the registry index pins and evaluated against the host's
 * shared modules, exactly as `PluginLoader` does. It never imports plugin
 * source, so the host's suites run the same whether plugin sources are in
 * this checkout or the set came from elsewhere.
 *
 * Test-only: reads the staged tree with `node:fs`, and nothing in the app
 * imports it.
 */
import { existsSync, readFileSync } from "node:fs" // static-export-exempt: Node-only fixture imported exclusively by host *.test.ts suites.
import { join } from "node:path" // static-export-exempt: Node-only fixture imported exclusively by host *.test.ts suites.
import type { PluginManifest } from "@/types/plugin"
import { getBrowserBuiltinRegistryEntry } from "./browser-builtin-registry"
import { fetchAndVerifyBrowserBuiltinAsset } from "./browser-builtin-assets"
import { evaluatePluginBundleAsync } from "./evaluate-plugin-bundle"
import { primeSharedModules, sharedModulesReferencedBy } from "./shared-modules"

/** URL prefix the staged chunks are served under. */
const CHUNK_PREFIX = "/_cognia/builtin-plugins/"

/** What to run when the staged tree is missing. */
export const STAGE_BUILTINS_HINT =
  "run `pnpm plugin:builtin:build` to stage the plugin artifact set into public/_cognia/builtin-plugins/"

function publicRoot(): string {
  return join(process.cwd(), "public")
}

function requestPath(input: string | URL | Request): string {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  return raw.startsWith("/") ? raw : new URL(raw).pathname
}

/**
 * A `fetch` that serves staged built-in chunk URLs from `public/`, the way the
 * app's static server does. Pass it as `PluginLoader`'s `builtinAssetFetcher`
 * (or spy `globalThis.fetch` with it) so a suite booting the real manager can
 * load built-ins. Any other URL is refused, not forwarded.
 */
export function stagedBuiltinFetch(): typeof fetch {
  return (async (input: string | URL | Request) => {
    const pathname = requestPath(input).split("?")[0]
    if (!pathname.startsWith(CHUNK_PREFIX))
      throw new Error(`stagedBuiltinFetch serves built-in chunks only, not ${pathname}`)
    const parts = pathname.split("/").filter(Boolean)
    if (parts.some((part) => part === ".." || part === "."))
      throw new Error(`stagedBuiltinFetch refuses ${pathname}`)
    const file = join(publicRoot(), ...parts)
    if (!existsSync(file))
      throw new Error(`Staged built-in chunk ${pathname} is missing: ${STAGE_BUILTINS_HINT}`)
    return stagedResponse(readFileSync(file))
  }) as typeof fetch
}

/**
 * The slice of `Response` the loader reads. Built by hand because jsdom's
 * `Response` polyfill has no `arrayBuffer()`, and the suites that boot the real
 * manager run under jsdom.
 */
function stagedResponse(bytes: Uint8Array): Response {
  const body = () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    arrayBuffer: async () => body(),
    text: async () => new TextDecoder().decode(bytes),
    json: async () => JSON.parse(new TextDecoder().decode(bytes)),
  } as unknown as Response
}

/** The shipped (packaged) manifest of a browser built-in, from the registry index. */
export function builtinArtifactManifest(pluginId: string): PluginManifest {
  const entry = getBrowserBuiltinRegistryEntry(pluginId)
  if (!entry) throw new Error(`${pluginId} is not a browser built-in in the registry index`)
  return entry.manifest
}

/**
 * Evaluate a browser built-in's shipped chunk and return its module exports
 * (the plugin entry's named exports plus `default`). The chunk is verified
 * against the index digest first, so a stale stage fails loudly.
 */
export async function loadBuiltinArtifactExports(
  pluginId: string
): Promise<Record<string, unknown>> {
  const entry = getBrowserBuiltinRegistryEntry(pluginId)
  if (!entry?.asset) throw new Error(`${pluginId} has no staged chunk in the registry index`)
  const code = await fetchAndVerifyBrowserBuiltinAsset(entry.asset, stagedBuiltinFetch())
  await primeSharedModules([...entry.asset.sharedModules, ...sharedModulesReferencedBy(code)])
  return evaluatePluginBundleAsync(code, entry.asset.url)
}
