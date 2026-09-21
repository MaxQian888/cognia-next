const inspectMock = jest.fn()
const applyMock = jest.fn()

jest.mock("@/lib/plugin/convert/agent-service", () => ({
  getPluginConversionService: () => ({
    inspect: (...args: unknown[]) => inspectMock(...args),
    apply: (...args: unknown[]) => applyMock(...args),
  }),
}))

import { getSharedBuiltInSkillRegistry } from "../registry"
import "./index"

beforeEach(() => {
  jest.clearAllMocks()
})

describe("plugin conversion built-in skills", () => {
  it("accepts new targets and forwards the surface and reviewed-warning decision", async () => {
    const inspect = getSharedBuiltInSkillRegistry().get("plugin.conversion.inspect")!
    const apply = getSharedBuiltInSkillRegistry().get("plugin.conversion.apply")!
    const context = { sessionId: "s1", workspaceRoot: "/workspace" }
    await inspect.execute(
      { sourceDir: "plugins/source", target: "cursor", surface: "desktop" },
      context
    )
    expect(inspectMock).toHaveBeenCalledWith({
      workspaceRoot: "/workspace",
      sourceDir: "plugins/source",
      target: "cursor",
      surface: "desktop",
    })
    await apply.execute(
      { planId: "plan-1", outputDir: "plugins/output", acknowledgeWarnings: true },
      context
    )
    expect(applyMock).toHaveBeenCalledWith({
      workspaceRoot: "/workspace",
      planId: "plan-1",
      outputDir: "plugins/output",
      acknowledgeWarnings: true,
    })
  })
  it("registers a read-only inspection tool scoped to the active workspace", async () => {
    inspectMock.mockResolvedValue({ applicable: true, planId: "plan-1" })
    const skill = getSharedBuiltInSkillRegistry().get("plugin.conversion.inspect")

    expect(skill).toMatchObject({
      family: "plugin.conversion",
      mutation: "read",
      imAccess: "blocked",
      mcpToolName: "plugin_conversion_inspect",
    })
    await expect(
      skill?.execute(
        { sourceDir: "plugins/source", target: "cognia" },
        { sessionId: "s1", workspaceRoot: "/workspace" }
      )
    ).resolves.toEqual({ applicable: true, planId: "plan-1" })
    expect(inspectMock).toHaveBeenCalledWith({
      workspaceRoot: "/workspace",
      sourceDir: "plugins/source",
      target: "cognia",
    })
  })

  it("registers apply as a write tool with a concrete HITL surface", async () => {
    applyMock.mockResolvedValue({ pluginId: "review-helper" })
    const skill = getSharedBuiltInSkillRegistry().get("plugin.conversion.apply")

    expect(skill).toMatchObject({
      family: "plugin.conversion",
      mutation: "write",
      imAccess: "blocked",
      mcpToolName: "plugin_conversion_apply",
    })
    const surface = skill?.hitlSurface?.({
      planId: "plan-1",
      outputDir: "plugins/converted",
    })
    expect(surface?.components.btn_confirm).toMatchObject({
      component: "Button",
      props: { action: { value: "confirm" } },
    })
    expect(surface?.components.btn_cancel).toMatchObject({
      component: "Button",
      props: { action: { value: "cancel" } },
    })

    await expect(
      skill?.execute(
        { planId: "plan-1", outputDir: "plugins/converted" },
        { sessionId: "s1", workspaceRoot: "/workspace" }
      )
    ).resolves.toEqual({ pluginId: "review-helper" })
    expect(applyMock).toHaveBeenCalledWith({
      workspaceRoot: "/workspace",
      planId: "plan-1",
      outputDir: "plugins/converted",
    })
  })

  it("refuses execution when the session has no active workspace", async () => {
    const skill = getSharedBuiltInSkillRegistry().get("plugin.conversion.inspect")

    await expect(
      skill?.execute({ sourceDir: "plugins/source", target: "cognia" }, { sessionId: "s1" })
    ).rejects.toThrow(/active .*workspace/i)
    expect(inspectMock).not.toHaveBeenCalled()
  })
})
