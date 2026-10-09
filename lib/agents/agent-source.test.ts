import type { Character } from "@cognia/agent-config-types"
import {
  countPendingPackUpdates,
  describeAgentSource,
  parseOverlayAgentId,
  type AgentSourceDeps,
} from "./agent-source"

const warning = { kind: "skill", id: "missing" } as never

function deps(patch: Partial<AgentSourceDeps> = {}): AgentSourceDeps {
  return {
    isOverlayCharacterId: (id) => id.startsWith("cognia-pack:"),
    packVersion: (pluginId, packId) =>
      pluginId === "plugin-a" && packId === "pack-a" ? "2.0.0" : undefined,
    packCharacterWarnings: (packId, localId) =>
      packId === "pack-a" && localId === "writer" ? [warning] : [],
    packWarnings: (packId) => (packId === "pack-a" ? [warning] : []),
    ...patch,
  }
}

function agent(patch: Partial<Character> = {}): Character {
  return {
    id: "char_1",
    name: "A",
    systemPrompt: "x",
    avatarColor: "#000",
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  }
}

describe("parseOverlayAgentId", () => {
  it("splits the synthetic id, keeping colons inside the local id", () => {
    expect(parseOverlayAgentId("cognia-pack:plugin-a:pack-a:writer:v2")).toEqual({
      packId: "pack-a",
      localId: "writer:v2",
    })
  })
})

describe("describeAgentSource", () => {
  it("treats a user-made agent as editable and deletable, with no pack", () => {
    expect(describeAgentSource(agent(), deps())).toMatchObject({
      isOverlay: false,
      isCloned: false,
      packId: undefined,
      updateAvailable: false,
      editable: true,
      deletable: true,
      warnings: [],
    })
  })

  it("locks a built-in agent, and the immutable support agent even though it is a row", () => {
    expect(describeAgentSource(agent({ isBuiltIn: true }), deps())).toMatchObject({
      editable: false,
      deletable: false,
    })
    expect(describeAgentSource(agent({ id: "char_builtin_support" }), deps())).toMatchObject({
      editable: false,
      deletable: true,
    })
  })

  it("reads an overlay row's pack and its per-character warnings from the id", () => {
    const source = describeAgentSource(agent({ id: "cognia-pack:plugin-a:pack-a:writer" }), deps())
    expect(source).toMatchObject({
      isOverlay: true,
      packId: "pack-a",
      editable: false,
      deletable: false,
      fromLocalFile: true,
    })
    expect(source.warnings).toEqual([warning])
  })

  it("flags a clone whose pack moved on, and names the plugin", () => {
    const source = describeAgentSource(
      agent({ sourcePluginId: "plugin-a", sourcePackId: "pack-a", packVersionAtClone: "1.0.0" }),
      deps()
    )
    expect(source).toMatchObject({
      isCloned: true,
      packId: "pack-a",
      livePackVersion: "2.0.0",
      updateAvailable: true,
      sourcePluginId: "plugin-a",
      fromLocalFile: false,
    })
    expect(source.warnings).toEqual([warning])
  })

  it("leaves a clone alone when its pack is unregistered", () => {
    expect(
      describeAgentSource(
        agent({ sourcePluginId: "plugin-b", sourcePackId: "pack-b", packVersionAtClone: "1.0.0" }),
        deps()
      ).updateAvailable
    ).toBe(false)
  })
})

describe("countPendingPackUpdates", () => {
  it("counts clones behind their pack, per pack", () => {
    const behind = agent({
      sourcePluginId: "plugin-a",
      sourcePackId: "pack-a",
      packVersionAtClone: "1.0.0",
    })
    const current = { ...behind, id: "c2", packVersionAtClone: "2.0.0" }
    const counts = countPendingPackUpdates(
      [behind, { ...behind, id: "c3" }, current, agent()],
      deps()
    )
    expect(Object.fromEntries(counts)).toEqual({ "plugin-a:pack-a": 2 })
  })
})
