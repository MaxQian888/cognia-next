/**
 * Fetch one browser built-in plugin's code chunk, and refuse it if it changed.
 *
 * These five built-ins are no longer part of the app bundle: `pnpm
 * plugin:builtin:build` compiles each to its own chunk under
 * `public/_cognia/builtin-plugins/` and records the chunk's SHA-256 in
 * `browser-builtin-assets.generated.json`, which the registry imports. The
 * loader then fetches a chunk only when the plugin is actually enabled.
 *
 * The digest is the point, not a nicety. A chunk arrives over the network like
 * any other asset and is then handed to `evaluatePluginCode` — so unlike a
 * statically-imported built-in, nothing about the delivery path proves it is
 * the code this build produced. Verifying against a hash baked into the bundle
 * closes that back: a chunk served from a stale CDN edge, a partial write, or a
 * substituted file fails here rather than executing.
 *
 * Fails closed in every direction — a non-OK response, a runtime with no Web
 * Crypto, or a digest mismatch all throw, and the plugin does not load.
 */
import type { BrowserBuiltinAsset } from "./browser-builtin-registry"

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

export async function fetchAndVerifyBrowserBuiltinAsset(
  asset: BrowserBuiltinAsset,
  fetcher: typeof fetch = fetch,
  subtle: SubtleCrypto | undefined = globalThis.crypto?.subtle
): Promise<string> {
  const response = await fetcher(asset.url)
  if (!response.ok) {
    throw new Error(
      `Failed to fetch browser builtin plugin asset: ${response.status} ${response.statusText}`
    )
  }
  if (!subtle) throw new Error("Web Crypto is required to verify browser builtin plugins")

  const bytes = await response.arrayBuffer()
  const actual = bytesToHex(await subtle.digest("SHA-256", bytes))
  if (actual !== asset.sha256) {
    throw new Error(`Browser builtin plugin integrity mismatch for ${asset.url}`)
  }
  return new TextDecoder().decode(bytes)
}
