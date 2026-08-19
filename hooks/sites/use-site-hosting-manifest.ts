"use client"

/**
 * Read/write state for a Site's `.cognia/hosting.json`.
 *
 * The manifest is the hard precondition for provisioning bindings, building a
 * version, and running a preview — and nothing in the app could create one, so
 * those three steps failed with a raw file-read error and no way forward. This
 * hook backs the in-console editor: the file on disk is the source of truth
 * (no Dexie table, no schema change), the draft text lives in the editor
 * component, and validation runs through the real parser so the editor cannot
 * save something the build would reject.
 *
 * Off the desktop shell it reports `unsupported` and never attempts a read:
 * `readTextFile` falls back to `fetch(path)` in the browser, which would return
 * the dev server's 404 HTML and surface as a bogus "invalid JSON" error.
 */
import { useCallback, useEffect, useRef, useState } from "react"

import { usePlatform } from "@/hooks/use-platform"
import {
  probeSiteSource,
  readSiteHostingManifestFile,
  writeSiteHostingManifestFile,
  type SiteManifestReadResult,
} from "@/lib/sites/manifest-file"
import {
  scaffoldSiteHostingManifestFromProbe,
  serializeSiteHostingManifest,
  type SiteScaffoldFile,
  type SiteScaffoldResult,
} from "@/lib/sites/manifest-scaffold"
import type { SiteProjectRow } from "@/types/sites"

export type SiteManifestState =
  /** This shell has no filesystem for the Site's source tree. */
  { status: "unsupported" } | { status: "loading" } | SiteManifestReadResult

export interface SiteHostingManifestDeps {
  read: typeof readSiteHostingManifestFile
  write: typeof writeSiteHostingManifestFile
  probe: typeof probeSiteSource
  /** Today as YYYY-MM-DD, for the scaffold's Cloudflare compatibility date. */
  today: () => string
}

export interface SiteScaffoldDraft extends SiteScaffoldResult {
  /** Serialized manifest, ready to drop into the editor. */
  text: string
}

export interface SiteHostingManifestController {
  state: SiteManifestState
  /** The manifest exists and parses — build, preview, and provision can run. */
  ready: boolean
  /** Manifest text to seed an editor with, empty when there is no file yet. */
  text: string
  refresh: () => Promise<void>
  /**
   * Generate a starting manifest from the source tree. Deliberately does NOT
   * write: the user reviews the guess in the editor and presses save.
   */
  scaffold: () => Promise<SiteScaffoldDraft | undefined>
  /** Write the manifest (and any companion files), then re-read from disk. */
  save: (text: string, extraFiles?: readonly SiteScaffoldFile[]) => Promise<void>
}

function isoDate(): string {
  return new Date().toISOString().slice(0, 10)
}

export function useSiteHostingManifest(
  site: SiteProjectRow | null,
  dependencies?: Partial<SiteHostingManifestDeps>
): SiteHostingManifestController {
  const platform = usePlatform()
  const supported = platform === "tauri"
  // `null` means "no answer for the current inputs yet". Whether that reads as
  // `loading` or `unsupported` is derived, so the effect never has to reset it
  // synchronously when the shell or the selection changes.
  const [answer, setAnswer] = useState<{ key: string; state: SiteManifestState } | null>(null)

  // Captured once, on purpose: injected dependencies are a test seam, never
  // reactive input. Keying `load` off their identity made an inline object
  // literal re-run the read effect into itself until the heap gave out.
  const depsRef = useRef<SiteHostingManifestDeps>({
    read: readSiteHostingManifestFile,
    write: writeSiteHostingManifestFile,
    probe: probeSiteSource,
    today: isoDate,
    ...dependencies,
  })

  const siteId = site?.id ?? null
  const sourceRoot = site?.sourceRoot ?? ""
  const sourceSubpath = site?.sourceSubpath ?? ""

  const load = useCallback(async (): Promise<SiteManifestState> => {
    if (!supported) return { status: "unsupported" }
    if (!siteId) return { status: "loading" }
    try {
      return await depsRef.current.read({ sourceRoot, sourceSubpath })
    } catch (error) {
      // The read path already folds absence and unreadable files into
      // `missing`; anything left is a host failure worth showing verbatim.
      return {
        status: "invalid",
        path: "",
        text: "",
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }, [supported, siteId, sourceRoot, sourceSubpath])

  const key = `${supported ? "host" : "web"}:${siteId ?? ""}`
  const state: SiteManifestState =
    answer?.key === key
      ? answer.state
      : supported
        ? { status: "loading" }
        : { status: "unsupported" }

  useEffect(() => {
    if (!supported || !siteId) return
    let cancelled = false
    void load().then((next) => {
      if (!cancelled) setAnswer({ key, state: next })
    })
    return () => {
      cancelled = true
    }
  }, [supported, siteId, key, load])

  const refresh = useCallback(async () => {
    setAnswer({ key, state: await load() })
  }, [key, load])

  const scaffold = useCallback(async (): Promise<SiteScaffoldDraft | undefined> => {
    if (!supported || !site) return undefined
    const result = scaffoldSiteHostingManifestFromProbe(
      await depsRef.current.probe({
        sourceRoot: site.sourceRoot,
        sourceSubpath: site.sourceSubpath,
      }),
      depsRef.current.today()
    )
    return { ...result, text: serializeSiteHostingManifest(result.manifest) }
  }, [supported, site])

  const save = useCallback(
    async (text: string, extraFiles?: readonly SiteScaffoldFile[]) => {
      if (!supported || !site) throw new Error("Sites manifest editing requires the desktop host")
      await depsRef.current.write(
        { sourceRoot: site.sourceRoot, sourceSubpath: site.sourceSubpath },
        { manifestText: text, extraFiles }
      )
      setAnswer({ key, state: await load() })
    },
    [supported, site, key, load]
  )

  return {
    state,
    ready: state.status === "ok",
    text: state.status === "ok" || state.status === "invalid" ? state.text : "",
    refresh,
    scaffold,
    save,
  }
}
