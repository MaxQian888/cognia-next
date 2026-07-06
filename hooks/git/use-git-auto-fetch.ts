"use client"

/**
 * Background auto-fetch. When enabled in the panel prefs, periodically runs a
 * quiet `git fetch` so the ahead/behind indicator stays fresh without a manual
 * sync — VSCode's `git.autofetch` parity. Off by default.
 *
 * Mounted app-wide by the StatusBar branch indicator (the always-on fs-watcher
 * owner) so it runs on desktop even when the Source Control panel isn't open.
 * The fetch is silent: it never toasts, and errors (offline, no remote, auth
 * prompt) are swallowed so a background op can't spam the user. After a
 * successful fetch it refreshes status so ahead/behind reflects the new remote
 * refs even if the fs watcher ignores `.git` internals.
 */

import { useEffect } from "react"

import { isTauri } from "@/lib/tauri"
import { gitFetch } from "@/lib/git/commands"
import { refreshGitStatus } from "@/lib/git/load"
import { useGitStore } from "@/stores/git/git-store"
import { useSourceControlPrefs } from "@/hooks/git/use-source-control-prefs"

export function useGitAutoFetch(): void {
  const rootDir = useGitStore((s) => s.rootDir)
  const { prefs } = useSourceControlPrefs()
  const { autoFetch, autoFetchIntervalMinutes, fetchPrune } = prefs

  useEffect(() => {
    if (!isTauri() || !autoFetch || !rootDir) return
    const intervalMs = autoFetchIntervalMinutes * 60_000
    const id = setInterval(() => {
      void gitFetch(rootDir, undefined, fetchPrune)
        .then(() => refreshGitStatus(rootDir))
        .catch(() => {})
    }, intervalMs)
    return () => clearInterval(id)
  }, [autoFetch, autoFetchIntervalMinutes, fetchPrune, rootDir])
}
