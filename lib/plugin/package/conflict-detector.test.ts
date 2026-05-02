/**
 * Tests for Plugin Conflict Detector
 */

import {
  ConflictDetector,
  getConflictDetector,
  resetConflictDetector,
  type PluginRegistration,
} from "./conflict-detector"
import type { PluginManifest } from "@/types/plugin"

describe("ConflictDetector", () => {
  let detector: ConflictDetector

  const createManifest = (
    id: string,
    version: string,
    options: Partial<PluginManifest> = {}
  ): PluginManifest => ({
    id,
    name: id,
    version,
    description: "Test plugin",
    author: { name: "Test" },
    main: "index.js",
    type: "frontend",
    capabilities: [],
    ...options,
  })

  const createRegistration = (
    manifest: PluginManifest,
    options: Partial<Omit<PluginRegistration, "manifest">> = {}
  ): PluginRegistration => ({
    manifest,
    ...options,
  })

  beforeEach(() => {
    resetConflictDetector()
    detector = new ConflictDetector()
  })

  afterEach(() => {
    detector.clear()
  })

  describe("Plugin Registration", () => {
    it("should register plugins", () => {
      const reg = createRegistration(createManifest("plugin-a", "1.0.0"))
      detector.registerPlugin(reg)

      expect(detector.getRegisteredPlugins()).toContain("plugin-a")
    })

    it("should unregister plugins", () => {
      const reg = createRegistration(createManifest("plugin-a", "1.0.0"))
      detector.registerPlugin(reg)
      detector.unregisterPlugin("plugin-a")

      expect(detector.getRegisteredPlugins()).not.toContain("plugin-a")
    })

    it("should set multiple plugins", () => {
      detector.setPlugins([
        createRegistration(createManifest("plugin-a", "1.0.0")),
        createRegistration(createManifest("plugin-b", "2.0.0")),
      ])

      expect(detector.getRegisteredPlugins()).toContain("plugin-a")
      expect(detector.getRegisteredPlugins()).toContain("plugin-b")
    })
  })

  describe("Command Conflicts", () => {
    it("should detect command conflicts", () => {
      detector.setPlugins([
        createRegistration(createManifest("plugin-a", "1.0.0"), {
          commands: ["open-file", "save-file"],
        }),
        createRegistration(createManifest("plugin-b", "1.0.0"), {
          commands: ["open-file", "close-file"],
        }),
      ])

      const result = detector.detectAll()

      const commandConflicts = result.warnings.filter((c) => c.type === "command")
      expect(commandConflicts.length).toBeGreaterThan(0)
      expect(commandConflicts[0].plugins).toContain("plugin-a")
      expect(commandConflicts[0].plugins).toContain("plugin-b")
    })

    it("should not flag unique commands", () => {
      detector.setPlugins([
        createRegistration(createManifest("plugin-a", "1.0.0"), {
          commands: ["command-a"],
        }),
        createRegistration(createManifest("plugin-b", "1.0.0"), {
          commands: ["command-b"],
        }),
      ])

      const result = detector.detectAll()

      const commandConflicts = result.warnings.filter((c) => c.type === "command")
      expect(commandConflicts.length).toBe(0)
    })
  })

  describe("Shortcut Conflicts", () => {
    it("should detect shortcut conflicts", () => {
      detector.setPlugins([
        createRegistration(createManifest("plugin-a", "1.0.0"), {
          shortcuts: ["Ctrl+S", "Ctrl+O"],
        }),
        createRegistration(createManifest("plugin-b", "1.0.0"), {
          shortcuts: ["Ctrl+S"],
        }),
      ])

      const result = detector.detectAll()

      const shortcutConflicts = result.warnings.filter((c) => c.type === "shortcut")
      expect(shortcutConflicts.length).toBeGreaterThan(0)
    })

    it("should normalize shortcuts for comparison", () => {
      detector.setPlugins([
        createRegistration(createManifest("plugin-a", "1.0.0"), {
          shortcuts: ["Ctrl+Shift+S"],
        }),
        createRegistration(createManifest("plugin-b", "1.0.0"), {
          shortcuts: ["Shift+Ctrl+S"],
        }),
      ])

      const result = detector.detectAll()

      const shortcutConflicts = result.warnings.filter((c) => c.type === "shortcut")
      expect(shortcutConflicts.length).toBeGreaterThan(0)
    })
  })

  describe("Namespace Conflicts", () => {
    it("should detect namespace conflicts", () => {
      detector.setPlugins([
        createRegistration(createManifest("plugin-a", "1.0.0"), {
          namespaces: ["my-namespace"],
        }),
        createRegistration(createManifest("plugin-b", "1.0.0"), {
          namespaces: ["my-namespace"],
        }),
      ])

      const result = detector.detectAll()

      const namespaceConflicts = result.errors.filter((c) => c.type === "namespace")
      expect(namespaceConflicts.length).toBeGreaterThan(0)
    })
  })

  describe("Version Conflicts", () => {
    it("should detect version conflicts", () => {
      // Version conflict detection requires multiple plugins depending on the same dependency
      // with at least one having an unsatisfied constraint
      detector.setPlugins([
        createRegistration(createManifest("core", "1.5.0")),
        createRegistration(
          createManifest("plugin-a", "1.0.0", {
            dependencies: { core: "^1.0.0" },
          })
        ),
        createRegistration(
          createManifest("plugin-b", "1.0.0", {
            dependencies: { core: "^2.0.0" },
          })
        ),
      ])

      const result = detector.detectAll()

      const versionConflicts = result.errors.filter((c) => c.type === "version")
      expect(versionConflicts.length).toBeGreaterThan(0)
    })

    it("should not flag satisfied dependencies", () => {
      detector.setPlugins([
        createRegistration(createManifest("core", "1.5.0")),
        createRegistration(
          createManifest("plugin-a", "1.0.0", {
            dependencies: { core: "^1.0.0" },
          })
        ),
      ])

      const result = detector.detectAll()

      const versionConflicts = result.errors.filter((c) => c.type === "version")
      expect(versionConflicts.length).toBe(0)
    })
  })

  describe("Resource Conflicts", () => {
    it("should detect resource conflicts", () => {
      detector.setPlugins([
        createRegistration(createManifest("plugin-a", "1.0.0"), {
          resources: ["/api/data"],
        }),
        createRegistration(createManifest("plugin-b", "1.0.0"), {
          resources: ["/api/data"],
        }),
      ])

      const result = detector.detectAll()

      const resourceConflicts = result.warnings.filter((c) => c.type === "resource")
      expect(resourceConflicts.length).toBeGreaterThan(0)
    })
  })

  describe("Capability Conflicts", () => {
    it("should detect exclusive capability conflicts", () => {
      detector.setPlugins([
        createRegistration(
          createManifest("theme-a", "1.0.0", {
            capabilities: ["themes"],
          })
        ),
        createRegistration(
          createManifest("theme-b", "1.0.0", {
            capabilities: ["themes"],
          })
        ),
      ])

      const result = detector.detectAll()

      const capabilityConflicts = result.info.filter((c) => c.type === "capability")
      expect(capabilityConflicts.length).toBeGreaterThan(0)
    })
  })

  describe("Detection Result", () => {
    it("should correctly categorize conflicts", () => {
      detector.setPlugins([
        createRegistration(createManifest("plugin-a", "1.0.0"), {
          namespaces: ["shared-ns"],
          commands: ["shared-cmd"],
        }),
        createRegistration(createManifest("plugin-b", "1.0.0"), {
          namespaces: ["shared-ns"],
          commands: ["shared-cmd"],
        }),
      ])

      const result = detector.detectAll()

      expect(result.hasConflicts).toBe(true)
      expect(result.errors.length).toBeGreaterThan(0)
      expect(result.warnings.length).toBeGreaterThan(0)
    })

    it("should determine if can proceed", () => {
      detector.setPlugins([
        createRegistration(createManifest("plugin-a", "1.0.0"), {
          commands: ["cmd"],
        }),
        createRegistration(createManifest("plugin-b", "1.0.0"), {
          commands: ["cmd"],
        }),
      ])

      const result = detector.detectAll()

      expect(result.canProceed).toBe(true)
    })

    it("should not proceed with errors", () => {
      detector.setPlugins([
        createRegistration(createManifest("plugin-a", "1.0.0"), {
          namespaces: ["ns"],
        }),
        createRegistration(createManifest("plugin-b", "1.0.0"), {
          namespaces: ["ns"],
        }),
      ])

      const result = detector.detectAll()

      expect(result.canProceed).toBe(false)
    })
  })

  describe("Single Plugin Detection", () => {
    it("should detect conflicts for a single plugin", () => {
      detector.setPlugins([
        createRegistration(createManifest("existing", "1.0.0"), {
          commands: ["my-command"],
        }),
        createRegistration(createManifest("new-plugin", "1.0.0"), {
          commands: ["my-command"],
        }),
      ])

      const result = detector.detectForPlugin("new-plugin")

      expect(result.hasConflicts).toBe(true)
    })

    it("should return no conflicts for unknown plugin", () => {
      const result = detector.detectForPlugin("unknown")

      expect(result.hasConflicts).toBe(false)
    })
  })

  describe("Auto Resolutions", () => {
    it("should generate auto resolutions for auto-resolvable conflicts", () => {
      detector.setPlugins([
        createRegistration(createManifest("plugin-a", "1.0.0"), {
          commands: ["cmd"],
        }),
        createRegistration(createManifest("plugin-b", "1.0.0"), {
          commands: ["cmd"],
        }),
      ])

      const result = detector.detectAll()

      expect(result.autoResolutions.length).toBeGreaterThan(0)
    })
  })
})

describe("Singleton", () => {
  it("should return the same instance", () => {
    resetConflictDetector()
    const instance1 = getConflictDetector()
    const instance2 = getConflictDetector()
    expect(instance1).toBe(instance2)
  })
})
