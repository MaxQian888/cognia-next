"use client"

/**
 * Mobile app updates.
 *
 * iOS: discovery and a store link. Nothing else. Downloading or replacing the
 * shipped bundle would violate App Store review, and the Update Center says
 * "the App Store installs this" rather than showing a button Cognia cannot
 * honor.
 *
 * Android: Play in-app updates. The background flow is the default. The
 * blocking flow is used only when the catalog marks the update critical or
 * incompatible AND the user confirmed, because a blocking full-screen update
 * on launch is indistinguishable from a broken app.
 */

import type { UpdateAssetKind, UpdateCandidate, UpdateExecutor } from "@cognia/agent-config-types"

import { APP_VERSION } from "@/lib/app-version"
import { detectOsFamily, type OsFamily } from "@/lib/platform/os"
import { isNativeMobile } from "@/lib/platform/detect"

import type {
  UpdateAdapter,
  UpdateApplyContext,
  UpdateApplyResult,
  UpdateCheckContext,
} from "../adapter"
import { bestCandidate } from "../catalog-lookup"

export const MOBILE_ASSET_ID = "app"

export interface MobileAdapterDeps {
  osFamily?: () => OsFamily
  isNativeMobile?: () => boolean
  appVersion?: string
  openExternal?: (url: string) => Promise<void>
  playCore?: {
    getAppUpdateInfo: typeof import("@/lib/capacitor/app-update").getAppUpdateInfo
    startFlexibleUpdate: typeof import("@/lib/capacitor/app-update").startFlexibleUpdate
    completeFlexibleUpdate: typeof import("@/lib/capacitor/app-update").completeFlexibleUpdate
    performImmediateUpdate: typeof import("@/lib/capacitor/app-update").performImmediateUpdate
    openAppStore: typeof import("@/lib/capacitor/app-update").openAppStore
  }
  /** Store landing pages. Operator-configured, not derivable from the repo. */
  storeUrls?: { ios?: string; android?: string }
}

const DEFAULT_STORE_URLS = {
  ios: "https://apps.apple.com/app/cognia/id0000000000",
  android: "https://play.google.com/store/apps/details?id=cn.cognia.app",
}

export function createMobileAdapter(
  kind: "mobile-ios" | "mobile-android",
  deps: MobileAdapterDeps = {}
) {
  const os = () => deps.osFamily?.() ?? detectOsFamily()
  const native = () => deps.isNativeMobile?.() ?? isNativeMobile()
  const appVersion = deps.appVersion ?? APP_VERSION
  const executor: UpdateExecutor = kind === "mobile-ios" ? "app-store" : "google-play"
  const storeUrl = () =>
    kind === "mobile-ios"
      ? (deps.storeUrls?.ios ?? DEFAULT_STORE_URLS.ios)
      : (deps.storeUrls?.android ?? DEFAULT_STORE_URLS.android)

  const adapter: UpdateAdapter = {
    kind: kind as UpdateAssetKind,
    executor,
    isSupported: () => native() && os() === (kind === "mobile-ios" ? "ios" : "android"),

    async check(context: UpdateCheckContext): Promise<UpdateCandidate[]> {
      // Play is authoritative about what the device can actually install.
      // The catalog only supplies criticality and notes on top of it.
      if (kind === "mobile-android" && deps.playCore) {
        const info = await deps.playCore.getAppUpdateInfo()
        if (info.kind === "ok" && info.value.availability === "available") {
          const catalogEntry = bestCandidate(context.catalog, {
            kind,
            assetId: MOBILE_ASSET_ID,
            executor,
            currentVersion: info.value.currentVersionName ?? appVersion,
            channel: context.channel,
          })
          return [
            {
              assetId: MOBILE_ASSET_ID,
              kind,
              executor,
              currentVersion: info.value.currentVersionName ?? appVersion,
              targetVersion: info.value.availableVersionName ?? catalogEntry?.targetVersion ?? "",
              channel: context.channel,
              criticality: catalogEntry?.criticality ?? "routine",
              compatibility: catalogEntry?.compatibility,
              releaseNotes: catalogEntry?.releaseNotes,
              rollout: catalogEntry?.rollout,
              source: "store",
              provenance: "verified",
              externalUrl: storeUrl(),
            },
          ]
        }
        if (info.kind === "ok") return []
        // Play Core is unreachable. Fall through to the catalog so the user
        // still learns a newer build exists.
      }

      const candidate = bestCandidate(context.catalog, {
        kind,
        assetId: MOBILE_ASSET_ID,
        executor,
        currentVersion: appVersion,
        channel: context.channel,
        appVersion,
      })
      if (!candidate) return []
      return [{ ...candidate, source: "catalog", externalUrl: candidate.externalUrl ?? storeUrl() }]
    },

    async apply(
      candidate: UpdateCandidate,
      context: UpdateApplyContext
    ): Promise<UpdateApplyResult> {
      if (kind === "mobile-android" && deps.playCore) {
        const blocking =
          context.consented &&
          (candidate.criticality === "critical" || candidate.compatibility?.breaking === true)
        const result = blocking
          ? await deps.playCore.performImmediateUpdate()
          : await deps.playCore.startFlexibleUpdate()
        if (result === "started") return { state: "awaiting-store", externalUrl: storeUrl() }
        if (result === "cancelled") return { state: "cancelled" }
        if (result === "failed") {
          return {
            state: "failed",
            failure: { kind: "store", code: "play_flow_failed", recoveryActionKey: "openStore" },
          }
        }
        // `unsupported` means the native module is not in this build. Open the
        // store page rather than silently reporting nothing happened.
      }

      const url = candidate.externalUrl ?? storeUrl()
      if (kind === "mobile-android" && deps.playCore) {
        const opened = await deps.playCore.openAppStore()
        if (opened) return { state: "awaiting-store", externalUrl: url }
      }
      const open = deps.openExternal ?? (await import("@/lib/tauri/opener")).openExternal
      await open(url)
      return { state: "awaiting-store", externalUrl: url }
    },
  }

  return adapter
}

/**
 * Resume an interrupted Play download. Wired to the app's resume event so a
 * download that finished while the app was backgrounded is not stranded.
 */
export async function resumePlayUpdateOnResume(deps: MobileAdapterDeps): Promise<boolean> {
  if (!deps.playCore) return false
  const info = await deps.playCore.getAppUpdateInfo()
  if (info.kind !== "ok" || info.value.availability !== "in-progress") return false
  return deps.playCore.completeFlexibleUpdate()
}
