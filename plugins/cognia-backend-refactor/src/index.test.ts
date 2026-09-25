import { createTestPluginContext } from "@cognia/plugin-sdk/testing"

import definition, { manifest } from "./index"
import manifestJson from "../plugin.json"
import { PLUGIN_ID } from "./ids"

describe("backend-refactor plugin manifest", () => {
  it("declares all six capabilities and ships every contribution on the manifest", () => {
    expect(manifest.id).toBe(PLUGIN_ID)
    expect(manifest.capabilities).toEqual(
      expect.arrayContaining([
        "character-pack",
        "workflow",
        "skills",
        "subagent",
        "agent-team-template",
        "workflow-template",
      ])
    )
    expect(manifest.characterPacks).toHaveLength(1)
    expect(manifest.skills).toHaveLength(5)
    expect(manifest.subagents).toHaveLength(2)
    expect(manifest.agentTeamTemplates).toHaveLength(1)
    expect(manifest.workflowTemplates).toHaveLength(1)
  })

  it("spreads plugin.json rather than restating a subset", () => {
    expect(manifest.runtimeCompatibility).toEqual(manifestJson.runtimeCompatibility)
    expect(manifest.description).toBe(manifestJson.description)
  })

  it("names what it is for and says where the pipeline can run", () => {
    expect(manifestJson.name).toMatch(/^Go /)
    expect(manifestJson.runtimeCompatibility.browser.availability).toBe("degraded")
    expect(manifestJson.runtimeCompatibility.mobile.availability).toBe("degraded")
    expect(manifestJson.runtimeCompatibility.browser.reason).toMatch(/cannot run/)
  })
})

describe("backend-refactor activate", () => {
  it("registers only the two workflow nodes; the pack rides the manifest", async () => {
    const { ctx, callsTo } = createTestPluginContext({ pluginId: PLUGIN_ID })
    await definition.activate(ctx)

    const kinds = callsTo("workflow.registerNode").map(([def]) => (def as { kind: string }).kind)
    expect(kinds).toEqual(["agent.turn", "pipeline.stop"])
    // Registering the pack here as well used to double-register it.
    expect(callsTo("characterPacks.register")).toHaveLength(0)
    expect(callsTo("workflow.refreshTemplateWarnings")).toHaveLength(1)
  })

  it("releases both node registrations through the activation lifecycle", async () => {
    const disposers = [jest.fn(), jest.fn()]
    let registered = 0
    const registerNode = jest.fn((): (() => void) => disposers[registered++]!)
    const { ctx, dispose } = createTestPluginContext({
      pluginId: PLUGIN_ID,
      overrides: { workflow: { registerNode } },
    })
    await definition.activate(ctx)
    await dispose()
    for (const disposeNode of disposers) expect(disposeNode).toHaveBeenCalledTimes(1)
  })
})
