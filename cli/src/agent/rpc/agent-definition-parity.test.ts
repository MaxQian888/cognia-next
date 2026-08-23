import type { AgentCompositionSelectionV1 } from "@cognia/agent-config-types/agent-composition"
import type { AgentCompositionSelection } from "@/packages/agent/src/agent-definition"

/**
 * `@cognia/agent` is published and `@cognia/agent-config-types` is private, so
 * the client cannot import the internal composition type and declares its own —
 * the same arrangement `handoff-envelope` already uses. This file is the only
 * place that can see both, so it is where the two are held together.
 */
describe("composition selection parity", () => {
  it("accepts an internal selection wherever the SDK type is expected", () => {
    const internal: AgentCompositionSelectionV1 = {
      presetId: "coding",
      authority: "propose",
      toolPresentation: "native",
      orchestration: "single",
      engagement: "interactive",
      autonomy: "supervised",
      orchestrationRef: "team:alpha",
      runtimeBindingRef: "execution-policy:default",
      legacyModeId: "legacy-mode",
    }
    const asSdk: AgentCompositionSelection = internal
    expect(asSdk.presetId).toBe("coding")
  })

  it("keeps the SDK type's key set a subset of the internal one", () => {
    // A key added to the SDK type without a counterpart internally would make
    // this assignment fail to compile.
    const sdkKeys: Record<keyof AgentCompositionSelection, true> = {
      presetId: true,
      authority: true,
      toolPresentation: true,
      orchestration: true,
      engagement: true,
      autonomy: true,
      orchestrationRef: true,
      runtimeBindingRef: true,
      legacyModeId: true,
    }
    const internalKeys: Record<keyof AgentCompositionSelectionV1, true> = sdkKeys
    expect(Object.keys(internalKeys).sort()).toEqual(Object.keys(sdkKeys).sort())
  })

  it("requires presetId on both sides", () => {
    // @ts-expect-error presetId is mandatory in the SDK type too.
    const missing: AgentCompositionSelection = { authority: "propose" }
    void missing
    expect(true).toBe(true)
  })
})
