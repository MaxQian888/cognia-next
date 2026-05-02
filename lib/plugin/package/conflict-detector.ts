/**
 * Plugin Conflict Detector
 *
 * Detects and reports conflicts between plugins including:
 * - Version conflicts in shared dependencies
 * - API namespace collisions
 * - Resource conflicts
 * - Incompatible capability requirements
 */

import type { PluginManifest, PluginCapability } from "@/types/plugin"
import { satisfiesConstraint } from "./dependency-resolver"

// =============================================================================
// Types
// =============================================================================

export interface PluginConflict {
  type: ConflictType
  severity: ConflictSeverity
  plugins: string[]
  description: string
  resolution?: string
  autoResolvable: boolean
}

export type ConflictType =
  | "version"
  | "namespace"
  | "resource"
  | "capability"
  | "permission"
  | "api"
  | "command"
  | "shortcut"

export type ConflictSeverity = "error" | "warning" | "info"

export interface ConflictDetectionResult {
  hasConflicts: boolean
  errors: PluginConflict[]
  warnings: PluginConflict[]
  info: PluginConflict[]
  canProceed: boolean
  autoResolutions: ConflictResolution[]
}

export interface ConflictResolution {
  conflict: PluginConflict
  action:
    | "skip"
    | "upgrade"
    | "downgrade"
    | "rename"
    | "disable"
    | "rebind"
    | "prefix"
    | "prioritize"
  targetPlugin?: string
  details: string
}

export interface PluginRegistration {
  manifest: PluginManifest
  commands?: string[]
  shortcuts?: string[]
  namespaces?: string[]
  resources?: string[]
}

// =============================================================================
// Conflict Detector
// =============================================================================

export class ConflictDetector {
  private registrations: Map<string, PluginRegistration> = new Map()

  constructor() {}

  // ===========================================================================
  // Registration
  // ===========================================================================

  registerPlugin(registration: PluginRegistration): void {
    this.registrations.set(registration.manifest.id, registration)
  }

  unregisterPlugin(pluginId: string): void {
    this.registrations.delete(pluginId)
  }

  setPlugins(registrations: PluginRegistration[]): void {
    this.registrations.clear()
    for (const reg of registrations) {
      this.registrations.set(reg.manifest.id, reg)
    }
  }

  // ===========================================================================
  // Conflict Detection
  // ===========================================================================

  detectAll(): ConflictDetectionResult {
    const conflicts: PluginConflict[] = []

    // Run all detection checks
    conflicts.push(...this.detectVersionConflicts())
    conflicts.push(...this.detectNamespaceConflicts())
    conflicts.push(...this.detectCommandConflicts())
    conflicts.push(...this.detectShortcutConflicts())
    conflicts.push(...this.detectCapabilityConflicts())
    conflicts.push(...this.detectResourceConflicts())

    // Categorize by severity
    const errors = conflicts.filter((c) => c.severity === "error")
    const warnings = conflicts.filter((c) => c.severity === "warning")
    const info = conflicts.filter((c) => c.severity === "info")

    // Generate auto-resolutions
    const autoResolutions = this.generateAutoResolutions(conflicts)

    return {
      hasConflicts: conflicts.length > 0,
      errors,
      warnings,
      info,
      canProceed: errors.length === 0,
      autoResolutions,
    }
  }

  detectForPlugin(pluginId: string): ConflictDetectionResult {
    const registration = this.registrations.get(pluginId)
    if (!registration) {
      return {
        hasConflicts: false,
        errors: [],
        warnings: [],
        info: [],
        canProceed: true,
        autoResolutions: [],
      }
    }

    const conflicts: PluginConflict[] = []

    // Check against all other plugins
    for (const [otherId, otherReg] of this.registrations.entries()) {
      if (otherId === pluginId) continue

      conflicts.push(...this.detectPairConflicts(registration, otherReg))
    }

    const errors = conflicts.filter((c) => c.severity === "error")
    const warnings = conflicts.filter((c) => c.severity === "warning")
    const info = conflicts.filter((c) => c.severity === "info")

    return {
      hasConflicts: conflicts.length > 0,
      errors,
      warnings,
      info,
      canProceed: errors.length === 0,
      autoResolutions: this.generateAutoResolutions(conflicts),
    }
  }

  // ===========================================================================
  // Version Conflict Detection
  // ===========================================================================

  private detectVersionConflicts(): PluginConflict[] {
    const conflicts: PluginConflict[] = []
    const dependencyRequirements: Map<
      string,
      Array<{ pluginId: string; constraint: string }>
    > = new Map()

    // Collect all dependency requirements
    for (const [pluginId, reg] of this.registrations.entries()) {
      const deps = reg.manifest.dependencies
      if (!deps) continue

      for (const [depId, constraint] of Object.entries(deps)) {
        if (!dependencyRequirements.has(depId)) {
          dependencyRequirements.set(depId, [])
        }
        dependencyRequirements.get(depId)!.push({ pluginId, constraint })
      }
    }

    // Check for conflicting requirements
    for (const [depId, requirements] of dependencyRequirements.entries()) {
      if (requirements.length < 2) continue

      // Check if all constraints can be satisfied by a single version
      const installedDep = this.registrations.get(depId)
      if (!installedDep) continue

      const unsatisfied = requirements.filter(
        (req) => !satisfiesConstraint(installedDep.manifest.version, req.constraint)
      )

      if (unsatisfied.length > 0) {
        conflicts.push({
          type: "version",
          severity: "error",
          plugins: [depId, ...unsatisfied.map((u) => u.pluginId)],
          description: `Version conflict for ${depId}: installed ${installedDep.manifest.version} does not satisfy constraints from ${unsatisfied.map((u) => `${u.pluginId}(${u.constraint})`).join(", ")}`,
          resolution: `Update ${depId} to a version that satisfies all constraints`,
          autoResolvable: true,
        })
      }

      // Check for mutually exclusive constraints
      for (let i = 0; i < requirements.length; i++) {
        for (let j = i + 1; j < requirements.length; j++) {
          if (!this.constraintsCompatible(requirements[i].constraint, requirements[j].constraint)) {
            conflicts.push({
              type: "version",
              severity: "warning",
              plugins: [requirements[i].pluginId, requirements[j].pluginId],
              description: `Potentially incompatible version constraints for ${depId}: ${requirements[i].constraint} vs ${requirements[j].constraint}`,
              autoResolvable: false,
            })
          }
        }
      }
    }

    return conflicts
  }

  private constraintsCompatible(a: string, b: string): boolean {
    // Simple compatibility check - in production would need full semver range intersection
    const aMajor = this.extractMajorFromConstraint(a)
    const bMajor = this.extractMajorFromConstraint(b)

    if (aMajor !== null && bMajor !== null && aMajor !== bMajor) {
      return false
    }

    return true
  }

  private extractMajorFromConstraint(constraint: string): number | null {
    const match = constraint.match(/\d+/)
    return match ? parseInt(match[0]) : null
  }

  // ===========================================================================
  // Namespace Conflict Detection
  // ===========================================================================

  private detectNamespaceConflicts(): PluginConflict[] {
    const conflicts: PluginConflict[] = []
    const namespaceOwners: Map<string, string[]> = new Map()

    for (const [pluginId, reg] of this.registrations.entries()) {
      const namespaces = reg.namespaces || [pluginId]

      for (const ns of namespaces) {
        if (!namespaceOwners.has(ns)) {
          namespaceOwners.set(ns, [])
        }
        namespaceOwners.get(ns)!.push(pluginId)
      }
    }

    for (const [namespace, owners] of namespaceOwners.entries()) {
      if (owners.length > 1) {
        conflicts.push({
          type: "namespace",
          severity: "error",
          plugins: owners,
          description: `Namespace collision: "${namespace}" is claimed by multiple plugins`,
          resolution: "Later plugins will be prefixed with their plugin ID",
          autoResolvable: true,
        })
      }
    }

    return conflicts
  }

  // ===========================================================================
  // Command Conflict Detection
  // ===========================================================================

  private detectCommandConflicts(): PluginConflict[] {
    const conflicts: PluginConflict[] = []
    const commandOwners: Map<string, string[]> = new Map()

    for (const [pluginId, reg] of this.registrations.entries()) {
      const commands = reg.commands || []

      for (const cmd of commands) {
        if (!commandOwners.has(cmd)) {
          commandOwners.set(cmd, [])
        }
        commandOwners.get(cmd)!.push(pluginId)
      }
    }

    for (const [command, owners] of commandOwners.entries()) {
      if (owners.length > 1) {
        conflicts.push({
          type: "command",
          severity: "warning",
          plugins: owners,
          description: `Command collision: "${command}" is registered by multiple plugins`,
          resolution: "The last registered plugin will handle this command",
          autoResolvable: true,
        })
      }
    }

    return conflicts
  }

  // ===========================================================================
  // Shortcut Conflict Detection
  // ===========================================================================

  private detectShortcutConflicts(): PluginConflict[] {
    const conflicts: PluginConflict[] = []
    const shortcutOwners: Map<string, string[]> = new Map()

    for (const [pluginId, reg] of this.registrations.entries()) {
      const shortcuts = reg.shortcuts || []

      for (const shortcut of shortcuts) {
        const normalized = this.normalizeShortcut(shortcut)
        if (!shortcutOwners.has(normalized)) {
          shortcutOwners.set(normalized, [])
        }
        shortcutOwners.get(normalized)!.push(pluginId)
      }
    }

    for (const [shortcut, owners] of shortcutOwners.entries()) {
      if (owners.length > 1) {
        conflicts.push({
          type: "shortcut",
          severity: "warning",
          plugins: owners,
          description: `Shortcut collision: "${shortcut}" is registered by multiple plugins`,
          resolution: "The later-registered plugin shortcut will be rebound",
          autoResolvable: true,
        })
      }
    }

    return conflicts
  }

  private normalizeShortcut(shortcut: string): string {
    return shortcut.toLowerCase().split("+").sort().join("+")
  }

  // ===========================================================================
  // Capability Conflict Detection
  // ===========================================================================

  private detectCapabilityConflicts(): PluginConflict[] {
    const conflicts: PluginConflict[] = []
    const exclusiveCapabilities: PluginCapability[] = ["themes"]

    for (const capability of exclusiveCapabilities) {
      const pluginsWithCapability: string[] = []

      for (const [pluginId, reg] of this.registrations.entries()) {
        if (reg.manifest.capabilities?.includes(capability)) {
          pluginsWithCapability.push(pluginId)
        }
      }

      if (pluginsWithCapability.length > 1) {
        conflicts.push({
          type: "capability",
          severity: "info",
          plugins: pluginsWithCapability,
          description: `Multiple plugins provide "${capability}" capability`,
          resolution: "Only one theme plugin can be active at a time",
          autoResolvable: true,
        })
      }
    }

    return conflicts
  }

  // ===========================================================================
  // Resource Conflict Detection
  // ===========================================================================

  private detectResourceConflicts(): PluginConflict[] {
    const conflicts: PluginConflict[] = []
    const resourceOwners: Map<string, string[]> = new Map()

    for (const [pluginId, reg] of this.registrations.entries()) {
      const resources = reg.resources || []

      for (const resource of resources) {
        if (!resourceOwners.has(resource)) {
          resourceOwners.set(resource, [])
        }
        resourceOwners.get(resource)!.push(pluginId)
      }
    }

    for (const [resource, owners] of resourceOwners.entries()) {
      if (owners.length > 1) {
        conflicts.push({
          type: "resource",
          severity: "warning",
          plugins: owners,
          description: `Resource conflict: "${resource}" is used by multiple plugins`,
          resolution: "The first-registered plugin gets priority for this resource",
          autoResolvable: true,
        })
      }
    }

    return conflicts
  }

  // ===========================================================================
  // Pair Conflict Detection
  // ===========================================================================

  private detectPairConflicts(a: PluginRegistration, b: PluginRegistration): PluginConflict[] {
    const conflicts: PluginConflict[] = []

    // Check command conflicts
    const aCommands = new Set(a.commands || [])
    const bCommands = new Set(b.commands || [])
    for (const cmd of aCommands) {
      if (bCommands.has(cmd)) {
        conflicts.push({
          type: "command",
          severity: "warning",
          plugins: [a.manifest.id, b.manifest.id],
          description: `Command "${cmd}" conflict`,
          autoResolvable: true,
        })
      }
    }

    // Check shortcut conflicts
    const aShortcuts = new Set((a.shortcuts || []).map((s) => this.normalizeShortcut(s)))
    const bShortcuts = new Set((b.shortcuts || []).map((s) => this.normalizeShortcut(s)))
    for (const shortcut of aShortcuts) {
      if (bShortcuts.has(shortcut)) {
        conflicts.push({
          type: "shortcut",
          severity: "warning",
          plugins: [a.manifest.id, b.manifest.id],
          description: `Shortcut "${shortcut}" conflict`,
          resolution: "The later-registered plugin shortcut will be rebound",
          autoResolvable: true,
        })
      }
    }

    return conflicts
  }

  // ===========================================================================
  // Auto-Resolution
  // ===========================================================================

  private generateAutoResolutions(conflicts: PluginConflict[]): ConflictResolution[] {
    const resolutions: ConflictResolution[] = []

    for (const conflict of conflicts) {
      if (!conflict.autoResolvable) continue

      switch (conflict.type) {
        case "command":
          resolutions.push({
            conflict,
            action: "skip",
            details: `Later registered plugin will handle the command`,
          })
          break

        case "capability":
          if (conflict.plugins.length > 1) {
            resolutions.push({
              conflict,
              action: "disable",
              targetPlugin: conflict.plugins.slice(1).join(", "),
              details: `Only the first plugin with this capability will be active`,
            })
          }
          break

        case "shortcut":
          if (conflict.plugins.length > 1) {
            resolutions.push({
              conflict,
              action: "rebind",
              targetPlugin: conflict.plugins[conflict.plugins.length - 1],
              details: `The shortcut for "${conflict.plugins[conflict.plugins.length - 1]}" will be reassigned to avoid collision`,
            })
          }
          break

        case "namespace":
          if (conflict.plugins.length > 1) {
            resolutions.push({
              conflict,
              action: "prefix",
              targetPlugin: conflict.plugins.slice(1).join(", "),
              details: `Later plugins will have their namespace prefixed with their plugin ID to avoid collision`,
            })
          }
          break

        case "version": {
          // Determine if we should upgrade or downgrade the dependency
          const depId = conflict.plugins[0]
          const installedDep = this.registrations.get(depId)
          if (installedDep) {
            // Check which direction resolves more constraints
            const requirers = conflict.plugins.slice(1)
            const highestConstraint = requirers.reduce((max, pId) => {
              const reg = this.registrations.get(pId)
              const constraint = reg?.manifest.dependencies?.[depId]
              if (!constraint) return max
              const major = this.extractMajorFromConstraint(constraint)
              const maxMajor = this.extractMajorFromConstraint(max)
              return major !== null && maxMajor !== null && major > maxMajor ? constraint : max
            }, "0.0.0")

            const installedMajor = this.extractMajorFromConstraint(installedDep.manifest.version)
            const targetMajor = this.extractMajorFromConstraint(highestConstraint)
            const shouldUpgrade =
              targetMajor !== null && installedMajor !== null && targetMajor >= installedMajor

            resolutions.push({
              conflict,
              action: shouldUpgrade ? "upgrade" : "downgrade",
              targetPlugin: depId,
              details: `${shouldUpgrade ? "Upgrade" : "Downgrade"} "${depId}" to satisfy version constraints from dependent plugins`,
            })
          }
          break
        }

        case "resource":
          if (conflict.plugins.length > 1) {
            resolutions.push({
              conflict,
              action: "prioritize",
              targetPlugin: conflict.plugins[0],
              details: `"${conflict.plugins[0]}" gets priority for this resource as the first-registered plugin`,
            })
          }
          break
      }
    }

    return resolutions
  }

  // ===========================================================================
  // Utilities
  // ===========================================================================

  getRegisteredPlugins(): string[] {
    return Array.from(this.registrations.keys())
  }

  getPluginRegistration(pluginId: string): PluginRegistration | undefined {
    return this.registrations.get(pluginId)
  }

  clear(): void {
    this.registrations.clear()
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let conflictDetectorInstance: ConflictDetector | null = null

export function getConflictDetector(): ConflictDetector {
  if (!conflictDetectorInstance) {
    conflictDetectorInstance = new ConflictDetector()
  }
  return conflictDetectorInstance
}

export function resetConflictDetector(): void {
  if (conflictDetectorInstance) {
    conflictDetectorInstance.clear()
    conflictDetectorInstance = null
  }
}
