import { buildGithubDeliveryTemplates } from "./seed-github"
import { WORKFLOW_NODE_KINDS } from "@/types/workflow/visual"

describe("buildGithubDeliveryTemplates", () => {
  const templates = buildGithubDeliveryTemplates()

  it("emits all 8 templates", () => {
    expect(templates).toHaveLength(8)
  })

  it("includes the new inline PR review template", () => {
    const names = templates.map((t) => t.name)
    expect(names).toContain("[GitHub] PR inline AI review")
  })

  it("every template id is unique and starts with wf_builtin_gh_", () => {
    const ids = templates.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) {
      expect(id).toMatch(/^wf_builtin_gh_/)
    }
  })

  it("every template is flagged isBuiltIn + isTemplate", () => {
    for (const t of templates) {
      expect(t.isBuiltIn).toBe(true)
      expect(t.isTemplate).toBe(true)
    }
  })

  it("each template name starts with [GitHub]", () => {
    for (const t of templates) {
      expect(t.name).toMatch(/^\[GitHub\]/)
    }
  })

  it("each template's nodes only reference registered WorkflowNodeKind values", () => {
    const known = new Set<string>(WORKFLOW_NODE_KINDS)
    for (const t of templates) {
      for (const n of t.nodes) {
        expect(known.has(n.type)).toBe(true)
      }
    }
  })

  it("every edge points to existing node ids", () => {
    for (const t of templates) {
      const ids = new Set(t.nodes.map((n) => n.id))
      for (const e of t.edges) {
        expect(ids.has(e.source)).toBe(true)
        expect(ids.has(e.target)).toBe(true)
      }
    }
  })

  it("templates that use trigger.github.webhook declare an events list", () => {
    for (const t of templates) {
      for (const n of t.nodes) {
        if (n.type === "trigger.github.webhook") {
          const params = n.data.params as { events?: string[] }
          expect(Array.isArray(params.events)).toBe(true)
          expect(params.events!.length).toBeGreaterThan(0)
        }
      }
    }
  })

  it("includes the conventional, continuous, and manual release templates", () => {
    const names = templates.map((t) => t.name)
    expect(names).toContain("[GitHub] Release: Conventional Commits")
    expect(names).toContain("[GitHub] Release: continuous")
    expect(names).toContain("[GitHub] Release: manual")
  })
})
