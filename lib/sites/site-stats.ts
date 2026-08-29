/**
 * The four numbers that explain a Site at a glance.
 *
 * Modelled on `lib/devices/device-stats.ts`: the strip is as many columns as
 * there are answerable stats, never four with a hole, because an empty tile
 * reads as a value that failed to load rather than one that does not apply.
 *
 * Every input is already in the console's live data, so this costs no read.
 */
import { siteArtifactStorage } from "./console-model"
import type {
  SiteDeploymentRow,
  SiteOperationRow,
  SiteResourceRow,
  SiteVersionRow,
} from "@/types/sites"

export interface SiteStat {
  /** i18n key suffix under `sites.stats.*`. */
  key: "versions" | "live" | "running" | "resources" | "storage"
  value: string
  /** Denominator or qualifier, so a shortfall is legible without drilling in. */
  detail?: string
  tone: "positive" | "attention" | "neutral"
}

export interface SiteStatsInput {
  versions: readonly SiteVersionRow[]
  deployments: readonly SiteDeploymentRow[]
  operations: readonly SiteOperationRow[]
  resources: readonly SiteResourceRow[]
}

export function buildSiteStats(input: SiteStatsInput): SiteStat[] {
  const stats: SiteStat[] = []

  const ready = input.versions.filter((version) => version.status === "ready").length
  const failed = input.versions.filter((version) => version.status === "failed").length
  if (input.versions.length > 0) {
    stats.push({
      key: "versions",
      value: `${ready}/${input.versions.length}`,
      ...(failed > 0 ? { detail: String(failed) } : {}),
      tone: failed > 0 ? "attention" : "positive",
    })
  }

  const active = input.deployments.filter((row) => row.status === "active").length
  const failedDeploys = input.deployments.filter((row) => row.status === "failed").length
  if (input.deployments.length > 0) {
    stats.push({
      key: "live",
      value: String(active),
      ...(failedDeploys > 0 ? { detail: String(failedDeploys) } : {}),
      tone: active > 0 ? "positive" : "attention",
    })
  }

  const running = input.operations.filter(
    (operation) => operation.status === "queued" || operation.status === "running"
  ).length
  const stuck = input.operations.filter(
    (operation) => operation.status === "waiting-reconcile"
  ).length
  // Only when there is something to say: a quiet Site should not carry a
  // permanent "0 running" tile.
  if (running > 0 || stuck > 0) {
    stats.push({
      key: "running",
      value: String(running),
      ...(stuck > 0 ? { detail: String(stuck) } : {}),
      tone: stuck > 0 ? "attention" : "neutral",
    })
  }

  const live = input.resources.filter((row) => row.status !== "deleted")
  if (live.length > 0) {
    const managed = live.filter((row) => row.ownership === "managed").length
    stats.push({
      key: "resources",
      value: `${managed}/${live.length}`,
      tone: "neutral",
    })
  }

  const storage = siteArtifactStorage(input.versions)
  if (storage.stored > 0) {
    stats.push({
      key: "storage",
      value: formatBytes(storage.bytes),
      ...(storage.collected > 0 ? { detail: String(storage.collected) } : {}),
      tone: "neutral",
    })
  }

  return stats
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`
}
