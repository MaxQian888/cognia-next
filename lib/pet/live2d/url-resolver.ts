// Maps a model's relative file paths to URLs the loaders can fetch. This is the
// seam the engine loads through: `ModelSettings.replaceFiles` rewrites every
// referenced resource path to a URL produced here.
//
// Two URL flavors, picked by file type:
//   • Images (textures) → `data:<mime>;base64,...` data URLs. Textures are the
//     only resource PixiJS loads through its `Assets` pipeline, and Pixi detects
//     an image by URL extension OR data-URL MIME (`loadTextures.test`). A blob
//     object URL has neither — its path is an opaque UUID, and Pixi's
//     `path.extname` ignores a `#.png` fragment — so `Assets.load` finds no
//     parser, the texture resolves to null, and the model crashes at render
//     ("texture.source of null"). A data URL passes `checkDataUrl`, so the
//     texture parser is selected. (Verified against pixi.js 8.19.)
//   • Everything else (moc3 / motion3.json / physics / pose / expressions) →
//     blob object URLs. These load through the engine's own XHR, which fetches
//     blob URLs directly; the `#.ext` fragment is kept (harmless, ignored by the
//     arraybuffer/JSON loaders) so callers see a stable, type-hinted URL.
//
// Data URLs need no revocation; only the blob object URLs are tracked, so
// `revokeAll` frees exactly the URLs that need it.

import type { ModelFileEntry } from "./types"

/**
 * Normalize a path for comparison and lookup: backslashes → slashes, strip a
 * leading "./", collapse repeated slashes, and lowercase. Lowercasing makes
 * lookups case-insensitive (model3.json refs sometimes differ in case from the
 * on-disk names); callers keep the original spelling for display separately.
 */
export function normalizePath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/{2,}/g, "/")
    .toLowerCase()
}

/**
 * Extension of a (normalized) path, including the dot — e.g. ".png", ".moc3".
 * Empty when the basename has no extension. A leading-dot file (".keep") has no
 * extension.
 */
function extname(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1)
  const dot = base.lastIndexOf(".")
  return dot > 0 ? base.slice(dot) : ""
}

/**
 * Image extensions PixiJS routes through its `Assets` texture loader, mapped to
 * the MIME its `checkDataUrl` recognizes. Membership here is what makes an entry
 * resolve to a data URL instead of a blob object URL.
 */
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
}

export interface UrlResolverDeps {
  createObjectURL?: (blob: Blob) => string
  revokeObjectURL?: (url: string) => void
  /** Blob → base64 `data:<mime>;...` URL (injectable for deterministic tests). */
  toDataUrl?: (blob: Blob, mime: string) => Promise<string>
}

export interface UrlResolver {
  /** Look up the URL for a (relative) path; undefined if unknown. */
  resolve(path: string): string | undefined
  /** Read-only view of normalized-path → resolved URL. */
  entries(): ReadonlyMap<string, string>
  /** Revoke every blob object URL this resolver created (data URLs need none). */
  revokeAll(): void
}

/**
 * Base64-encode a blob's bytes into a `data:<mime>;base64,...` URL via
 * `FileReader` (handles multi-MB textures without manual chunking, and works in
 * both the browser/Tauri webview and jsdom — unlike `Blob.arrayBuffer`, which
 * jsdom omits). The blob's own MIME is usually empty for our entries, so the
 * prefix is rewritten to `mime` — the image MIME PixiJS's `checkDataUrl` looks
 * for.
 */
async function defaultToDataUrl(blob: Blob, mime: string): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"))
    reader.readAsDataURL(blob)
  })
  const comma = dataUrl.indexOf(",")
  const base64 = comma === -1 ? "" : dataUrl.slice(comma + 1)
  return `data:${mime};base64,${base64}`
}

/**
 * Build a resolver over `entries`. Image entries become base64 data URLs (so
 * PixiJS can parse them); all other entries become blob object URLs created
 * eagerly. Async because the base64 conversion reads each image blob.
 */
export async function createUrlResolver(
  entries: ModelFileEntry[],
  deps: UrlResolverDeps = {}
): Promise<UrlResolver> {
  const create = deps.createObjectURL ?? ((blob: Blob) => URL.createObjectURL(blob))
  const revoke = deps.revokeObjectURL ?? ((url: string) => URL.revokeObjectURL(url))
  const toDataUrl = deps.toDataUrl ?? defaultToDataUrl

  const map = new Map<string, string>()
  // Only blob object URLs are revocable; data URLs are inert strings.
  const revocable: string[] = []

  for (const entry of entries) {
    const key = normalizePath(entry.path)
    // First writer wins on duplicate normalized keys — keep the URL stable.
    if (map.has(key)) continue

    const mime = IMAGE_MIME_BY_EXT[extname(key)]
    if (mime) {
      map.set(key, await toDataUrl(entry.blob, mime))
    } else {
      const url = create(entry.blob)
      revocable.push(url)
      map.set(key, url)
    }
  }

  return {
    resolve(path: string): string | undefined {
      const key = normalizePath(path)
      const url = map.get(key)
      if (url === undefined) return undefined
      // Data URLs already carry their type — return as-is. For blob URLs, append
      // the file extension as a URL fragment: a few non-image loaders sniff the
      // URL extension, and the fragment is ignored when the browser resolves the
      // blob (and by the arraybuffer/JSON loaders). Revocation uses the raw URL
      // kept in `revocable`, not this hinted one.
      if (url.startsWith("data:")) return url
      const ext = extname(key)
      return ext ? `${url}#${ext}` : url
    },
    entries(): ReadonlyMap<string, string> {
      return map
    },
    revokeAll(): void {
      for (const url of revocable) {
        revoke(url)
      }
      map.clear()
      revocable.length = 0
    },
  }
}
