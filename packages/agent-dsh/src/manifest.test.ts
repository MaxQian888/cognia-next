import { DSH_CAPABILITIES } from "./manifest"
import { mergeExternalAgentCapabilities } from "@cognia/agent-contracts/external-agent-capability"

describe("managed DeepSeek Harness capability refinements", () => {
  it.each(["deepseek-harness-readonly", "deepseek-harness-workspace", "deepseek-harness-acp"])(
    "does not advertise native subagents without a composed producer for %s",
    (presetId) => {
      const refinement = DSH_CAPABILITIES.presetRefinements?.[presetId]
      expect(refinement?.capabilities["subagents.native"]).toEqual({
        level: "unsupported",
        evidence: "adapter-code",
        reasonKey: "profilePluginNotComposed",
      })
      const protocol = DSH_CAPABILITIES.protocols?.[refinement!.protocol]
      const profile = mergeExternalAgentCapabilities([
        { layer: "protocol", cells: protocol?.capabilities ?? {} },
        { layer: "refinement", cells: refinement!.capabilities },
      ])
      expect(profile.effective["subagents.native"]?.level).toBe("unsupported")
      expect(profile.drift).toEqual([])
    }
  )
  it("keeps SDK native resume outside the integration", () => {
    expect(DSH_CAPABILITIES.protocols?.["dsh-sdk"]?.capabilities["session.resume"]?.level).toBe(
      "unsupported"
    )
  })
})
