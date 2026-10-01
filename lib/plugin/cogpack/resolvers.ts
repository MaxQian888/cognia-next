/**
 * Resolve each cogpack member to a manifest the user can review and an install
 * pinned to exactly what the cogpack names (ADR-0209).
 *
 * Every source kind reuses the installer that already exists for it, driven
 * with the pinned revision: the GitHub installer at the commit, the registry
 * at the version, the signed-bundle installer at the bundle hash, Open VSX at
 * the version (its download is checked against the registry's digest), git at
 * the commit, and embedded files through the directory installer. Resolving
 * fetches previews, so nothing is installed until `install` is called.
 */

import { getPlugin } from "@/lib/db/plugins"
import type { WasmCapabilityGrantDecision } from "@/lib/plugin/security/wasm-grant"
import { isTauri } from "@/lib/tauri"
import type { PluginManifest } from "@/types/plugin"
import type { CogpackMember, CogpackProvenance } from "@/types/plugin/plugin-cogset"

/** Why a member cannot be installed on this host. */
export type CogpackUnavailableReason =
  "builtin-missing" | "registry-mismatch" | "preview-failed" | "desktop-only" | "invalid-embedded"

export interface CogpackInstallContext {
  viaCogpack: CogpackProvenance
  /** The WASM capability grant the user approved in the combined review. */
  grantDecision?: WasmCapabilityGrantDecision
}

export interface InstalledByResolver {
  /** A git WASM install whose capabilities could not be reviewed beforehand. */
  grantToReview?: { manifest: PluginManifest; authorFingerprint?: string }
}

export interface MemberResolution {
  /** The manifest the review shows. Absent for git, which cannot be previewed. */
  manifest?: PluginManifest
  unavailable?: { reason: CogpackUnavailableReason; detail?: string }
  /** Install at the pinned revision. Absent when unavailable or nothing to install. */
  install?: (context: CogpackInstallContext) => Promise<InstalledByResolver>
}

function failed(reason: CogpackUnavailableReason, error?: unknown): MemberResolution {
  return {
    unavailable: {
      reason,
      ...(error !== undefined
        ? { detail: error instanceof Error ? error.message : String(error) }
        : {}),
    },
  }
}

/**
 * Two paths a case-insensitive file system (APFS, NTFS) stores as one file.
 * The host refuses such a tree, since `PLUGIN.JSON` would overwrite the
 * `plugin.json` this review reads; refusing here keeps the review honest.
 */
function hasCaseCollision(files: ReadonlyMap<string, Uint8Array>): boolean {
  const seen = new Set<string>()
  for (const path of files.keys()) {
    const key = path.replaceAll("\\", "/").toLowerCase()
    if (seen.has(key)) return true
    seen.add(key)
  }
  return false
}

function parseEmbeddedManifest(files: ReadonlyMap<string, Uint8Array>): PluginManifest | null {
  if (hasCaseCollision(files)) return null
  const bytes = files.get("plugin.json")
  if (!bytes) return null
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as PluginManifest
  } catch {
    return null
  }
}

/** The production resolver. `embedded` is the member's files when it has any. */
export async function resolveCogpackMember(
  member: CogpackMember,
  embedded: ReadonlyMap<string, Uint8Array> | undefined
): Promise<MemberResolution> {
  const source = member.source
  if (source.kind === "builtin") {
    // Nothing to install: the app ships it or it does not.
    const row = await getPlugin(member.id)
    return row ? { manifest: row.manifest as unknown as PluginManifest } : failed("builtin-missing")
  }
  if (!isTauri()) return failed("desktop-only")

  switch (source.kind) {
    case "embedded": {
      const manifest = embedded ? parseEmbeddedManifest(embedded) : null
      // The signed member pins id and version; the plan and the cogset's
      // expectedVersion both read the pin, so the files must match it.
      if (
        !embedded ||
        !manifest ||
        manifest.id !== member.id ||
        manifest.version !== member.version
      )
        return failed("invalid-embedded")
      return {
        manifest,
        install: async ({ viaCogpack }) => {
          const { installEmbeddedPlugin } = await import("./plugin-tree")
          await installEmbeddedPlugin(embedded, {
            pluginId: member.id,
            pluginName: member.name,
            version: member.version,
            viaCogpack,
          })
          return {}
        },
      }
    }
    case "github": {
      try {
        const { fetchGithubPluginPreview } = await import("@/lib/plugin/package/github-source")
        const preview = await fetchGithubPluginPreview({
          owner: source.owner,
          repo: source.repo,
          ref: source.commit,
          subdir: source.subdir,
        })
        return {
          manifest: preview.manifest,
          install: async ({ viaCogpack }) => {
            const { getPluginManager } = await import("@/lib/plugin/core/manager")
            await getPluginManager().installPluginFromGithub(
              `${preview.ref.owner}/${preview.ref.repo}`,
              preview.ref.ref,
              preview.ref.subdir,
              preview.generatedFiles,
              { viaCogpack }
            )
            return {}
          },
        }
      } catch (error) {
        return failed("preview-failed", error)
      }
    }
    case "registry": {
      const { getPluginMarketplace } = await import("@/lib/plugin/package/marketplace")
      const marketplace = getPluginMarketplace()
      if (marketplace.getRegistryUrl() !== source.registryUrl) return failed("registry-mismatch")
      try {
        const entry = await marketplace.getPlugin(member.id)
        if (!entry) return failed("preview-failed")
        return {
          manifest: entry.manifest,
          install: async ({ viaCogpack }) => {
            const result = await marketplace.installPlugin(member.id, source.version, {
              // The review already listed what is missing; nothing is pulled in silently.
              installDependencies: false,
              viaCogpack,
            })
            if (!result.success) throw new Error(result.error ?? "Registry install failed")
            return {}
          },
        }
      } catch (error) {
        return failed("preview-failed", error)
      }
    }
    case "url": {
      const args = {
        bundleUrl: source.bundleUrl,
        signatureUrl: source.signatureUrl,
        expectedPublicKeyBase64: source.publicKey,
        expectedBundleSha256: source.sha256,
      }
      try {
        const { previewBundleManifest } = await import("@/lib/plugin/package/http-installer")
        const preview = await previewBundleManifest(args)
        return {
          manifest: preview.manifest,
          install: async ({ viaCogpack, grantDecision }) => {
            const { getPluginManager } = await import("@/lib/plugin/core/manager")
            await getPluginManager().installWasmPluginFromUrl(args, grantDecision, { viaCogpack })
            return {}
          },
        }
      } catch (error) {
        return failed("preview-failed", error)
      }
    }
    case "openvsx": {
      try {
        const { createOpenVsxInstallClient } =
          await import("@/lib/plugin/vscode-shim/openvsx-install-flow")
        let viaCogpack: CogpackProvenance | undefined
        const client = createOpenVsxInstallClient({
          requestedVersion: source.version,
          get viaCogpack() {
            return viaCogpack
          },
        })
        const entry = await client.getPlugin(member.id)
        if (!entry) return failed("preview-failed")
        return {
          manifest: entry.manifest,
          install: async (context) => {
            viaCogpack = context.viaCogpack
            await client.installPlugin(member.id, source.version)
            return {}
          },
        }
      } catch (error) {
        return failed("preview-failed", error)
      }
    }
    case "git":
      return {
        install: async ({ viaCogpack }) => {
          const { installFromGit } = await import("@/lib/plugin/package/git-installer")
          const result = await installFromGit({
            repoUrl: source.url,
            commit: source.commit,
            viaCogpack,
          })
          return {
            grantToReview: {
              manifest: result.manifest,
              ...(result.authorFingerprint ? { authorFingerprint: result.authorFingerprint } : {}),
            },
          }
        },
      }
  }
}
