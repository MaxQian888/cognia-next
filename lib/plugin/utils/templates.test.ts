/**
 * Plugin Templates Tests
 */

import {
  PLUGIN_TEMPLATES,
  scaffoldPlugin,
  getTemplateById,
  getTemplatesByType,
  getTemplatesByCapability,
  searchTemplates,
  type PluginScaffoldOptions,
} from "./templates"

describe("PLUGIN_TEMPLATES", () => {
  it("should have all required templates", () => {
    expect(PLUGIN_TEMPLATES.length).toBeGreaterThanOrEqual(8)

    const templateIds = PLUGIN_TEMPLATES.map((t) => t.id)
    expect(templateIds).toContain("basic-tool")
    expect(templateIds).toContain("python-data")
    expect(templateIds).toContain("a2ui-component")
    expect(templateIds).toContain("agent-mode")
    expect(templateIds).toContain("hybrid-full")
    // New templates
    expect(templateIds).toContain("theme-plugin")
    expect(templateIds).toContain("ai-provider")
    expect(templateIds).toContain("exporter-plugin")
    expect(templateIds).toContain("processor-plugin")
  })

  it("should have valid template structure", () => {
    for (const template of PLUGIN_TEMPLATES) {
      expect(template.id).toBeDefined()
      expect(template.name).toBeDefined()
      expect(template.description).toBeDefined()
      expect(template.type).toMatch(/^(frontend|python|hybrid)$/)
      expect(template.difficulty).toMatch(/^(beginner|intermediate|advanced)$/)
      expect(Array.isArray(template.capabilities)).toBe(true)
      expect(template.capabilities.length).toBeGreaterThan(0)
    }
  })
})

describe("getTemplateById", () => {
  it("should return template by ID", () => {
    const template = getTemplateById("basic-tool")
    expect(template).toBeDefined()
    expect(template?.id).toBe("basic-tool")
    expect(template?.name).toBe("Basic Tool Plugin")
  })

  it("should return undefined for unknown ID", () => {
    const template = getTemplateById("unknown-template")
    expect(template).toBeUndefined()
  })
})

describe("getTemplatesByType", () => {
  it("should filter templates by frontend type", () => {
    const templates = getTemplatesByType("frontend")
    expect(templates.length).toBeGreaterThan(0)
    templates.forEach((t) => expect(t.type).toBe("frontend"))
  })

  it("should filter templates by python type", () => {
    const templates = getTemplatesByType("python")
    expect(templates.length).toBeGreaterThan(0)
    templates.forEach((t) => expect(t.type).toBe("python"))
  })

  it("should filter templates by hybrid type", () => {
    const templates = getTemplatesByType("hybrid")
    expect(templates.length).toBeGreaterThan(0)
    templates.forEach((t) => expect(t.type).toBe("hybrid"))
  })
})

describe("getTemplatesByCapability", () => {
  it("should filter templates by tools capability", () => {
    const templates = getTemplatesByCapability("tools")
    expect(templates.length).toBeGreaterThan(0)
    templates.forEach((t) => expect(t.capabilities).toContain("tools"))
  })

  it("should filter templates by components capability", () => {
    const templates = getTemplatesByCapability("components")
    expect(templates.length).toBeGreaterThan(0)
    templates.forEach((t) => expect(t.capabilities).toContain("components"))
  })

  it("should filter templates by modes capability", () => {
    const templates = getTemplatesByCapability("modes")
    expect(templates.length).toBeGreaterThan(0)
    templates.forEach((t) => expect(t.capabilities).toContain("modes"))
  })

  it("should filter templates by themes capability", () => {
    const templates = getTemplatesByCapability("themes")
    expect(templates.length).toBeGreaterThan(0)
    templates.forEach((t) => expect(t.capabilities).toContain("themes"))
  })

  it("should filter templates by providers capability", () => {
    const templates = getTemplatesByCapability("providers")
    expect(templates.length).toBeGreaterThan(0)
    templates.forEach((t) => expect(t.capabilities).toContain("providers"))
  })

  it("should filter templates by exporters capability", () => {
    const templates = getTemplatesByCapability("exporters")
    expect(templates.length).toBeGreaterThan(0)
    templates.forEach((t) => expect(t.capabilities).toContain("exporters"))
  })

  it("should filter templates by processors capability", () => {
    const templates = getTemplatesByCapability("processors")
    expect(templates.length).toBeGreaterThan(0)
    templates.forEach((t) => expect(t.capabilities).toContain("processors"))
  })
})

describe("searchTemplates", () => {
  it("should find templates by name", () => {
    const results = searchTemplates("tool")
    expect(results.length).toBeGreaterThan(0)
  })

  it("should find templates by description", () => {
    const results = searchTemplates("data processing")
    expect(results.length).toBeGreaterThan(0)
  })

  it("should return empty array for no matches", () => {
    const results = searchTemplates("xyz123nonexistent")
    expect(results).toEqual([])
  })

  it("should be case insensitive", () => {
    const lower = searchTemplates("python")
    const upper = searchTemplates("PYTHON")
    expect(lower.length).toBe(upper.length)
  })
})

describe("scaffoldPlugin", () => {
  const baseOptions: PluginScaffoldOptions = {
    name: "Test Plugin",
    id: "test-plugin",
    description: "A test plugin",
    author: { name: "Test Author", email: "test@example.com" },
    type: "frontend",
    capabilities: ["tools"],
  }

  it("should generate plugin.json manifest", () => {
    const files = scaffoldPlugin(baseOptions)

    expect(files.has("plugin.json")).toBe(true)

    const manifest = JSON.parse(files.get("plugin.json")!)
    expect(manifest.id).toBe("test-plugin")
    expect(manifest.name).toBe("Test Plugin")
    expect(manifest.description).toBe("A test plugin")
    expect(manifest.type).toBe("frontend")
    expect(manifest.capabilities).toContain("tools")
    expect(manifest.author.name).toBe("Test Author")
  })

  it("should generate index.ts for frontend plugins", () => {
    const files = scaffoldPlugin(baseOptions)

    expect(files.has("index.ts")).toBe(true)

    const content = files.get("index.ts")!
    expect(content).toContain("definePlugin")
    expect(content).toContain("PluginContext")
  })

  it("should generate main.py for python plugins", () => {
    const files = scaffoldPlugin({
      ...baseOptions,
      type: "python",
    })

    expect(files.has("main.py")).toBe(true)

    const content = files.get("main.py")!
    expect(content).toContain("from cognia")
    expect(content).toContain("class")
  })

  it("should generate files for hybrid plugins", () => {
    const files = scaffoldPlugin({
      ...baseOptions,
      type: "hybrid",
      capabilities: ["tools", "python"],
    })

    // Hybrid plugins should have either frontend or backend files
    expect(files.size).toBeGreaterThan(0)
    expect(files.has("plugin.json")).toBe(true)
  })

  it("should generate README.md", () => {
    const files = scaffoldPlugin(baseOptions)

    expect(files.has("README.md")).toBe(true)

    const content = files.get("README.md")!
    expect(content).toContain("Test Plugin")
    expect(content).toContain("A test plugin")
  })

  it("should use template when specified", () => {
    const files = scaffoldPlugin({
      ...baseOptions,
      template: "basic-tool",
    })

    expect(files.size).toBeGreaterThan(0)
    expect(files.has("plugin.json")).toBe(true)
  })

  it("should generate required files for frontend plugins", () => {
    const files = scaffoldPlugin(baseOptions)

    // Frontend plugins should have at minimum plugin.json and index.ts
    expect(files.has("plugin.json")).toBe(true)
    expect(files.has("index.ts")).toBe(true)
  })

  it("should generate requirements.txt for python plugins", () => {
    const files = scaffoldPlugin({
      ...baseOptions,
      type: "python",
    })

    expect(files.has("requirements.txt")).toBe(true)
  })

  it("should include version in manifest", () => {
    const files = scaffoldPlugin(baseOptions)
    const manifest = JSON.parse(files.get("plugin.json")!)

    expect(manifest.version).toBe("1.0.0")
  })

  it("should use an explicit version override in the manifest", () => {
    const files = scaffoldPlugin({
      ...baseOptions,
      version: "2.3.4",
    })
    const manifest = JSON.parse(files.get("plugin.json")!)

    expect(manifest.version).toBe("2.3.4")
  })

  it("should include main entry point in manifest", () => {
    const files = scaffoldPlugin(baseOptions)
    const manifest = JSON.parse(files.get("plugin.json")!)

    expect(manifest.main).toBe("index.ts")
  })

  it("should set python main for python plugins", () => {
    const files = scaffoldPlugin({
      ...baseOptions,
      type: "python",
    })
    const manifest = JSON.parse(files.get("plugin.json")!)

    expect(manifest.main).toBe("main.py")
  })

  it("injects a runnable tool example when tools capability is selected without a template", () => {
    const files = scaffoldPlugin({
      ...baseOptions,
      template: "missing-template",
      capabilities: ["tools"],
    })

    const content = files.get("index.ts")!
    expect(content).toContain("registerPluginTools")
    expect(content).toContain("const exampleTool = tool")
    expect(content).toContain(`${baseOptions.id.replace(/-/g, "_")}_echo`)
  })

  it("injects component and hook examples when those capabilities are selected without a template", () => {
    const files = scaffoldPlugin({
      ...baseOptions,
      template: "missing-template",
      capabilities: ["components", "hooks"],
    })

    const content = files.get("index.ts")!
    expect(content).toContain("context.a2ui.registerComponent")
    expect(content).toContain("Panel = () =>")
    expect(content).toContain("onSessionCreate")
  })
})

describe("New Plugin Templates", () => {
  describe("theme-plugin template", () => {
    it("should exist and have correct structure", () => {
      const template = getTemplateById("theme-plugin")
      expect(template).toBeDefined()
      expect(template?.type).toBe("frontend")
      expect(template?.capabilities).toContain("themes")
      expect(template?.difficulty).toBe("beginner")
    })

    it("should scaffold theme plugin correctly", () => {
      const files = scaffoldPlugin({
        name: "My Theme",
        id: "my-theme",
        description: "Custom theme plugin",
        author: { name: "Test" },
        type: "frontend",
        capabilities: ["themes"],
        template: "theme-plugin",
      })

      expect(files.has("plugin.json")).toBe(true)
      expect(files.has("index.ts")).toBe(true)
      expect(files.has("README.md")).toBe(true)

      const manifest = JSON.parse(files.get("plugin.json")!)
      expect(manifest.capabilities).toContain("themes")

      const code = files.get("index.ts")!
      expect(code).toContain("themes")
      expect(code).toContain("ThemeColors")
    })
  })

  describe("ai-provider template", () => {
    it("should exist and have correct structure", () => {
      const template = getTemplateById("ai-provider")
      expect(template).toBeDefined()
      expect(template?.type).toBe("frontend")
      expect(template?.capabilities).toContain("providers")
      expect(template?.difficulty).toBe("advanced")
    })

    it("should scaffold AI provider plugin correctly", () => {
      const files = scaffoldPlugin({
        name: "My Provider",
        id: "my-provider",
        description: "Custom AI provider",
        author: { name: "Test" },
        type: "frontend",
        capabilities: ["providers"],
        template: "ai-provider",
      })

      expect(files.has("plugin.json")).toBe(true)
      expect(files.has("index.ts")).toBe(true)

      const manifest = JSON.parse(files.get("plugin.json")!)
      expect(manifest.capabilities).toContain("providers")
      expect(manifest.configSchema).toBeDefined()
      expect(manifest.configSchema.properties.apiKey).toBeDefined()

      const code = files.get("index.ts")!
      expect(code).toContain("providers")
      expect(code).toContain("chat")
      expect(code).toContain("stream")
    })
  })

  describe("exporter-plugin template", () => {
    it("should exist and have correct structure", () => {
      const template = getTemplateById("exporter-plugin")
      expect(template).toBeDefined()
      expect(template?.type).toBe("frontend")
      expect(template?.capabilities).toContain("exporters")
      expect(template?.difficulty).toBe("intermediate")
    })

    it("should scaffold exporter plugin correctly", () => {
      const files = scaffoldPlugin({
        name: "My Exporter",
        id: "my-exporter",
        description: "Custom export formats",
        author: { name: "Test" },
        type: "frontend",
        capabilities: ["exporters"],
        template: "exporter-plugin",
      })

      expect(files.has("plugin.json")).toBe(true)
      expect(files.has("index.ts")).toBe(true)

      const manifest = JSON.parse(files.get("plugin.json")!)
      expect(manifest.capabilities).toContain("exporters")

      const code = files.get("index.ts")!
      expect(code).toContain("exporters")
      expect(code).toContain("export")
      expect(code).toContain("Blob")
    })
  })

  describe("processor-plugin template", () => {
    it("should exist and have correct structure", () => {
      const template = getTemplateById("processor-plugin")
      expect(template).toBeDefined()
      expect(template?.type).toBe("frontend")
      expect(template?.capabilities).toContain("processors")
      expect(template?.capabilities).toContain("hooks")
      expect(template?.difficulty).toBe("intermediate")
    })

    it("should scaffold processor plugin correctly", () => {
      const files = scaffoldPlugin({
        name: "My Processor",
        id: "my-processor",
        description: "Message processor plugin",
        author: { name: "Test" },
        type: "frontend",
        capabilities: ["processors", "hooks"],
        template: "processor-plugin",
      })

      expect(files.has("plugin.json")).toBe(true)
      expect(files.has("index.ts")).toBe(true)

      const manifest = JSON.parse(files.get("plugin.json")!)
      expect(manifest.capabilities).toContain("processors")
      expect(manifest.capabilities).toContain("hooks")
      expect(manifest.configSchema).toBeDefined()

      const code = files.get("index.ts")!
      expect(code).toContain("processors")
      expect(code).toContain("process")
      expect(code).toContain("sanitize")
    })
  })

  describe("template tags", () => {
    it("should have searchable tags", () => {
      const themeResults = searchTemplates("dark-mode")
      expect(themeResults.length).toBeGreaterThan(0)

      const providerResults = searchTemplates("llm")
      expect(providerResults.length).toBeGreaterThan(0)

      const exportResults = searchTemplates("pdf")
      expect(exportResults.length).toBeGreaterThan(0)

      const processorResults = searchTemplates("filter")
      expect(processorResults.length).toBeGreaterThan(0)
    })
  })
})
