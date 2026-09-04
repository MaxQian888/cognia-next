"use client"

/**
 * Desktop app updates.
 *
 * Discovery prefers the signed catalog (which carries criticality, rollout and
 * release notes) and falls back to the Tauri updater endpoint so the app still
 * self-updates when the control plane is unreachable.
 *
 * macOS deliberately does NOT install in place. The upstream in-app
 * replacement path has open cross-volume, permission-denied and interrupted
 * rename failures, and a half-replaced app bundle is unrecoverable without a
 * reinstall. Until those are fixed and fault-injected, macOS hands off to the
 * signed, notarized DMG. That is a smaller promise, honestly kept.
 */

import type { UpdateCandidate } from "@cognia/agent-config-types"

import { APP_VERSION } from "@/lib/app-version"
import { detectOsFamily, type OsFamily } from "@/lib/platform/os"
import { isTauri } from "@/lib/tauri"

import type {
  UpdateAdapter,
  UpdateApplyContext,
  UpdateApplyResult,
  UpdateCheckContext,
} from "../adapter"
import { bestCandidate } from "../catalog-lookup"

export const DESKTOP_ASSET_ID = "app"

export interface DesktopAdapterDeps {
  isTauri?: () => boolean
  osFamily?: () => OsFamily
  appVersion?: string
  checkForUpdate?: typeof import("@/lib/tauri/updater").checkForUpdate
  downloadAndInstallUpdate?: typeof import("@/lib/tauri/updater").downloadAndInstallUpdate
  downloadUpdate?: typeof import("@/lib/tauri/updater").downloadUpdate
  installUpdate?: typeof import("@/lib/tauri/updater").installUpdate
  openExternal?: (url: string) => Promise<void>
  /** Platform triple used to filter catalog entries. */
  target?: string
}

/** Coarse platform triple matching the catalog's `target` field. */
export function desktopTarget(os: OsFamily): string {
  switch (os) {
    case "macos":
      return "darwin"
    case "windows":
      return "windows"
    case "linux":
      return "linux"
    default:
      return "unknown"
  }
}

export function createDesktopAdapter(deps: DesktopAdapterDeps = {}): UpdateAdapter {
  const tauri = deps.isTauri ?? isTauri
  const os = () => deps.osFamily?.() ?? detectOsFamily()
  const appVersion = deps.appVersion ?? APP_VERSION

  return {
    kind: "desktop",
    executor: "tauri",
    isSupported: () => tauri(),

    async check(context: UpdateCheckContext): Promise<UpdateCandidate[]> {
      const family = os()
      const fromCatalog = bestCandidate(context.catalog, {
        kind: "desktop",
        assetId: DESKTOP_ASSET_ID,
        executor: "tauri",
        currentVersion: appVersion,
        channel: context.channel,
        target: deps.target ?? desktopTarget(family),
        appVersion,
      })
      if (fromCatalog) {
        return [withMacHandoff(fromCatalog, family)]
      }

      // The control plane had nothing for us. Ask the Tauri endpoint directly
      // so a working release feed keeps the desktop updatable on its own.
      const check = deps.checkForUpdate ?? (await import("@/lib/tauri/updater")).checkForUpdate
      const update = await check()
      if (!update) return []
      const candidate: UpdateCandidate = {
        assetId: DESKTOP_ASSET_ID,
        kind: "desktop",
        executor: "tauri",
        currentVersion: appVersion,
        targetVersion: update.version,
        channel: context.channel,
        criticality: "routine",
        releaseNotes: update.body,
        releasedAt: update.date,
        source: "tauri-endpoint",
        // The Tauri updater verified minisign before handing us this handle.
        provenance: "verified",
      }
      return [withMacHandoff(candidate, family)]
    },

    async apply(
      candidate: UpdateCandidate,
      context: UpdateApplyContext
    ): Promise<UpdateApplyResult> {
      if (candidate.action === "open-store") {
        const url = candidate.externalUrl
        if (!url) {
          return {
            state: "failed",
            failure: {
              kind: "unsupported",
              code: "no_download_url",
              recoveryActionKey: "openReleasePage",
            },
          }
        }
        const open = deps.openExternal ?? (await import("@/lib/tauri/opener")).openExternal
        await open(url)
        return { state: "awaiting-store", externalUrl: url }
      }

      const mod = await import("@/lib/tauri/updater")
      const downloadAndInstall = deps.downloadAndInstallUpdate ?? mod.downloadAndInstallUpdate
      const download = deps.downloadUpdate ?? mod.downloadUpdate
      const install = deps.installUpdate ?? mod.installUpdate

      if (!context.consented) {
        // Background download leg. Bytes only, never the installer.
        const result = await download((p) => context.onProgress?.(p.downloaded, p.total))
        if (result === "noLongerAvailable") return { state: "current" }
        return { state: "awaiting-consent" }
      }

      const result = await downloadAndInstall((p) => context.onProgress?.(p.downloaded, p.total))
      if (result === "noLongerAvailable") return { state: "current" }
      if (result === "web") {
        return { state: "failed", failure: { kind: "unsupported", code: "not_desktop" } }
      }
      // `relaunching` and `installed` both mean the bytes are on disk and this
      // process is the stale one. `install` is referenced so the injected dep
      // stays part of the contract for callers that pre-downloaded.
      void install
      return { state: "awaiting-restart" }
    },
  }
}

/** On macOS, turn an in-app install into an explicit signed-DMG handoff. */
function withMacHandoff(candidate: UpdateCandidate, os: OsFamily): UpdateCandidate {
  if (os !== "macos") return candidate
  return {
    ...candidate,
    action: "open-store",
    externalUrl: candidate.externalUrl ?? macReleaseUrl(candidate.targetVersion),
  }
}

/** Signed, notarized DMG for a version, on the public release page. */
export function macReleaseUrl(version: string): string {
  const tag = version.startsWith("v") ? version : `v${version}`
  return `https://github.com/MaxQian888/cognia-next/releases/tag/${encodeURIComponent(tag)}`
}
