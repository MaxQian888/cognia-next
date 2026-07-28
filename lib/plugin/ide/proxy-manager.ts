import { codeServerClient, type CodeServerProxyArtifact } from "@/lib/codeserver/client"
import { resolvePluginPath } from "@/lib/plugin/core/plugin-path"
import { isTauri } from "@/lib/tauri"
import type { Plugin } from "@/types/plugin"

import { IDE_CAPABILITY_CATALOG } from "./catalog"
import { hashIdeManifest } from "./broker-runtime"
import { normalizeIdeManifest } from "./manifest"

/**
 * Build and sign a Pro IDE proxy without changing any live extension host.
 * Transactional plugin updates use this phase before the package commit.
 */
export async function stageManagedIdeProxy(
  plugin: Plugin
): Promise<CodeServerProxyArtifact | null> {
  if (!isTauri() || !plugin.manifest.ide?.targets.includes("pro-ide")) return null
  const normalized = normalizeIdeManifest(plugin.manifest.id, plugin.manifest).manifest
  return codeServerClient.buildProxy({
    pluginId: plugin.manifest.id,
    pluginVersion: plugin.manifest.version,
    pluginRoot: plugin.path,
    manifestHash: await hashIdeManifest(normalized),
    catalogHash: IDE_CAPABILITY_CATALOG.catalogHash,
    contributions: normalized.contributions,
    providers: normalized.providers,
    executables: normalized.executables,
    protocols: normalized.protocols,
    assets: collectProxyAssets(plugin.path, normalized.contributions),
  })
}

/**
 * Build, verify, and promote a proxy for a normal plugin activation. Updates
 * use {@link stageManagedIdeProxy} directly and promote only after the package
 * and state snapshots are ready.
 */
export async function prepareManagedIdeProxy(
  plugin: Plugin
): Promise<CodeServerProxyArtifact | null> {
  const artifact = await stageManagedIdeProxy(plugin)
  if (artifact) await codeServerClient.activateProxy(artifact)
  return artifact
}

export function collectProxyAssets(
  pluginRoot: string,
  contributions: unknown
): Array<{ sourcePath: string; packagePath: string }> {
  const paths = new Set<string>()
  walkContributionAssets(contributions, undefined, false, paths)
  return [...paths].sort().map((packagePath) => ({
    sourcePath: resolvePluginPath(pluginRoot, packagePath),
    packagePath,
  }))
}

function walkContributionAssets(
  value: unknown,
  key: string | undefined,
  insideIcon: boolean,
  paths: Set<string>
): void {
  if (typeof value === "string") {
    if (
      (key === "path" ||
        key === "icon" ||
        key === "fontPath" ||
        key === "entrypoint" ||
        key === "localResourceRoots" ||
        (insideIcon && (key === "light" || key === "dark"))) &&
      safeRelativeAsset(value)
    ) {
      paths.add(value.replaceAll("\\", "/"))
    }
    return
  }
  if (Array.isArray(value)) {
    for (const entry of value) walkContributionAssets(entry, key, insideIcon, paths)
    return
  }
  if (!value || typeof value !== "object") return
  for (const [childKey, child] of Object.entries(value)) {
    walkContributionAssets(child, childKey, insideIcon || childKey === "icon", paths)
  }
}

function safeRelativeAsset(value: string): boolean {
  if (
    !value ||
    value === "." ||
    value.startsWith("$(") ||
    value.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    /^[a-z][a-z0-9+.-]*:/i.test(value)
  ) {
    return false
  }
  return value
    .replaceAll("\\", "/")
    .split("/")
    .every((segment) => segment !== "" && segment !== "..")
}
