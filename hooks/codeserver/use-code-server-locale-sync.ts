"use client"

import { useEffect, useRef } from "react"

import { codeServerClient } from "@/lib/codeserver/client"
import {
  readRuntimeArgsLocale,
  vscodeLocaleForAppLanguage,
  withRuntimeArgsLocale,
} from "@/lib/codeserver/locale"
import { isTauri } from "@/lib/tauri"
import { useSettingsStore } from "@/stores"

export interface UseCodeServerLocaleSyncOptions {
  /**
   * Restart the code-server serving this pane. Required, not optional: VS Code
   * reads `argv.json` only at workbench startup, so writing the locale without a
   * restart produces a silent no-op — the worst possible outcome for a setting the
   * user just changed. Called only when the locale actually changed.
   */
  restart: () => void
  /**
   * Called instead of `restart` when VS Code publishes no display-language pack
   * for the app's language. Without this the editor would just stay English with
   * no explanation, which reads as the sync being broken rather than as the
   * translation not existing.
   */
  onUntranslated?: (locale: string) => void
}

/**
 * Keeps the embedded code-server's display language in step with the app's.
 *
 * Two-part mechanism, because VS Code's display language is not a setting:
 *
 *  - `argv.json` carries `{"locale": "…"}` (written here), and is read only at
 *    workbench startup — hence the restart;
 *  - VS Code ships English only, so any other language needs an MS-CEINTL
 *    language pack. That install happens in Rust inside `codeserver_ensure`, off
 *    the locale this hook wrote, because the pack has to be on disk *before* the
 *    workbench boots. The restart is therefore also what installs it.
 *
 * Writes only on a real change. Without that guard the effect would restart the
 * editor on every mount — throwing away the user's open tabs and terminals to
 * re-apply a locale that was already correct.
 */
export function useCodeServerLocaleSync(
  enabled: boolean,
  options: UseCodeServerLocaleSyncOptions
): void {
  const language = useSettingsStore((s) => s.language)
  // Held in a ref so a re-render caused by anything else can't re-trigger a
  // restart; only a genuine locale change does.
  const restartRef = useRef(options.restart)
  const untranslatedRef = useRef(options.onUntranslated)
  useEffect(() => {
    restartRef.current = options.restart
    untranslatedRef.current = options.onUntranslated
  }, [options.restart, options.onUntranslated])

  useEffect(() => {
    if (!enabled || !isTauri()) return
    let cancelled = false
    void (async () => {
      const desired = vscodeLocaleForAppLanguage(language)
      const existingRaw = await codeServerClient.readRuntimeArgs().catch(() => "")
      if (cancelled) return
      if (readRuntimeArgsLocale(existingRaw) === desired) return
      try {
        await codeServerClient.writeRuntimeArgs(withRuntimeArgsLocale(existingRaw, desired))
      } catch {
        // A read-only state dir means the editor stays in its current language;
        // that must not take the pane down with it.
        return
      }
      if (cancelled) return
      // Restarting is only worth the user's open tabs and terminals if the new
      // locale can actually change anything. English needs no pack, so it always
      // can; for anything else, no published pack means the workbench would come
      // back up in the same English it went down in.
      const translatable =
        desired === "en" ||
        (await codeServerClient.languagePackAvailable(desired).catch(() => true))
      if (cancelled) return
      if (!translatable) {
        untranslatedRef.current?.(desired)
        return
      }
      restartRef.current()
    })()
    return () => {
      cancelled = true
    }
  }, [enabled, language])
}
