/**
 * Plugin Dependency Resolver
 *
 * Resolves plugin dependencies with version constraint support.
 */

import type { PluginManifest } from "@/types/plugin"

// =============================================================================
// Types
// =============================================================================

export interface Dependency {
  id: string
  versionConstraint: string
  optional: boolean
}

export interface ResolvedDependency {
  id: string
  version: string
  constraint: string
  satisfies: boolean
  source: "installed" | "marketplace" | "missing"
}

export interface DependencyNode {
  id: string
  version: string
  dependencies: DependencyNode[]
  depth: number
}

export interface ResolutionResult {
  success: boolean
  resolved: ResolvedDependency[]
  missing: string[]
  conflicts: DependencyConflict[]
  installOrder: string[]
  warnings: string[]
}

export interface DependencyConflict {
  dependencyId: string
  requiredBy: Array<{ pluginId: string; constraint: string }>
  reason: string
}

export interface VersionConstraint {
  type: "exact" | "range" | "caret" | "tilde" | "any"
  min?: string
  max?: string
  exact?: string
}

type PluginProvider = (id: string) => Promise<PluginManifest | null>
type VersionProvider = (id: string) => Promise<string[]>

// =============================================================================
// Version Parsing
// =============================================================================

export function parseVersion(version: string): number[] {
  return version
    .replace(/^[v^~>=<]*/g, "")
    .split(".")
    .map((p) => parseInt(p.replace(/[^0-9]/g, "")) || 0)
}

export function compareVersions(a: string, b: string): number {
  const aParts = parseVersion(a)
  const bParts = parseVersion(b)

  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const aVal = aParts[i] || 0
    const bVal = bParts[i] || 0
    if (aVal > bVal) return 1
    if (aVal < bVal) return -1
  }

  return 0
}

export function parseConstraint(constraint: string): VersionConstraint {
  constraint = constraint.trim()

  if (constraint === "*" || constraint === "" || constraint === "latest") {
    return { type: "any" }
  }

  if (constraint.startsWith("^")) {
    const version = constraint.slice(1)
    const parts = parseVersion(version)
    const major = parts[0] || 0
    return {
      type: "caret",
      min: version,
      max: `${major + 1}.0.0`,
    }
  }

  if (constraint.startsWith("~")) {
    const version = constraint.slice(1)
    const parts = parseVersion(version)
    const major = parts[0] || 0
    const minor = parts[1] || 0
    return {
      type: "tilde",
      min: version,
      max: `${major}.${minor + 1}.0`,
    }
  }

  if (constraint.startsWith(">=")) {
    return {
      type: "range",
      min: constraint.slice(2).trim(),
    }
  }

  if (constraint.startsWith(">")) {
    const version = constraint.slice(1).trim()
    const parts = parseVersion(version)
    parts[2] = (parts[2] || 0) + 1
    return {
      type: "range",
      min: parts.join("."),
    }
  }

  if (constraint.startsWith("<=")) {
    return {
      type: "range",
      max: constraint.slice(2).trim(),
    }
  }

  if (constraint.startsWith("<")) {
    return {
      type: "range",
      max: constraint.slice(1).trim(),
    }
  }

  if (constraint.includes(" - ")) {
    const [min, max] = constraint.split(" - ").map((s) => s.trim())
    return { type: "range", min, max }
  }

  return { type: "exact", exact: constraint }
}

export function satisfiesConstraint(version: string, constraint: string): boolean {
  const parsed = parseConstraint(constraint)

  switch (parsed.type) {
    case "any":
      return true

    case "exact":
      return compareVersions(version, parsed.exact!) === 0

    case "caret":
    case "tilde":
    case "range": {
      if (parsed.min && compareVersions(version, parsed.min) < 0) {
        return false
      }
      if (parsed.max && compareVersions(version, parsed.max) >= 0) {
        return false
      }
      return true
    }

    default:
      return false
  }
}

// =============================================================================
// Dependency Resolver
// =============================================================================

export class DependencyResolver {
  private installedPlugins: Map<string, PluginManifest> = new Map()
  private pluginProvider: PluginProvider | null = null
  private versionProvider: VersionProvider | null = null
  private resolutionCache: Map<string, ResolutionResult> = new Map()

  constructor() {}

  // ===========================================================================
  // Configuration
  // ===========================================================================

  setInstalledPlugins(plugins: PluginManifest[]): void {
    this.installedPlugins.clear()
    for (const plugin of plugins) {
      this.installedPlugins.set(plugin.id, plugin)
    }
    this.resolutionCache.clear()
  }

  addInstalledPlugin(plugin: PluginManifest): void {
    this.installedPlugins.set(plugin.id, plugin)
    this.resolutionCache.clear()
  }

  removeInstalledPlugin(pluginId: string): void {
    this.installedPlugins.delete(pluginId)
    this.resolutionCache.clear()
  }

  setPluginProvider(provider: PluginProvider): void {
    this.pluginProvider = provider
  }

  setVersionProvider(provider: VersionProvider): void {
    this.versionProvider = provider
  }

  // ===========================================================================
  // Resolution
  // ===========================================================================

  async resolve(pluginId: string, targetVersion?: string): Promise<ResolutionResult> {
    const cacheKey = `${pluginId}@${targetVersion || "latest"}`
    const cached = this.resolutionCache.get(cacheKey)
    if (cached) return cached

    const result: ResolutionResult = {
      success: true,
      resolved: [],
      missing: [],
      conflicts: [],
      installOrder: [],
      warnings: [],
    }

    const visited = new Set<string>()
    const visiting = new Set<string>()

    await this.resolveRecursive(pluginId, targetVersion, result, visited, visiting, [])

    // Calculate install order (topological sort)
    result.installOrder = this.calculateInstallOrder(result.resolved)

    // Determine success
    result.success = result.missing.length === 0 && result.conflicts.length === 0

    this.resolutionCache.set(cacheKey, result)
    return result
  }

  private async resolveRecursive(
    pluginId: string,
    versionConstraint: string | undefined,
    result: ResolutionResult,
    visited: Set<string>,
    visiting: Set<string>,
    path: string[]
  ): Promise<void> {
    if (visited.has(pluginId)) return

    // Circular dependency detection
    if (visiting.has(pluginId)) {
      result.warnings.push(`Circular dependency detected: ${[...path, pluginId].join(" -> ")}`)
      return
    }

    visiting.add(pluginId)
    path.push(pluginId)

    // Check if installed
    const installed = this.installedPlugins.get(pluginId)

    if (installed) {
      const satisfies =
        !versionConstraint || satisfiesConstraint(installed.version, versionConstraint)

      result.resolved.push({
        id: pluginId,
        version: installed.version,
        constraint: versionConstraint || "*",
        satisfies,
        source: "installed",
      })

      if (!satisfies) {
        result.conflicts.push({
          dependencyId: pluginId,
          requiredBy: [
            { pluginId: path[path.length - 2] || "root", constraint: versionConstraint || "*" },
          ],
          reason: `Installed version ${installed.version} does not satisfy ${versionConstraint}`,
        })
      }

      // Resolve transitive dependencies
      if (installed.dependencies) {
        for (const [depId, depConstraint] of Object.entries(installed.dependencies)) {
          await this.resolveRecursive(depId, depConstraint, result, visited, visiting, [...path])
        }
      }
    } else {
      // Try to find in marketplace
      if (this.pluginProvider) {
        const marketplacePlugin = await this.pluginProvider(pluginId)

        if (marketplacePlugin) {
          const satisfies =
            !versionConstraint || satisfiesConstraint(marketplacePlugin.version, versionConstraint)

          result.resolved.push({
            id: pluginId,
            version: marketplacePlugin.version,
            constraint: versionConstraint || "*",
            satisfies,
            source: "marketplace",
          })

          if (!satisfies && this.versionProvider) {
            // Try to find a satisfying version
            const versions = await this.versionProvider(pluginId)
            const satisfyingVersion = versions.find((v) =>
              satisfiesConstraint(v, versionConstraint!)
            )

            if (satisfyingVersion) {
              result.resolved[result.resolved.length - 1].version = satisfyingVersion
              result.resolved[result.resolved.length - 1].satisfies = true
            }
          }

          // Resolve transitive dependencies
          if (marketplacePlugin.dependencies) {
            for (const [depId, depConstraint] of Object.entries(marketplacePlugin.dependencies)) {
              await this.resolveRecursive(depId, depConstraint, result, visited, visiting, [
                ...path,
              ])
            }
          }
        } else {
          result.missing.push(pluginId)
          result.resolved.push({
            id: pluginId,
            version: "",
            constraint: versionConstraint || "*",
            satisfies: false,
            source: "missing",
          })
        }
      } else {
        result.missing.push(pluginId)
        result.resolved.push({
          id: pluginId,
          version: "",
          constraint: versionConstraint || "*",
          satisfies: false,
          source: "missing",
        })
      }
    }

    visiting.delete(pluginId)
    visited.add(pluginId)
  }

  private calculateInstallOrder(resolved: ResolvedDependency[]): string[] {
    const order: string[] = []
    const inDegree = new Map<string, number>()
    const graph = new Map<string, string[]>()

    // Initialize
    for (const dep of resolved) {
      if (!inDegree.has(dep.id)) {
        inDegree.set(dep.id, 0)
        graph.set(dep.id, [])
      }
    }

    // Build graph based on installed plugins' dependencies
    for (const dep of resolved) {
      const plugin = this.installedPlugins.get(dep.id)
      if (plugin?.dependencies) {
        for (const depId of Object.keys(plugin.dependencies)) {
          if (inDegree.has(depId)) {
            graph.get(depId)!.push(dep.id)
            inDegree.set(dep.id, (inDegree.get(dep.id) || 0) + 1)
          }
        }
      }
    }

    // Topological sort
    const queue = Array.from(inDegree.entries())
      .filter(([_, degree]) => degree === 0)
      .map(([id]) => id)

    while (queue.length > 0) {
      const current = queue.shift()!
      order.push(current)

      for (const dependent of graph.get(current) || []) {
        const newDegree = (inDegree.get(dependent) || 0) - 1
        inDegree.set(dependent, newDegree)
        if (newDegree === 0) {
          queue.push(dependent)
        }
      }
    }

    return order
  }

  // ===========================================================================
  // Dependency Tree
  // ===========================================================================

  async buildDependencyTree(pluginId: string, maxDepth = 10): Promise<DependencyNode | null> {
    const plugin = this.installedPlugins.get(pluginId)
    if (!plugin) return null

    return this.buildNodeRecursive(plugin, 0, maxDepth, new Set())
  }

  private async buildNodeRecursive(
    plugin: PluginManifest,
    depth: number,
    maxDepth: number,
    visited: Set<string>
  ): Promise<DependencyNode> {
    const node: DependencyNode = {
      id: plugin.id,
      version: plugin.version,
      dependencies: [],
      depth,
    }

    if (depth >= maxDepth || visited.has(plugin.id)) {
      return node
    }

    visited.add(plugin.id)

    if (plugin.dependencies) {
      for (const depId of Object.keys(plugin.dependencies)) {
        const depPlugin = this.installedPlugins.get(depId)
        if (depPlugin) {
          const childNode = await this.buildNodeRecursive(depPlugin, depth + 1, maxDepth, visited)
          node.dependencies.push(childNode)
        }
      }
    }

    return node
  }

  // ===========================================================================
  // Utilities
  // ===========================================================================

  getDependents(pluginId: string): string[] {
    const dependents: string[] = []

    for (const [id, plugin] of this.installedPlugins.entries()) {
      if (plugin.dependencies && pluginId in plugin.dependencies) {
        dependents.push(id)
      }
    }

    return dependents
  }

  canUninstall(pluginId: string): { canUninstall: boolean; blockedBy: string[] } {
    const dependents = this.getDependents(pluginId)
    return {
      canUninstall: dependents.length === 0,
      blockedBy: dependents,
    }
  }

  clearCache(): void {
    this.resolutionCache.clear()
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let resolverInstance: DependencyResolver | null = null

export function getDependencyResolver(): DependencyResolver {
  if (!resolverInstance) {
    resolverInstance = new DependencyResolver()
  }
  return resolverInstance
}

export function resetDependencyResolver(): void {
  resolverInstance = null
}
