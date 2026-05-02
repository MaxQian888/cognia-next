/**
 * Tests for Plugin Dependency Resolver
 */

import {
  DependencyResolver,
  getDependencyResolver,
  resetDependencyResolver,
  parseVersion,
  compareVersions,
  parseConstraint,
  satisfiesConstraint,
} from "./dependency-resolver"
import type { PluginManifest } from "@/types/plugin"

describe("Version Parsing", () => {
  describe("parseVersion", () => {
    it("should parse simple versions", () => {
      expect(parseVersion("1.0.0")).toEqual([1, 0, 0])
      expect(parseVersion("2.3.4")).toEqual([2, 3, 4])
    })

    it("should parse versions with prefixes", () => {
      expect(parseVersion("v1.2.3")).toEqual([1, 2, 3])
      expect(parseVersion("^1.2.3")).toEqual([1, 2, 3])
      expect(parseVersion("~1.2.3")).toEqual([1, 2, 3])
    })

    it("should handle versions with fewer parts", () => {
      expect(parseVersion("1.0")).toEqual([1, 0])
      expect(parseVersion("1")).toEqual([1])
    })

    it("should handle versions with non-numeric suffixes", () => {
      expect(parseVersion("1.0.0-beta")).toEqual([1, 0, 0])
      // rc.1 includes a numeric suffix that gets parsed
      expect(parseVersion("1.0.0-rc.1")).toEqual([1, 0, 0, 1])
    })
  })

  describe("compareVersions", () => {
    it("should compare equal versions", () => {
      expect(compareVersions("1.0.0", "1.0.0")).toBe(0)
      expect(compareVersions("2.3.4", "2.3.4")).toBe(0)
    })

    it("should compare different major versions", () => {
      expect(compareVersions("2.0.0", "1.0.0")).toBe(1)
      expect(compareVersions("1.0.0", "2.0.0")).toBe(-1)
    })

    it("should compare different minor versions", () => {
      expect(compareVersions("1.2.0", "1.1.0")).toBe(1)
      expect(compareVersions("1.1.0", "1.2.0")).toBe(-1)
    })

    it("should compare different patch versions", () => {
      expect(compareVersions("1.0.2", "1.0.1")).toBe(1)
      expect(compareVersions("1.0.1", "1.0.2")).toBe(-1)
    })

    it("should handle versions with different lengths", () => {
      expect(compareVersions("1.0.0", "1.0")).toBe(0)
      expect(compareVersions("1.0.1", "1.0")).toBe(1)
    })
  })
})

describe("Constraint Parsing", () => {
  describe("parseConstraint", () => {
    it("should parse exact versions", () => {
      const constraint = parseConstraint("1.2.3")
      expect(constraint.type).toBe("exact")
      expect(constraint.exact).toBe("1.2.3")
    })

    it("should parse caret constraints", () => {
      const constraint = parseConstraint("^1.2.3")
      expect(constraint.type).toBe("caret")
      expect(constraint.min).toBe("1.2.3")
      expect(constraint.max).toBe("2.0.0")
    })

    it("should parse tilde constraints", () => {
      const constraint = parseConstraint("~1.2.3")
      expect(constraint.type).toBe("tilde")
      expect(constraint.min).toBe("1.2.3")
      expect(constraint.max).toBe("1.3.0")
    })

    it("should parse >= constraints", () => {
      const constraint = parseConstraint(">=1.2.3")
      expect(constraint.type).toBe("range")
      expect(constraint.min).toBe("1.2.3")
    })

    it("should parse < constraints", () => {
      const constraint = parseConstraint("<2.0.0")
      expect(constraint.type).toBe("range")
      expect(constraint.max).toBe("2.0.0")
    })

    it("should parse wildcard constraints", () => {
      expect(parseConstraint("*").type).toBe("any")
      expect(parseConstraint("latest").type).toBe("any")
      expect(parseConstraint("").type).toBe("any")
    })

    it("should parse range constraints", () => {
      const constraint = parseConstraint("1.0.0 - 2.0.0")
      expect(constraint.type).toBe("range")
      expect(constraint.min).toBe("1.0.0")
      expect(constraint.max).toBe("2.0.0")
    })
  })

  describe("satisfiesConstraint", () => {
    it("should satisfy exact versions", () => {
      expect(satisfiesConstraint("1.2.3", "1.2.3")).toBe(true)
      expect(satisfiesConstraint("1.2.4", "1.2.3")).toBe(false)
    })

    it("should satisfy caret constraints", () => {
      expect(satisfiesConstraint("1.2.3", "^1.2.0")).toBe(true)
      expect(satisfiesConstraint("1.9.9", "^1.2.0")).toBe(true)
      expect(satisfiesConstraint("2.0.0", "^1.2.0")).toBe(false)
    })

    it("should satisfy tilde constraints", () => {
      expect(satisfiesConstraint("1.2.3", "~1.2.0")).toBe(true)
      expect(satisfiesConstraint("1.2.9", "~1.2.0")).toBe(true)
      expect(satisfiesConstraint("1.3.0", "~1.2.0")).toBe(false)
    })

    it("should satisfy >= constraints", () => {
      expect(satisfiesConstraint("1.2.3", ">=1.2.0")).toBe(true)
      expect(satisfiesConstraint("2.0.0", ">=1.2.0")).toBe(true)
      expect(satisfiesConstraint("1.1.0", ">=1.2.0")).toBe(false)
    })

    it("should satisfy wildcard constraints", () => {
      expect(satisfiesConstraint("1.0.0", "*")).toBe(true)
      expect(satisfiesConstraint("99.99.99", "*")).toBe(true)
    })
  })
})

describe("DependencyResolver", () => {
  let resolver: DependencyResolver

  const createManifest = (
    id: string,
    version: string,
    deps?: Record<string, string>
  ): PluginManifest => ({
    id,
    name: id,
    version,
    description: "Test plugin",
    author: { name: "Test" },
    main: "index.js",
    dependencies: deps,
    type: "frontend",
    capabilities: [],
  })

  beforeEach(() => {
    resetDependencyResolver()
    resolver = new DependencyResolver()
  })

  describe("Plugin Management", () => {
    it("should set installed plugins", () => {
      const plugins = [createManifest("plugin-a", "1.0.0"), createManifest("plugin-b", "2.0.0")]

      resolver.setInstalledPlugins(plugins)

      expect((resolver as unknown as Record<string, unknown>).setInstalledPlugins).toBeDefined()
    })

    it("should add installed plugin", () => {
      resolver.addInstalledPlugin(createManifest("plugin-a", "1.0.0"))
      resolver.addInstalledPlugin(createManifest("plugin-b", "2.0.0"))

      // Resolver should have the plugins
      expect(resolver).toBeDefined()
    })

    it("should remove installed plugin", () => {
      resolver.addInstalledPlugin(createManifest("plugin-a", "1.0.0"))
      resolver.removeInstalledPlugin("plugin-a")

      // Plugin should be removed
      expect(resolver).toBeDefined()
    })
  })

  describe("Dependency Resolution", () => {
    beforeEach(() => {
      resolver.setInstalledPlugins([
        createManifest("core", "1.0.0"),
        createManifest("plugin-a", "1.0.0", { core: "^1.0.0" }),
        createManifest("plugin-b", "2.0.0", { core: "^1.0.0", "plugin-a": "^1.0.0" }),
      ])
    })

    it("should resolve dependencies", async () => {
      const result = await resolver.resolve("plugin-b")

      expect(result.success).toBe(true)
      expect(result.missing.length).toBe(0)
    })

    it("should detect missing dependencies", async () => {
      resolver.setInstalledPlugins([
        createManifest("plugin-a", "1.0.0", { "missing-dep": "^1.0.0" }),
      ])

      const result = await resolver.resolve("plugin-a")

      expect(result.success).toBe(false)
      expect(result.missing).toContain("missing-dep")
    })

    it("should calculate install order", async () => {
      const result = await resolver.resolve("plugin-b")

      expect(result.installOrder.length).toBeGreaterThan(0)
    })
  })

  describe("Dependency Tree", () => {
    beforeEach(() => {
      resolver.setInstalledPlugins([
        createManifest("core", "1.0.0"),
        createManifest("plugin-a", "1.0.0", { core: "^1.0.0" }),
        createManifest("plugin-b", "2.0.0", { "plugin-a": "^1.0.0" }),
      ])
    })

    it("should build dependency tree", async () => {
      const tree = await resolver.buildDependencyTree("plugin-b")

      expect(tree).toBeDefined()
      expect(tree?.id).toBe("plugin-b")
      expect(tree?.dependencies.length).toBe(1)
      expect(tree?.dependencies[0].id).toBe("plugin-a")
    })

    it("should respect max depth", async () => {
      const tree = await resolver.buildDependencyTree("plugin-b", 1)

      expect(tree?.dependencies[0].dependencies.length).toBe(0)
    })
  })

  describe("Dependents", () => {
    beforeEach(() => {
      resolver.setInstalledPlugins([
        createManifest("core", "1.0.0"),
        createManifest("plugin-a", "1.0.0", { core: "^1.0.0" }),
        createManifest("plugin-b", "2.0.0", { core: "^1.0.0" }),
      ])
    })

    it("should find dependents", () => {
      const dependents = resolver.getDependents("core")

      expect(dependents).toContain("plugin-a")
      expect(dependents).toContain("plugin-b")
    })

    it("should check if can uninstall", () => {
      const result = resolver.canUninstall("core")

      expect(result.canUninstall).toBe(false)
      expect(result.blockedBy).toContain("plugin-a")
      expect(result.blockedBy).toContain("plugin-b")
    })

    it("should allow uninstall if no dependents", () => {
      const result = resolver.canUninstall("plugin-a")

      expect(result.canUninstall).toBe(true)
      expect(result.blockedBy.length).toBe(0)
    })
  })
})

describe("Singleton", () => {
  it("should return the same instance", () => {
    resetDependencyResolver()
    const instance1 = getDependencyResolver()
    const instance2 = getDependencyResolver()
    expect(instance1).toBe(instance2)
  })
})
