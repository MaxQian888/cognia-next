/** Manifest link matchers join the ordered registry before any plugin code loads. */
import { lazy } from "react"
import type { ComponentType } from "react"
import type { PluginManifest } from "@/types/plugin/plugin"
import type { LinkMatcherProps } from "@/types/plugin/plugin-link-matcher"
import { loggers } from "@/lib/plugin/core/logger"
import { resolvePluginPath } from "@/lib/plugin/core/plugin-path"
import {
  clearLinkMatchersForPlugin,
  isLinkMatcherComponent,
  registerLinkMatcher,
  validateLinkMatcherDefinition,
} from "@/lib/plugin/api/link-matchers"

export interface LinkMatcherBridgeError {
  pluginId: string
  matcherId: string
  message: string
}

export interface LinkMatcherBridgeResult {
  registered: number
  /** Includes subsequent lazy import failures; the same array is retained. */
  errors: LinkMatcherBridgeError[]
}

export interface LinkMatcherBridgeOptions {
  importer?: (entry: string) => Promise<Record<string, unknown>>
  hasPermission: (permission: string) => boolean
}

const DEFAULT_IMPORTER: NonNullable<LinkMatcherBridgeOptions["importer"]> = (entry) =>
  import(/* @vite-ignore */ /* webpackIgnore: true */ entry)

const manifestDisposers = new Map<string, Array<() => void>>()

function disposeManifestMatchers(pluginId: string): void {
  for (const dispose of manifestDisposers.get(pluginId) ?? []) dispose()
  manifestDisposers.delete(pluginId)
}

export async function registerLinkMatchersForPlugin(
  manifest: PluginManifest,
  installRoot: string,
  options: LinkMatcherBridgeOptions
): Promise<LinkMatcherBridgeResult> {
  const defs = manifest.linkMatchers ?? []
  // activate() may already have registered imperative matchers. Refresh only
  // this bridge's registrations; full plugin teardown clears both kinds below.
  disposeManifestMatchers(manifest.id)
  if (defs.length === 0) return { registered: 0, errors: [] }
  const disposers: Array<() => void> = []
  manifestDisposers.set(manifest.id, disposers)
  const result: LinkMatcherBridgeResult = { registered: 0, errors: [] }
  const importer = options.importer ?? DEFAULT_IMPORTER

  const report = (matcherId: string, error: unknown) => {
    result.errors.push({
      pluginId: manifest.id,
      matcherId,
      message: error instanceof Error ? error.message : String(error),
    })
    loggers.manager.error(
      `[link-matcher-bridge] failed to load ${manifest.id} link matcher "${matcherId}"`,
      error
    )
  }

  for (const def of defs) {
    try {
      if (!options.hasPermission("extension:ui")) {
        throw new Error("Permission denied: extension:ui is required")
      }
      validateLinkMatcherDefinition(def)
      const resolved = resolvePluginPath(installRoot, def.entry)
      if (
        typeof def.export !== "string" ||
        !/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(def.export) ||
        ["__proto__", "constructor", "prototype"].includes(def.export)
      ) {
        throw new Error("Link matcher requires a valid named component export")
      }
      // React owns the import promise. Completion only resolves this component;
      // it never writes to the registry, so disable during load cannot resurrect
      // the contribution. The host supplies Suspense and its inline error boundary.
      const component = lazy(async () => {
        try {
          if (!options.hasPermission("extension:ui")) {
            throw new Error("Permission denied: extension:ui is required")
          }
          const importedModule = await importer(resolved)
          const exported = Object.hasOwn(importedModule, def.export)
            ? importedModule[def.export]
            : undefined
          if (!isLinkMatcherComponent(exported)) {
            throw new Error(
              `entry "${def.entry}" does not export a React component named "${def.export}"`
            )
          }
          return { default: exported as ComponentType<LinkMatcherProps> }
        } catch (error) {
          report(def.id, error)
          throw error
        }
      })
      disposers.push(registerLinkMatcher(manifest.id, { ...def, component }))
      result.registered += 1
    } catch (error) {
      report(def?.id ?? "", error)
    }
  }
  return result
}

export function unregisterLinkMatchersForPlugin(pluginId: string): void {
  disposeManifestMatchers(pluginId)
  clearLinkMatchersForPlugin(pluginId)
}
