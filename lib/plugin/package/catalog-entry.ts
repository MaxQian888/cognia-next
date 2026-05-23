import type {
  ExtensionCatalogEntry,
  ExtensionCompatibilityDiagnostic,
  ExtensionOperation,
  Plugin,
} from "@/types/plugin"
import type { PluginRegistryEntry } from "./marketplace"
import { resolvePluginIcon } from "../utils/icon"

interface BuildExtensionCatalogEntryOptions {
  registryEntry: PluginRegistryEntry
  installedPlugin?: Plugin
}

function buildLifecycleDiagnostics(plugin?: Plugin): ExtensionCompatibilityDiagnostic[] {
  if (!plugin?.verificationSnapshot || !plugin.verificationSnapshot.lastFailureAt) {
    return []
  }

  const snapshot = plugin.verificationSnapshot
  const lastKnownGood = plugin.lastKnownGoodVerification

  if (
    snapshot.lastVerifiedAction === "reload" &&
    Boolean(lastKnownGood?.lastSuccessfulAt) &&
    lastKnownGood?.lastVerifiedAction === "update"
  ) {
    return [
      {
        code: "lifecycle.reload.failed_after_update",
        severity: "warning",
        message:
          "Plugin reload failed after update; runtime may be degraded until rollback or retry.",
        hint: "Retry reload or rollback to the last known good verification snapshot.",
      },
    ]
  }

  return [
    {
      code: `lifecycle.${snapshot.lastVerifiedAction}.failed`,
      severity: "warning",
      message: `Last lifecycle action "${snapshot.lastVerifiedAction}" failed during ${snapshot.verificationStage}.`,
      hint: "Inspect verification diagnostics and fallback to rollback when available.",
    },
  ]
}

function mergeCompatibilitySummary(
  descriptor: Plugin["descriptor"],
  lifecycleDiagnostics: ExtensionCompatibilityDiagnostic[]
): ExtensionCatalogEntry["compatibility"] {
  const diagnostics = [...(descriptor?.compatibility.diagnostics || []), ...lifecycleDiagnostics]

  if (diagnostics.some((entry) => entry.severity === "error")) {
    return { status: "blocked", diagnostics }
  }
  if (diagnostics.length > 0) {
    return { status: "warning", diagnostics }
  }
  return { status: "compatible", diagnostics }
}

function buildCatalogOperations(
  descriptor: Plugin["descriptor"],
  plugin?: Plugin
): ExtensionOperation[] {
  const baseOperations: ExtensionOperation[] = descriptor?.availableOperations
    ? [...descriptor.availableOperations]
    : ["install"]

  const hasFailedSnapshot = Boolean(plugin?.verificationSnapshot?.lastFailureAt)
  const canRollback = Boolean(
    plugin?.lastKnownGoodVerification?.lastSuccessfulAt && hasFailedSnapshot
  )
  if (canRollback && !baseOperations.includes("rollback")) {
    baseOperations.push("rollback")
  }

  return baseOperations
}

export function buildExtensionCatalogEntry({
  registryEntry,
  installedPlugin,
}: BuildExtensionCatalogEntryOptions): ExtensionCatalogEntry {
  const descriptor = installedPlugin?.descriptor
  const lifecycleDiagnostics = buildLifecycleDiagnostics(installedPlugin)
  const compatibility = mergeCompatibilitySummary(descriptor, lifecycleDiagnostics)
  const availableOperations = buildCatalogOperations(descriptor, installedPlugin)

  return {
    id: registryEntry.id,
    name: registryEntry.name,
    description: registryEntry.description,
    author: registryEntry.author,
    capabilities:
      installedPlugin?.descriptor?.declaredCapabilities || registryEntry.manifest.capabilities,
    version: installedPlugin?.manifest.version || registryEntry.version,
    latestVersion: registryEntry.latestVersion,
    updatedAt: registryEntry.updatedAt.toISOString(),
    installed: Boolean(installedPlugin),
    enabled: installedPlugin?.status === "enabled",
    source: registryEntry.source || installedPlugin?.source || "marketplace",
    descriptor: descriptor || registryEntry.descriptor,
    verificationSnapshot: installedPlugin?.verificationSnapshot,
    lastKnownGoodVerification: installedPlugin?.lastKnownGoodVerification,
    repository: registryEntry.repository,
    homepage: registryEntry.homepage,
    license: registryEntry.manifest.license,
    icon: installedPlugin?.manifest.icon || registryEntry.manifest.icon,
    resolvedIcon: resolvePluginIcon({
      icon: installedPlugin?.manifest.icon || registryEntry.manifest.icon,
      pluginRoot: installedPlugin?.path || descriptor?.resolvedPath,
    }),
    compatibility,
    availableOperations,
    registry: {
      verified: registryEntry.verified,
      featured: registryEntry.featured,
      downloads: registryEntry.downloads,
      rating: registryEntry.rating,
      ratingCount: registryEntry.ratingCount,
      tags: [...registryEntry.tags],
      categories: [...registryEntry.categories],
    },
  }
}
