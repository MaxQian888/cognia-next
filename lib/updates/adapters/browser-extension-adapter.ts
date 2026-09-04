"use client"

/**
 * Chrome and Edge extension updates.
 *
 * The browser owns this completely. Cognia adds no custom `update_url` and
 * downloads no CRX, because a self-hosted extension update channel is exactly
 * the sideloading path both stores treat as an abuse signal. What the Update
 * Center does is narrower and honest:
 *
 *  - When the extension is paired with this app, show the version it reported
 *    and, if the browser signalled an available update, offer a reload.
 *  - When it is not paired, show the store's published version and a connect
 *    hint, never a version claim about a browser we cannot see into.
 */

import type { UpdateAssetKind, UpdateCandidate } from "@cognia/agent-config-types"

import type {
  UpdateAdapter,
  UpdateApplyContext,
  UpdateApplyResult,
  UpdateCheckContext,
} from "../adapter"
import { bestCandidate, isNewerVersion } from "../catalog-lookup"

export const BROWSER_EXTENSION_ASSET_ID = "companion-extension"

export interface PairedExtension {
  /** Version the paired extension reported over the companion channel. */
  version: string
  /**
   * Set when the browser fired its own update-available signal. Only then may
   * we offer a reload, because reloading otherwise just restarts the same
   * build and looks like a no-op.
   */
  updatePending?: boolean
}

export interface BrowserExtensionAdapterDeps {
  /** The paired extension for this browser, or null when nothing is paired. */
  pairedExtension?: () => Promise<PairedExtension | null>
  /** Ask the paired extension to reload itself. Resolves true when accepted. */
  requestReload?: () => Promise<boolean>
  openExternal?: (url: string) => Promise<void>
  storeUrls?: { chrome?: string; edge?: string }
  isSupported?: () => boolean
}

const DEFAULT_STORE_URLS = {
  chrome: "https://chromewebstore.google.com/detail/cognia-companion",
  edge: "https://microsoftedge.microsoft.com/addons/detail/cognia-companion",
}

export function createBrowserExtensionAdapter(
  kind: "browser-chrome" | "browser-edge",
  deps: BrowserExtensionAdapterDeps = {}
): UpdateAdapter {
  const storeUrl = () =>
    kind === "browser-chrome"
      ? (deps.storeUrls?.chrome ?? DEFAULT_STORE_URLS.chrome)
      : (deps.storeUrls?.edge ?? DEFAULT_STORE_URLS.edge)

  return {
    kind: kind as UpdateAssetKind,
    executor: "browser-store",
    isSupported: () => deps.isSupported?.() ?? Boolean(deps.pairedExtension),

    async check(context: UpdateCheckContext): Promise<UpdateCandidate[]> {
      const paired = (await deps.pairedExtension?.()) ?? null
      const published = bestCandidate(context.catalog, {
        kind,
        assetId: BROWSER_EXTENSION_ASSET_ID,
        executor: "browser-store",
        currentVersion: paired?.version ?? null,
        channel: context.channel,
      })

      // Not paired: report the store's state, with no local version claim.
      if (!paired) {
        if (!published) return []
        return [
          { ...published, currentVersion: null, externalUrl: published.externalUrl ?? storeUrl() },
        ]
      }

      if (published && isNewerVersion(published.targetVersion, paired.version)) {
        return [
          {
            ...published,
            currentVersion: paired.version,
            // A reload only helps once the browser has fetched the new build.
            action: paired.updatePending ? "reload-extension" : "open-store",
            externalUrl: published.externalUrl ?? storeUrl(),
          },
        ]
      }

      if (paired.updatePending) {
        return [
          {
            assetId: BROWSER_EXTENSION_ASSET_ID,
            kind,
            executor: "browser-store",
            currentVersion: paired.version,
            targetVersion: published?.targetVersion ?? paired.version,
            channel: context.channel,
            criticality: "routine",
            source: "store",
            provenance: "verified",
            action: "reload-extension",
            externalUrl: storeUrl(),
          },
        ]
      }
      return []
    },

    async apply(
      candidate: UpdateCandidate,
      _context: UpdateApplyContext
    ): Promise<UpdateApplyResult> {
      if (candidate.action === "reload-extension" && deps.requestReload) {
        const accepted = await deps.requestReload()
        if (accepted) return { state: "awaiting-reload" }
        return {
          state: "failed",
          failure: { kind: "store", code: "reload_refused", recoveryActionKey: "openStore" },
        }
      }
      const url = candidate.externalUrl ?? storeUrl()
      const open = deps.openExternal ?? (await import("@/lib/tauri/opener")).openExternal
      await open(url)
      return { state: "awaiting-store", externalUrl: url }
    },
  }
}
