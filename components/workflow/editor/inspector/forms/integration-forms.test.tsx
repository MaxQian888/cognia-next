import {
  SkillInvokeConfig,
  TwinRagConfig,
  SkillUpsertConfig,
  TwinIngestConfig,
  MemoryRecallConfig,
  MemoryStoreConfig,
  McpInvokeToolConfig,
  PluginInvokeConfig,
} from "./integration-forms"

describe("integration-forms export surface", () => {
  it("exports its workflow inspector forms", () => {
    expect(
      [
        SkillInvokeConfig,
        TwinRagConfig,
        SkillUpsertConfig,
        TwinIngestConfig,
        MemoryRecallConfig,
        MemoryStoreConfig,
        McpInvokeToolConfig,
        PluginInvokeConfig,
      ].every((form) => typeof form === "function")
    ).toBe(true)
  })
})
