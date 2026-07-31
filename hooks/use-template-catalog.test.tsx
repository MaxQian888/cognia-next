import { act, renderHook } from "@testing-library/react"
import { TemplateCatalog } from "@/lib/templates/catalog"
import { createTemplateDefinition } from "@/lib/templates/contracts"
import { useTemplateCatalog } from "./use-template-catalog"

describe("useTemplateCatalog", () => {
  it("refreshes mounted consumers when a plugin source is removed", async () => {
    const catalog = new TemplateCatalog()
    const definition = await createTemplateDefinition({
      id: "plugin.demo:skill",
      domain: "skill",
      status: "published",
      revision: 1,
      version: "1.0.0",
      metadata: { name: "Plugin skill" },
      payload: { content: "x" },
      inputs: [],
      dependencies: [],
      capabilities: [],
      compatibility: { platforms: ["desktop"] },
      provenance: { source: "plugin", pluginId: "plugin.demo", trust: "unsigned" },
    })
    const { result } = renderHook(() => useTemplateCatalog({}, catalog))

    act(() => catalog.replaceSource("plugin:plugin.demo", [definition]))
    expect(result.current.definitions).toHaveLength(1)

    act(() => catalog.removeSource("plugin:plugin.demo"))
    expect(result.current.definitions).toHaveLength(0)
  })
})
