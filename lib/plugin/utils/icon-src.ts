/**
 * Turn a `PluginResolvedIcon` into something an `<img>` can actually load.
 *
 * `resolvePluginIcon` has always classified icons into lucide / inline /
 * remote / file / public with a path-traversal guard, and the result was
 * stored on both `Plugin.resolvedIcon` and `PluginRegistryEntry.resolvedIcon`.
 * No component ever read either field: every surface passed the raw
 * `manifest.icon` string to `PluginAvatar`, whose image test only accepts
 * `data:` / `http(s):` / `/`-prefixed values. A plugin shipping
 * `icon: "assets/icon.png"` therefore fell back to a letter avatar even though
 * the host had already resolved it to a real path.
 *
 * `file` is the transport that needed the extra step: the resolver produces an
 * absolute filesystem path, which a webview cannot load directly. Tauri's
 * asset protocol converts it. Off the desktop shell there is no such protocol,
 * so the caller falls back rather than rendering a broken image.
 */

import type { PluginResolvedIcon } from "@/types/plugin"

/**
 * The `convertFileSrc` implementation, injected so the pure mapping stays
 * testable and so a browser build never reaches for the Tauri module.
 */
export type FileSrcConverter = (path: string) => string

export interface PluginIconSrc {
  kind: "image"
  src: string
}

export interface PluginIconGlyph {
  kind: "lucide"
  name: string
}

export type PluginIconRender = PluginIconSrc | PluginIconGlyph | null

export function pluginIconRender(
  resolved: PluginResolvedIcon | undefined,
  convertFileSrc?: FileSrcConverter
): PluginIconRender {
  if (!resolved) return null
  if (resolved.kind === "lucide") return { kind: "lucide", name: resolved.name }
  if (resolved.kind === "fallback") return null

  if (resolved.transport === "file") {
    if (!convertFileSrc) return null
    try {
      return { kind: "image", src: convertFileSrc(resolved.src) }
    } catch {
      // A converter that throws (no asset protocol registered for this scope)
      // means the same thing as not having one.
      return null
    }
  }

  return { kind: "image", src: resolved.src }
}
