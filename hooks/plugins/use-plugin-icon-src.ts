"use client"

/**
 * React face of `pluginIconRender`: resolves a plugin's already-computed icon
 * into something an `<img>` can load, wiring Tauri's asset protocol for the
 * one transport that needs it.
 *
 * `convertFileSrc` lives behind a dynamic import because pulling
 * `@tauri-apps/api/core` into a browser bundle is exactly what the platform
 * gates exist to avoid. Until it resolves (and forever, off the desktop shell)
 * a `file`-transport icon falls back to the initial avatar rather than
 * rendering a broken image.
 */

import { useEffect, useState } from "react"

import { canUseTauriInvoke } from "@/lib/native/utils"
import {
  pluginIconRender,
  type FileSrcConverter,
  type PluginIconRender,
} from "@/lib/plugin/utils/icon-src"
import type { PluginResolvedIcon } from "@/types/plugin"

let cachedConverter: FileSrcConverter | null = null

/**
 * Tauri's `convertFileSrc`, or undefined off the desktop shell.
 *
 * Shared by the avatar and the screenshot gallery, which both have to turn a
 * plugin-relative asset path into something a webview can load.
 *
 * `enabled` keeps a browser build from ever reaching for the module: only a
 * `file`-transport asset needs it, and asking unconditionally is what the
 * platform gates exist to prevent.
 */
export function usePluginFileSrcConverter(enabled: boolean): FileSrcConverter | undefined {
  const [converter, setConverter] = useState<FileSrcConverter | null>(cachedConverter)

  useEffect(() => {
    if (!enabled || converter || !canUseTauriInvoke()) return
    let cancelled = false
    void import("@tauri-apps/api/core").then((mod) => {
      cachedConverter = mod.convertFileSrc
      if (!cancelled) setConverter(() => mod.convertFileSrc)
    })
    return () => {
      cancelled = true
    }
  }, [enabled, converter])

  return converter ?? undefined
}

export function usePluginIconSrc(resolved: PluginResolvedIcon | undefined): PluginIconRender {
  const converter = usePluginFileSrcConverter(
    resolved?.kind === "image" && resolved.transport === "file"
  )
  return pluginIconRender(resolved, converter)
}
