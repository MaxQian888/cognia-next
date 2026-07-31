/**
 * Plugin Extension Points API Implementation
 *
 * Provides UI extension point capabilities to plugins.
 */

import type {
  PluginExtensionAPI,
  ExtensionPoint,
  ExtensionOptions,
  ExtensionRegistration,
  ExtensionProps,
} from "@/types/plugin/plugin"
import { nanoid } from "nanoid"
import React from "react"
import { createPluginSystemLogger } from "../core/logger"
import {
  type PluginPointDiagnostic,
  type PluginPointGovernanceMode,
  validateExtensionPoint,
} from "../contracts/plugin-points"
import {
  clearPluginPointDiagnostics,
  recordPluginPointDiagnostic,
} from "../contracts/diagnostics-store"
import { evaluateContextWhen } from "../context-keys/context-key-store"

interface CreateExtensionAPIOptions {
  governanceMode?: PluginPointGovernanceMode
  hasPermission?: (permission: string) => boolean
  onDiagnostic?: (diagnostic: PluginPointDiagnostic) => void
}

// Global extension registry
const extensions = new Map<ExtensionPoint, ExtensionRegistration[]>()
const pluginExtensionIds = new Map<string, Set<string>>()
const extensionDiagnostics = new Map<string, PluginPointDiagnostic[]>()

// Revision counter for reactivity — incremented on every mutation
let extensionRevision = 0
const extensionListeners = new Set<() => void>()

function notifyExtensionChange(): void {
  extensionRevision++
  for (const listener of extensionListeners) {
    listener()
  }
}

/** Subscribe to extension registry changes. Returns unsubscribe function. */
export function subscribeExtensionChanges(listener: () => void): () => void {
  extensionListeners.add(listener)
  return () => {
    extensionListeners.delete(listener)
  }
}

/** Get the current revision number (for useSyncExternalStore snapshot). */
export function getExtensionRevision(): number {
  return extensionRevision
}

/**
 * An extension is visible only when BOTH its imperative `condition()` (if any)
 * and its declarative `when` clause (if any) pass. `condition` failures are
 * swallowed (a throwing predicate hides the item, never the host). `when` is
 * evaluated fail-closed against the live context-key store.
 */
function passesVisibility(ext: ExtensionRegistration): boolean {
  if (ext.options.condition) {
    try {
      if (!ext.options.condition()) return false
    } catch {
      return false
    }
  }
  if (ext.options.when && !evaluateContextWhen(ext.options.when)) return false
  return true
}

/**
 * Width hints arrive as untyped JS from plugin code, so they are sanitised at
 * the single ingest point rather than at the render site: `restorePluginExtensions`
 * replays registrations that already passed through here, and the slot renderer
 * should never have to re-audit a number it did not accept.
 *
 * `NaN`/`Infinity` would serialise into the style attribute as garbage and
 * silently drop the declaration; zero or negative widths are meaningless as a
 * bound and would only make a contribution disappear.
 */
function sanitizeWidthHint(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
}

function recordExtensionDiagnostic(
  pluginId: string,
  diagnostic: PluginPointDiagnostic,
  onDiagnostic?: (diagnostic: PluginPointDiagnostic) => void
): void {
  const list = extensionDiagnostics.get(pluginId) || []
  list.push(diagnostic)
  extensionDiagnostics.set(pluginId, list)
  recordPluginPointDiagnostic(pluginId, diagnostic)
  onDiagnostic?.(diagnostic)
}

/**
 * Create the Extension Points API for a plugin
 */
export function createExtensionAPI(
  pluginId: string,
  options: CreateExtensionAPIOptions = {}
): PluginExtensionAPI {
  const logger = createPluginSystemLogger(pluginId)
  return {
    registerExtension: (
      point: ExtensionPoint,
      component: React.ComponentType<ExtensionProps>,
      extensionOptions: ExtensionOptions = {}
    ) => {
      const validation = validateExtensionPoint(String(point), {
        governanceMode: options.governanceMode || "warn",
        hasPermission: options.hasPermission,
      })

      for (const diagnostic of validation.diagnostics) {
        recordExtensionDiagnostic(pluginId, diagnostic, options.onDiagnostic)
        if (diagnostic.severity === "error") {
          logger.error(`[extension:${diagnostic.code}] ${diagnostic.message}`)
        } else {
          logger.warn(`[extension:${diagnostic.code}] ${diagnostic.message}`)
        }
      }

      if (!validation.allowed || !validation.canonicalId) {
        throw new Error(
          `Extension registration blocked for plugin ${pluginId} at point "${String(point)}"`
        )
      }

      const normalizedPoint = validation.canonicalId as ExtensionPoint
      const extensionId = `${pluginId}:${nanoid()}`

      const minWidth = sanitizeWidthHint(extensionOptions.minWidth)
      const maxWidth = sanitizeWidthHint(extensionOptions.maxWidth)

      const registration: ExtensionRegistration = {
        id: extensionId,
        pluginId,
        point: normalizedPoint,
        component,
        options: {
          priority: extensionOptions.priority || 0,
          labelKey: extensionOptions.labelKey,
          condition: extensionOptions.condition,
          when: extensionOptions.when,
          // An inverted pair is a typo, not an intent. Left as-is, CSS resolves
          // it by letting `min-width` win — handing the plugin the *larger* of
          // the two numbers, which is the one direction the host cannot afford
          // to guess wrong. Collapse toward the ceiling so the smaller declared
          // bound is what survives.
          minWidth:
            minWidth !== undefined && maxWidth !== undefined && minWidth > maxWidth
              ? maxWidth
              : minWidth,
          maxWidth,
        },
      }

      // Add to registry
      if (!extensions.has(normalizedPoint)) {
        extensions.set(normalizedPoint, [])
      }
      extensions.get(normalizedPoint)!.push(registration)

      // Sort by priority
      extensions
        .get(normalizedPoint)!
        .sort((a, b) => (b.options.priority || 0) - (a.options.priority || 0))

      const ownedIds = pluginExtensionIds.get(pluginId) || new Set<string>()
      ownedIds.add(extensionId)
      pluginExtensionIds.set(pluginId, ownedIds)

      logger.info(`Registered extension at ${normalizedPoint}`)
      notifyExtensionChange()

      // Return unregister function
      return () => {
        const pointExtensions = extensions.get(normalizedPoint)
        if (pointExtensions) {
          const index = pointExtensions.findIndex((e) => e.id === extensionId)
          if (index !== -1) {
            pointExtensions.splice(index, 1)
          }
        }
        const pluginIds = pluginExtensionIds.get(pluginId)
        pluginIds?.delete(extensionId)
        if (pluginIds && pluginIds.size === 0) {
          pluginExtensionIds.delete(pluginId)
        }
        logger.info(`Unregistered extension at ${normalizedPoint}`)
        notifyExtensionChange()
      }
    },

    getExtensions: (point: ExtensionPoint): ExtensionRegistration[] => {
      const pointExtensions = extensions.get(point) || []
      return pointExtensions.filter(passesVisibility)
    },

    hasExtensions: (point: ExtensionPoint): boolean => {
      const pointExtensions = extensions.get(point) || []
      return pointExtensions.some(passesVisibility)
    },
  }
}

/**
 * Get all extensions for a point (for use by host components)
 */
export function getExtensionsForPoint(point: ExtensionPoint): ExtensionRegistration[] {
  const pointExtensions = extensions.get(point) || []
  return pointExtensions.filter(passesVisibility)
}

export function getPluginExtensions(pluginId: string): ExtensionRegistration[] {
  const registrations: ExtensionRegistration[] = []

  for (const pointExtensions of extensions.values()) {
    for (const registration of pointExtensions) {
      if (registration.pluginId === pluginId) {
        registrations.push(registration)
      }
    }
  }

  return registrations
}

export function restorePluginExtensions(
  pluginId: string,
  registrations: ExtensionRegistration[]
): void {
  const ownedIds = pluginExtensionIds.get(pluginId) || new Set<string>()

  for (const registration of registrations) {
    const normalizedRegistration: ExtensionRegistration = {
      ...registration,
      pluginId,
    }

    if (!extensions.has(normalizedRegistration.point)) {
      extensions.set(normalizedRegistration.point, [])
    }

    const pointExtensions = extensions.get(normalizedRegistration.point)!
    if (!pointExtensions.some((entry) => entry.id === normalizedRegistration.id)) {
      pointExtensions.push(normalizedRegistration)
      pointExtensions.sort((a, b) => (b.options.priority || 0) - (a.options.priority || 0))
    }

    ownedIds.add(normalizedRegistration.id)
  }

  if (ownedIds.size > 0) {
    pluginExtensionIds.set(pluginId, ownedIds)
  }
  notifyExtensionChange()
}

/**
 * Clear all extensions for a plugin
 */
export function clearPluginExtensions(pluginId: string) {
  for (const [point, pointExtensions] of extensions) {
    const filtered = pointExtensions.filter((ext) => ext.pluginId !== pluginId)
    extensions.set(point, filtered)
  }
  pluginExtensionIds.delete(pluginId)
  extensionDiagnostics.delete(pluginId)
  clearPluginPointDiagnostics(pluginId)
  notifyExtensionChange()
}

export function getPluginExtensionRegistrationCount(pluginId: string): number {
  return pluginExtensionIds.get(pluginId)?.size || 0
}

export function getPluginExtensionDiagnostics(pluginId: string): PluginPointDiagnostic[] {
  return [...(extensionDiagnostics.get(pluginId) || [])]
}

export function clearAllExtensionDiagnostics(): void {
  extensionDiagnostics.clear()
}
