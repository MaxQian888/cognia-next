import { codeServerClient, type CodeServerProxyArtifact } from "@/lib/codeserver/client"
import { recordPluginPointDiagnostic } from "@/lib/plugin/contracts/diagnostics-store"
import { resolvePluginPath } from "@/lib/plugin/core/plugin-path"
import { isTauri } from "@/lib/tauri"
import type { Plugin } from "@/types/plugin"

import { IDE_CAPABILITY_CATALOG } from "./catalog"
import { hashIdeManifest } from "./broker-runtime"
import { isDevModeActive } from "./dev-mode"
import { normalizeIdeManifest } from "./manifest"

/**
 * Whether the host may build a signed proxy for `plugin`.
 *
 * Proxies are signed with the host's own key, so the host only signs code it
 * has a reason to trust: a builtin plugin, or an install it holds a
 * verification receipt for (a signature or checksum it checked, or a
 * `local-dev` receipt for a folder registered during Managed IDE Dev Mode,
 * which the host stops returning once Dev Mode is off).
 */
export async function hasProxyReceipt(plugin: Plugin): Promise<boolean> {
  if (plugin.source === "builtin") return true
  const { invoke } = await import("@tauri-apps/api/core")
  const receipt = await invoke<{ verifiedVia: string } | null>("plugin_read_verification", {
    pluginId: plugin.manifest.id,
  }).catch(() => null)
  return receipt !== null
}

/**
 * Build and sign a Pro IDE proxy without changing any live extension host.
 * Transactional plugin updates use this phase before the package commit.
 * A plugin without a receipt gets none, and its diagnostics say why.
 */
export async function stageManagedIdeProxy(
  plugin: Plugin
): Promise<CodeServerProxyArtifact | null> {
  if (!isTauri() || !plugin.manifest.ide?.targets.includes("pro-ide")) return null
  if (!(await hasProxyReceipt(plugin))) {
    recordPluginPointDiagnostic(plugin.manifest.id, {
      code: "plugin.ide.proxy-receipt-required",
      severity: "warning",
      message: "No Pro IDE proxy: the host holds no verification receipt for this install",
      pointKind: "runtime",
      pointId: "pro-ide.proxy",
      hint: "Install from a signed source, or register its folder in Plugin DevTools → Managed IDE while Dev Mode is on",
    })
    return null
  }
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

/**
 * Managed IDE Dev Mode: rebuild `plugin`'s proxy and activate it live as a
 * temporary build, leaving the committed proxy to come back when Dev Mode
 * ends. Returns null when there is nothing to activate.
 */
export async function activateTemporaryManagedIdeProxy(
  plugin: Plugin
): Promise<CodeServerProxyArtifact | null> {
  if (!isDevModeActive()) throw new Error("MANAGED_IDE_DEV_MODE_OFF")
  const artifact = await stageManagedIdeProxy(plugin)
  if (artifact) await codeServerClient.activateProxyTemporary(artifact)
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
