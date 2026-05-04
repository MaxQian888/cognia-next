// Pull color themes out of a `.vsix` extension package.
//
// VSIX is a standard ZIP file with a fixed layout — the bits we care
// about live under `extension/`:
//   - `extension/package.json`  → manifest, lists `contributes.themes[]`
//   - `extension/<themePath>`   → the per-theme JSON files referenced
//     from the manifest. We resolve `path` relative to `extension/`.
//
// We deliberately ignore everything else (scripts, icons, READMEs, etc.).
// We parse every theme eagerly inside `readVsix` and drop the JSZip
// instance before returning, so callers receive fully-populated
// `ParsedTheme`s. This avoids a real bug we hit in production: the old
// implementation handed back a `parse: () => Promise<ParsedTheme>`
// closure that captured the zip; if the user took long enough to pick
// from the multi-theme dialog, V8 GC could release the zip buffer and
// the next `zip.file(...)` call returned null → "VSIX entry vanished"
// thrown into a try/catch that left the loading spinner on forever.
// Eager parsing means there is no closure and no GC race.

import JSZip from "jszip"
import { importVscodeThemeJson, type ParsedTheme } from "./parse-json"

/** Hard cap on VSIX size (10 MB). Bigger uploads are likely a misclick. */
export const MAX_VSIX_BYTES = 10 * 1024 * 1024

export interface VsixThemeManifestEntry {
  /** Display label from the VSCode manifest. */
  label: string
  /**
   * "vs" / "vs-dark" / "hc-black" / "hc-light" — VSCode's variant tag,
   * used as a hint when the theme JSON itself doesn't declare `type`.
   */
  uiTheme?: string
  /** Path inside the VSIX, normalized to forward slashes, with no leading `./`. */
  path: string
}

export interface VsixThemeReady extends VsixThemeManifestEntry {
  /**
   * Pre-parsed CustomTheme. The zip buffer is released after `readVsix`
   * returns, so consumers don't need to await anything per pick.
   */
  parsed: ParsedTheme
}

export interface VsixManifest {
  /** Extension display name (`displayName`) or `name` fallback. */
  displayName: string
  /** Top-level `name` field — usually `<publisher>.<name>`. */
  name: string
  /** Best-effort version tag for the UI badge. */
  version?: string
  /** Themes ready to be committed individually. */
  themes: VsixThemeReady[]
}

const MANIFEST_PATH = "extension/package.json"

/**
 * Read a VSIX `Blob`/`File`/`ArrayBuffer` and return the manifest with
 * every contributed theme already parsed. Throws when the file isn't a
 * ZIP, the manifest is missing, or there are no usable theme
 * contributions.
 */
export async function readVsix(input: ArrayBuffer | Uint8Array): Promise<VsixManifest> {
  try {
    const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input
    if (bytes.byteLength > MAX_VSIX_BYTES) {
      throw new Error(`VSIX exceeds size cap (${MAX_VSIX_BYTES} bytes)`)
    }

    const zip = await JSZip.loadAsync(bytes).catch((err) => {
      throw new Error(`Could not unzip VSIX: ${(err as Error).message}`)
    })

    const manifestFile = zip.file(MANIFEST_PATH)
    if (!manifestFile) {
      throw new Error(`VSIX is missing ${MANIFEST_PATH}`)
    }

    const manifestText = await manifestFile.async("string")
    let manifest: {
      name?: string
      displayName?: string
      version?: string
      contributes?: { themes?: unknown }
    }
    try {
      manifest = JSON.parse(manifestText) as typeof manifest
    } catch (err) {
      throw new Error(`VSIX package.json is invalid JSON: ${(err as Error).message}`)
    }

    const rawThemes = (manifest.contributes?.themes ?? []) as unknown
    const themesArr = Array.isArray(rawThemes) ? rawThemes : []
    const entries: VsixThemeReady[] = []
    for (const raw of themesArr) {
      if (!raw || typeof raw !== "object") continue
      const r = raw as { label?: unknown; uiTheme?: unknown; path?: unknown }
      if (typeof r.path !== "string" || r.path.length === 0) continue
      const path = normalizeRelPath(r.path)
      const fullPath = `extension/${path}`
      const file = zip.file(fullPath)
      if (!file) continue
      const label = typeof r.label === "string" && r.label.length > 0 ? r.label : path
      const uiTheme = typeof r.uiTheme === "string" ? r.uiTheme : undefined

      // Parse eagerly so the zip buffer can be released. Per-theme
      // failures are warned and skipped — the dialog still gets the
      // themes that did parse successfully, which is preferable to
      // failing the whole import for one bad entry.
      let parsed: ParsedTheme
      try {
        const text = await file.async("string")
        const forceVariant = uiThemeToVariant(uiTheme)
        parsed = importVscodeThemeJson(text, {
          nameHint: label,
          ...(forceVariant ? { forceVariant } : {}),
        })
      } catch (err) {
        console.warn(`VSIX theme ${path} failed to parse: ${(err as Error).message}`)
        continue
      }

      entries.push({ label, uiTheme, path, parsed })
    }

    if (entries.length === 0) {
      throw new Error("VSIX does not contribute any themes")
    }

    return {
      name: typeof manifest.name === "string" ? manifest.name : "extension",
      displayName:
        typeof manifest.displayName === "string"
          ? manifest.displayName
          : (manifest.name ?? "Extension"),
      version: typeof manifest.version === "string" ? manifest.version : undefined,
      themes: entries,
    }
  } catch (err) {
    // Pass through the typed VSIX-prefixed errors verbatim; wrap
    // anything else (e.g. an unexpected JSZip internal failure) so the
    // import-tab error UI always shows a "Failed to read VSIX: ..."
    // line rather than a generic stack trace.
    if (err instanceof Error && err.message.startsWith("VSIX")) throw err
    if (err instanceof Error && err.message.startsWith("Could not unzip VSIX")) throw err
    throw new Error(`Failed to read VSIX: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Normalise a `contributes.themes[].path` value to a forward-slash relative path. */
export function normalizeRelPath(path: string): string {
  let p = path.replace(/\\/g, "/")
  while (p.startsWith("./")) p = p.slice(2)
  while (p.startsWith("/")) p = p.slice(1)
  return p
}

/** Map `vs-dark` / `vs` / etc. to our two-state variant. */
export function uiThemeToVariant(uiTheme: string | undefined): "light" | "dark" | undefined {
  switch (uiTheme) {
    case "vs":
    case "hc-light":
      return "light"
    case "vs-dark":
    case "hc-black":
      return "dark"
    default:
      return undefined
  }
}
