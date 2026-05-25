import { PLUGIN_ID, ROLE_PACK_ID, packSkillId, roleCharacterId, mcpPresetId, nodeKind } from "./ids"

describe("zhihu-content-pipeline ids", () => {
  it("uses the stable plugin id", () => {
    expect(PLUGIN_ID).toBe("zhihu-content-pipeline")
    expect(ROLE_PACK_ID).toBe("zhihu-roles")
  })

  it("self-namespaces plugin skills as <pluginId>:<name>", () => {
    expect(packSkillId("zhihu-answer-writer")).toBe("zhihu-content-pipeline:zhihu-answer-writer")
  })

  it("projects a role to the host pack runtime id", () => {
    expect(roleCharacterId("writer")).toBe("cognia-pack:zhihu-content-pipeline:zhihu-roles:writer")
  })

  it("prefixes MCP preset ids with the plugin id to avoid gallery collisions", () => {
    expect(mcpPresetId("zget")).toBe("zhihu-content-pipeline-zget")
  })

  it("prefixes workflow node kinds the way the host does", () => {
    expect(nodeKind("scan")).toBe("zhihu-content-pipeline.scan")
  })
})
