/**
 * Plugin font bridge — ADR-0029.
 *
 * Wires `PluginFontContribution` entries from a plugin's manifest into the
 * live document by injecting one `<style id="plugin-fonts-{pluginId}">` block
 * per plugin with the per-file `@font-face` declarations. Families are also
 * registered with `lib/appearance/font-registry.ts` so the typography picker
 * lists them.
 *
 * Each font file's first four bytes are validated against the known
 * woff2/woff/ttf/otf signatures BEFORE the rule is added — corrupt or
 * mislabelled files would silently break the font loader otherwise. The
 * check is async (`fetch` + `arrayBuffer`) and runs in parallel for every
 * file in the contribution; the bridge waits for all of them before
 * inserting the `<style>` block so the user never sees a half-applied set.
 *
 * Idempotent: calling `applyPluginFonts` twice for the same plugin replaces
 * the previous block, never appends. `revertPluginFonts` removes the block
 * and unregisters every family this plugin owned.
 */

import type { PluginFontContribution, PluginFontFile } from "@/types/plugin/plugin"
import { registerPluginFont, unregisterPluginFontsByPlugin } from "@/lib/appearance/font-registry"

/** Known font magic bytes. */
const MAGIC_BYTES: ReadonlyArray<{ name: string; bytes: number[] }> = [
  { name: "woff2", bytes: [0x77, 0x4f, 0x46, 0x32] }, // wOF2
  { name: "woff", bytes: [0x77, 0x4f, 0x46, 0x46] }, // wOFF
  { name: "otf", bytes: [0x4f, 0x54, 0x54, 0x4f] }, // OTTO
  { name: "ttf-zero", bytes: [0x00, 0x01, 0x00, 0x00] }, // TrueType
  { name: "ttf-true", bytes: [0x74, 0x72, 0x75, 0x65] }, // 'true'
  { name: "ttf-typ1", bytes: [0x74, 0x79, 0x70, 0x31] }, // 'typ1'
]

/**
 * Inspect the first four bytes against the known signature list. Returns
 * the matched name (`woff2` / `woff` / `otf` / `ttf-*`) or null when no
 * signature matches.
 */
export function detectFontKind(bytes: ArrayBufferView | ArrayBuffer): string | null {
  const view =
    bytes instanceof ArrayBuffer
      ? new Uint8Array(bytes)
      : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.length < 4) return null
  for (const { name, bytes: sig } of MAGIC_BYTES) {
    if (view[0] === sig[0] && view[1] === sig[1] && view[2] === sig[2] && view[3] === sig[3]) {
      return name
    }
  }
  return null
}

/**
 * Map a magic-byte name to the CSS `format(...)` hint we put in `src`.
 * Browsers don't strictly require it but giving them a hint avoids parsing
 * the file when they already have a more efficient candidate.
 */
export function cssFormatHintFor(kind: string): string | null {
  switch (kind) {
    case "woff2":
      return "woff2"
    case "woff":
      return "woff"
    case "otf":
      return "opentype"
    case "ttf-zero":
    case "ttf-true":
    case "ttf-typ1":
      return "truetype"
    default:
      return null
  }
}

export interface ResolveAssetFn {
  /**
   * Convert a relative path under the plugin install root into something
   * the browser can load. Implementations vary by host:
   *   - Web mode: returns a public URL or rejects (no plugin assets in web).
   *   - Tauri: returns `convertFileSrc(absolutePath)`.
   * The bridge does not bake this in so we can test it with a mock and so
   * Web Workers / other shells can supply their own resolver.
   */
  (pluginRoot: string, relPath: string, mime?: string): string | Promise<string>
}

export interface ApplyPluginFontsArgs {
  pluginId: string
  pluginRoot: string
  fonts: PluginFontContribution[]
  resolveAsset: ResolveAssetFn
  /**
   * Override fetch — primarily for tests. Defaults to the global `fetch`.
   * The signature matches the browser's.
   */
  fetchImpl?: typeof fetch
  /** Where to insert the style tag. Defaults to `document.head`. */
  documentRoot?: Document
}

export interface ApplyPluginFontsResult {
  /** Families actually registered (passed validation). */
  registered: string[]
  /** Files we rejected by magic-byte mismatch. */
  rejected: Array<{ family: string; src: string; reason: string }>
}

/**
 * Apply a plugin's font contributions. Reads each declared file, validates
 * its magic bytes, and assembles one `@font-face` block per file. Failing
 * files are reported in `rejected` and skipped; if a family has zero
 * surviving faces it is not registered.
 *
 * Calling twice for the same plugin replaces the existing block.
 */
export async function applyPluginFonts(
  args: ApplyPluginFontsArgs
): Promise<ApplyPluginFontsResult> {
  const fetcher = args.fetchImpl ?? fetch
  const doc = args.documentRoot ?? (typeof document === "undefined" ? null : document)
  if (!doc) {
    // SSR / non-DOM context — nothing to inject. Still register families so
    // the picker shows them (the family won't actually render until the DOM
    // is around to receive the @font-face, but the registry is decoupled).
    const registered: string[] = []
    for (const font of args.fonts) {
      registerPluginFont(args.pluginId, font.family)
      registered.push(font.family)
    }
    return { registered, rejected: [] }
  }

  const rejected: Array<{ family: string; src: string; reason: string }> = []
  const familyRules: Map<string, string[]> = new Map()

  await Promise.all(
    args.fonts.flatMap((font) =>
      font.files.map(async (file) => {
        try {
          const url = await args.resolveAsset(args.pluginRoot, file.src, fontMimeType(file.src))
          const response = await fetcher(url)
          if (!response.ok) {
            rejected.push({
              family: font.family,
              src: file.src,
              reason: `HTTP ${response.status}`,
            })
            return
          }
          const buf = await response.arrayBuffer()
          const kind = detectFontKind(buf)
          if (!kind) {
            rejected.push({
              family: font.family,
              src: file.src,
              reason: "magic-byte mismatch (not woff2/woff/ttf/otf)",
            })
            return
          }
          const rule = buildFontFaceRule({
            family: font.family,
            url,
            file,
            kind,
            display: font.display,
            unicodeRange: font.unicodeRange,
          })
          const list = familyRules.get(font.family) ?? []
          list.push(rule)
          familyRules.set(font.family, list)
        } catch (err) {
          rejected.push({
            family: font.family,
            src: file.src,
            reason: (err as Error).message ?? "fetch failed",
          })
        }
      })
    )
  )

  // Remove any prior style block for this plugin before re-inserting.
  removeStyleBlock(doc, args.pluginId)

  const allRules = [...familyRules.values()].flat()
  if (allRules.length > 0) {
    const style = doc.createElement("style")
    style.id = styleElementId(args.pluginId)
    style.dataset.pluginFonts = args.pluginId
    style.textContent = allRules.join("\n")
    doc.head.appendChild(style)
  }

  const registered: string[] = []
  for (const [family, rules] of familyRules) {
    if (rules.length === 0) continue
    registerPluginFont(args.pluginId, family)
    registered.push(family)
  }
  return { registered, rejected }
}

function fontMimeType(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase()
  if (extension === "woff2") return "font/woff2"
  if (extension === "woff") return "font/woff"
  if (extension === "otf") return "font/otf"
  if (extension === "ttf") return "font/ttf"
  return "application/octet-stream"
}

/** Remove a plugin's `<style>` block + every family it owned. */
export function revertPluginFonts(pluginId: string, doc?: Document): number {
  const root = doc ?? (typeof document === "undefined" ? null : document)
  if (root) removeStyleBlock(root, pluginId)
  return unregisterPluginFontsByPlugin(pluginId)
}

function styleElementId(pluginId: string): string {
  // Keep the id namespaced + DOM-safe. Plugins are validated to be
  // /[a-z0-9_-]+/ at install time, so no escaping necessary.
  return `plugin-fonts-${pluginId}`
}

function removeStyleBlock(doc: Document, pluginId: string): void {
  const existing = doc.getElementById(styleElementId(pluginId))
  if (existing) existing.remove()
}

interface BuildRuleArgs {
  family: string
  url: string
  file: PluginFontFile
  kind: string
  display?: PluginFontContribution["display"]
  unicodeRange?: string
}

/**
 * Build a single `@font-face` rule. Pure — exported for tests. Family names
 * are wrapped in quotes so spaces don't break parsing; `url()` and
 * `format()` are emitted in the canonical order browsers prefer.
 */
export function buildFontFaceRule(args: BuildRuleArgs): string {
  const familyEscaped = args.family.replace(/"/g, '\\"')
  const formatHint = cssFormatHintFor(args.kind)
  const formatSegment = formatHint ? ` format("${formatHint}")` : ""
  const display = args.display ? `  font-display: ${args.display};\n` : ""
  const style = args.file.style ?? "normal"
  const unicode = args.unicodeRange ? `  unicode-range: ${args.unicodeRange};\n` : ""
  return [
    "@font-face {",
    `  font-family: "${familyEscaped}";`,
    `  src: url("${args.url}")${formatSegment};`,
    `  font-weight: ${args.file.weight};`,
    `  font-style: ${style};`,
    display,
    unicode,
    "}",
  ]
    .join("\n")
    .replace(/\n\n+/g, "\n")
}
