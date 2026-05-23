import { projectPluginWorkflowTemplate } from "./project-plugin-workflow-template"
import { validateWorkflow } from "@/lib/workflow/definition/validate"
import type { PluginWorkflowTemplateDef } from "@/types/plugin/plugin-workflow-template"

function makeDef(overrides: Partial<PluginWorkflowTemplateDef> = {}): PluginWorkflowTemplateDef {
  return {
    id: "fetch-summarize",
    name: "Fetch & summarize",
    description: "HTTP → AI",
    category: "automation",
    nodes: [
      {
        id: "n_trigger",
        type: "trigger.manual",
        typeVersion: 1,
        position: { x: 0, y: 0 },
        data: { label: "Start" },
      },
      {
        id: "n_http",
        type: "io.http",
        typeVersion: 1,
        position: { x: 200, y: 0 },
        data: { label: "Fetch", params: { url: "https://example.com" } },
      },
    ],
    edges: [{ id: "e1", source: "n_trigger", target: "n_http" }],
    ...overrides,
  }
}

describe("projectPluginWorkflowTemplate", () => {
  it("namespaces the id and stamps template metadata", () => {
    const wf = projectPluginWorkflowTemplate({
      id: "fetch-summarize",
      entry: makeDef(),
      pluginId: "p",
    })
    expect(wf.id).toBe("p:fetch-summarize")
    expect(wf.isTemplate).toBe(true)
    expect(wf.isBuiltIn).toBe(false)
    expect(wf.schemaVersion).toBe(1)
    expect(wf.nodes).toHaveLength(2)
    expect(wf.edges).toHaveLength(1)
  })

  it("merges the template settings over the host defaults", () => {
    const wf = projectPluginWorkflowTemplate({
      id: "x",
      entry: makeDef({ settings: { errorPolicy: "branch" } }),
      pluginId: "p",
    })
    expect(wf.settings.errorPolicy).toBe("branch")
    // Unspecified settings fall back to the defaults.
    expect(wf.settings.timeoutMs).toBeGreaterThan(0)
  })

  it("produces a workflow that passes validation", () => {
    const wf = projectPluginWorkflowTemplate({ id: "x", entry: makeDef(), pluginId: "p" })
    const result = validateWorkflow(wf)
    expect(result.ok).toBe(true)
  })

  it("falls back to the bare id when no pluginId is provided", () => {
    const wf = projectPluginWorkflowTemplate({ id: "x", entry: makeDef() })
    expect(wf.id).toBe("fetch-summarize")
  })
})
