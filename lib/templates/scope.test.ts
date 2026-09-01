import { TEMPLATE_SCOPE_TIERS, isTemplateVisibleInWorkspace, templateScopeTier } from "./scope"
import type { TemplateDefinitionEnvelope } from "./contracts"

function definition(source: string): TemplateDefinitionEnvelope {
  return { provenance: { source } } as unknown as TemplateDefinitionEnvelope
}

describe("templateScopeTier", () => {
  it("reads the tier off the provenance enum", () => {
    expect(templateScopeTier(definition("built-in"))).toBe("builtin")
    expect(templateScopeTier(definition("plugin"))).toBe("plugin")
    expect(templateScopeTier(definition("marketplace"))).toBe("marketplace")
    expect(templateScopeTier(definition("link"))).toBe("marketplace")
  })

  it("treats everything the user brought in as theirs", () => {
    expect(templateScopeTier(definition("user"))).toBe("mine")
    expect(templateScopeTier(definition("file"))).toBe("mine")
    expect(templateScopeTier(definition("legacy"))).toBe("mine")
  })

  /** A built-in you forked and confined is that workspace's, not a built-in. */
  it("lets ownership win over provenance", () => {
    expect(templateScopeTier(definition("built-in"), "ws_1")).toBe("workspace")
  })

  it("offers the workspace's own shelf first", () => {
    expect(TEMPLATE_SCOPE_TIERS[0]).toBe("workspace")
  })
})

describe("isTemplateVisibleInWorkspace", () => {
  const shared = definition("built-in")

  it("hides an owned definition from every other workspace", () => {
    expect(
      isTemplateVisibleInWorkspace({
        definition: shared,
        ownerWorkspaceId: "ws_1",
        activeWorkspaceId: "ws_2",
      })
    ).toBe(false)
    expect(
      isTemplateVisibleInWorkspace({
        definition: shared,
        ownerWorkspaceId: "ws_1",
        activeWorkspaceId: "ws_1",
      })
    ).toBe(true)
  })

  it("shows a shared definition unless the workspace said otherwise", () => {
    expect(isTemplateVisibleInWorkspace({ definition: shared, activeWorkspaceId: "ws_1" })).toBe(
      true
    )
    expect(
      isTemplateVisibleInWorkspace({
        definition: shared,
        activeWorkspaceId: "ws_1",
        hiddenHere: true,
      })
    ).toBe(false)
  })

  /**
   * While the store is still hydrating there is no workspace to filter by, and
   * silently dropping rows would look like an empty library rather than a
   * pending one.
   */
  it("filters nothing until a workspace is known", () => {
    expect(
      isTemplateVisibleInWorkspace({
        definition: shared,
        ownerWorkspaceId: "ws_1",
        activeWorkspaceId: null,
        hiddenHere: true,
      })
    ).toBe(true)
  })
})
