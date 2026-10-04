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
  /** Silent device capability check; absent only in injected/test adapters. */
  playAvailable?: () => Promise<boolean>
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

const PLAY_STORE_URL = "https://play.google.com/store/apps/details?id=com.cognia.mobile"

export function createMobileAdapter(
  kind: "mobile-ios" | "mobile-android",
  deps: MobileAdapterDeps = {}
) {
  const os = () => deps.osFamily?.() ?? detectOsFamily()
  const native = () => deps.isNativeMobile?.() ?? isNativeMobile()
  const appVersion = deps.appVersion ?? APP_VERSION
  const executor: UpdateExecutor = kind === "mobile-ios" ? "app-store" : "google-play"
  const storeUrl = () => (kind === "mobile-ios" ? deps.storeUrls?.ios : deps.storeUrls?.android)

  const adapter: UpdateAdapter = {
    kind: kind as UpdateAssetKind,
    executor,
    isSupported: () => native() && os() === (kind === "mobile-ios" ? "ios" : "android"),

    async check(context: UpdateCheckContext): Promise<UpdateCandidate[]> {
      // Play is authoritative about what the device can actually install.
      // The catalog only supplies criticality and notes on top of it.
      if (kind === "mobile-android" && deps.playCore && ((await deps.playAvailable?.()) ?? true)) {
        const info = await deps.playCore.getAppUpdateInfo()
        if (
          info.kind === "ok" &&
          (info.value.availability === "available" || info.value.downloaded)
        ) {
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
              targetVersion:
                info.value.availableVersionName ??
                catalogEntry?.targetVersion ??
                info.value.availableVersionCode ??
                "",
              ...(info.value.downloaded ? { action: "install-in-app" as const } : {}),
              channel: context.channel,
              criticality: catalogEntry?.criticality ?? "routine",
              compatibility: catalogEntry?.compatibility,
              releaseNotes: catalogEntry?.releaseNotes,
              rollout: catalogEntry?.rollout,
              source: "store",
              provenance: "verified",
              externalUrl: PLAY_STORE_URL,
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
      if (context.signal?.aborted) return { state: "cancelled" }
      const usePlay =
        kind === "mobile-android" &&
        candidate.source === "store" &&
        ((await deps.playAvailable?.()) ?? true)
      if (context.signal?.aborted) return { state: "cancelled" }
      if (usePlay && deps.playCore) {
        const info = await deps.playCore.getAppUpdateInfo()
        if (context.signal?.aborted) return { state: "cancelled" }
        if (info.kind === "error") {
          return { state: "failed", failure: { kind: "store", code: "play_info_failed" } }
        }
        if (info.kind === "ok") {
          if (info.value.downloaded) {
            if (!context.consented) return { state: "awaiting-consent" }
            const completed = await deps.playCore.completeFlexibleUpdate()
            return completed
              ? { state: "awaiting-restart", externalUrl: PLAY_STORE_URL }
              : {
                  state: "failed",
                  failure: {
                    kind: "store",
                    code: "play_completion_failed",
                    recoveryActionKey: "openStore",
                  },
                }
          }
          const blocking =
            context.consented &&
            info.value.immediateAllowed &&
            (candidate.criticality === "critical" || candidate.compatibility?.breaking === true)
          const available = info.value.availability === "available"
          const resumeImmediate = info.value.availability === "in-progress" && blocking
          const flow =
            blocking && (available || resumeImmediate)
              ? deps.playCore.performImmediateUpdate
              : available && info.value.flexibleAllowed
                ? deps.playCore.startFlexibleUpdate
                : undefined
          if (flow) {
            const result = await flow()
            if (result === "started")
              return { state: "awaiting-store", externalUrl: PLAY_STORE_URL }
            if (result === "cancelled") return { state: "cancelled" }
            if (result === "failed") {
              return {
                state: "failed",
                failure: {
                  kind: "store",
                  code: "play_flow_failed",
                  recoveryActionKey: "openStore",
                },
              }
            }
          } else if (info.value.availability === "in-progress") {
            return { state: "awaiting-store", externalUrl: PLAY_STORE_URL }
          }
        }
        // `unsupported` means the native module is not in this build. Open the
        // store page rather than silently reporting nothing happened.
      }

      if (context.signal?.aborted) return { state: "cancelled" }
      const url = candidate.externalUrl ?? storeUrl()
      if (!url) {
        return { state: "failed", failure: { kind: "store", code: "store_url_missing" } }
      }
      // Catalog URLs can point to a non-Play distribution for no-GMS builds.
      // Only a candidate discovered through Play may launch its store plugin.
      if (usePlay && deps.playCore) {
        const opened = await deps.playCore.openAppStore()
        if (opened) return { state: "awaiting-store", externalUrl: url }
      }
      const open = deps.openExternal ?? (await import("@/lib/tauri/opener")).openExternal
      if (context.signal?.aborted) return { state: "cancelled" }
      await open(url)
      return { state: "awaiting-store", externalUrl: url }
    },
  }

  return adapter
}
