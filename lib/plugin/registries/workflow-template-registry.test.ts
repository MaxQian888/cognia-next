import type { PluginWorkflowTemplateDef } from "@/types/plugin/plugin-workflow-template"
import {
  __resetWorkflowTemplatesForTesting,
  getWorkflowTemplate,
  getWorkflowTemplateWarnings,
  listWorkflowTemplateEntries,
  refreshAllWorkflowTemplateWarnings,
  registerWorkflowTemplate,
  unregisterWorkflowTemplatesByPlugin,
  validateWorkflowTemplateRequires,
} from "./workflow-template-registry"
import { registerSkill, __resetSkillsForTesting } from "./skill-registry"
import { addPluginCatalogEntry } from "@/lib/workflow/nodes/catalog"

function makeTemplate(
  overrides: Partial<PluginWorkflowTemplateDef> = {}
): PluginWorkflowTemplateDef {
  return {
    id: "tpl",
    name: "Template",
    description: "desc",
    category: "automation",
    nodes: [],
    edges: [],
    ...overrides,
  }
}

beforeEach(() => {
  __resetWorkflowTemplatesForTesting()
  __resetSkillsForTesting()
})

describe("workflow-template-registry", () => {
  it("registers and retrieves a template", () => {
    registerWorkflowTemplate("tpl", makeTemplate(), { pluginId: "p" })
    expect(getWorkflowTemplate("tpl")?.name).toBe("Template")
    expect(listWorkflowTemplateEntries()).toHaveLength(1)
  })

  it("stamps a missing-skill warning and clears it once the skill arrives", () => {
    registerWorkflowTemplate("tpl", makeTemplate({ requires: { skillIds: ["p:write"] } }), {
      pluginId: "p",
    })
    expect(getWorkflowTemplateWarnings("tpl")).toEqual([
      { code: "missing-skill", missingId: "p:write" },
    ])
    // Register the skill, then refresh → warning clears.
    registerSkill("p:write", { id: "p:write" } as never, { pluginId: "p" })
    refreshAllWorkflowTemplateWarnings()
    expect(getWorkflowTemplateWarnings("tpl")).toEqual([])
  })

  it("flags missing plugin node kinds against the catalog", () => {
    const result = validateWorkflowTemplateRequires(
      makeTemplate({ requires: { pluginNodeKinds: ["p.action.absent"] } })
    )
    expect(result.ok).toBe(false)
    expect(result.warnings).toContainEqual({
      code: "missing-plugin-node",
      missingId: "p.action.absent",
    })
  })

  it("resolves a plugin node kind present in the catalog", () => {
    addPluginCatalogEntry({
      kind: "p.action.present" as never,
      category: "plugin",
      label: "Present",
      description: "",
      iconName: "Box",
      keywords: [],
      pluginId: "p",
    })
    const result = validateWorkflowTemplateRequires(
      makeTemplate({ requires: { pluginNodeKinds: ["p.action.present"] } })
    )
    expect(result.ok).toBe(true)
  })

  it("drops every template contributed by a plugin", () => {
    registerWorkflowTemplate("a", makeTemplate({ id: "a" }), { pluginId: "p" })
    registerWorkflowTemplate("b", makeTemplate({ id: "b" }), { pluginId: "q" })
    const removed = unregisterWorkflowTemplatesByPlugin("p")
    expect(removed).toBe(1)
    expect(getWorkflowTemplate("a")).toBeUndefined()
    expect(getWorkflowTemplate("b")?.id).toBe("b")
  })
})
