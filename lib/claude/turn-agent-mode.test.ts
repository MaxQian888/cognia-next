/** @jest-environment jsdom */

import { resolveTurnAgentMode } from "./turn-agent-mode"
import { useAgentRuntimeStore } from "@/stores/agent/agent-runtime-store"
import { useCustomModeStore } from "@/stores/agent/custom-mode-store"
import type { AgentModeConfig } from "@/types/agent/agent-mode"

const CUSTOM_MODE: AgentModeConfig = {
  id: "my-reviewer",
  type: "custom",
  name: "My Reviewer",
  description: "Reviews things",
  icon: "Sparkles",
  systemPrompt: "Be exacting.",
  tools: ["Read"],
  permissionMode: "acceptEdits",
}

function seedCustomMode() {
  useCustomModeStore.setState({
    customModes: {
      "my-reviewer": {
        ...CUSTOM_MODE,
        isBuiltIn: false,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
    } as never,
  })
}

describe("resolveTurnAgentMode", () => {
  beforeEach(() => {
    useAgentRuntimeStore.setState({
      defaultComposition: { presetId: "standard" },
      sessionCompositions: {},
    })
    useCustomModeStore.setState({ customModes: {} })
  })

  afterEach(() => {
    useAgentRuntimeStore.setState({
      defaultComposition: { presetId: "standard" },
      sessionCompositions: {},
    })
    useCustomModeStore.setState({ customModes: {} })
  })

  it("contributes nothing when the caller suppresses modes", () => {
    expect(resolveTurnAgentMode({ explicitMode: null })).toEqual({})
  })

  it("honours an explicit mode override over the session's selection", () => {
    useAgentRuntimeStore.setState({ sessionCompositions: { s1: { presetId: "minimal" } } })

    const resolved = resolveTurnAgentMode({ explicitMode: CUSTOM_MODE, sessionId: "s1" })

    expect(resolved.mode).toBe(CUSTOM_MODE)
    expect(resolved.preset?.id).toBe("my-reviewer")
    expect(resolved.requestedAuthority).toBe("acceptEdits")
  })

  it("resolves Standard to the general built-in, which contributes nothing", () => {
    const resolved = resolveTurnAgentMode({ sessionId: "s1" })

    expect(resolved.preset?.id).toBe("standard")
    expect(resolved.mode?.id).toBe("general")
    expect(resolved.preset?.systemPromptDelta).toBeUndefined()
    // Standard only *recommends* `default`; letting that through would shadow
    // the character's permission for every untouched session.
    expect(resolved.requestedAuthority).toBeUndefined()
  })

  it("reads the session's selection, not the app default", () => {
    useAgentRuntimeStore.setState({
      defaultComposition: { presetId: "standard" },
      sessionCompositions: { s1: { presetId: "minimal" } },
    })

    expect(resolveTurnAgentMode({ sessionId: "s1" }).preset?.id).toBe("minimal")
    expect(resolveTurnAgentMode({ sessionId: "other" }).preset?.id).toBe("standard")
  })

  it("carries a preset with no mode record behind it", () => {
    useAgentRuntimeStore.setState({ sessionCompositions: { s1: { presetId: "minimal" } } })

    const resolved = resolveTurnAgentMode({ sessionId: "s1" })

    expect(resolved.mode).toBeUndefined()
    expect(resolved.preset?.defaultToolSet).toEqual(["Read", "Glob", "Grep"])
    // Nothing else speaks for Minimal, so its recommendation is the answer.
    expect(resolved.requestedAuthority).toBe("plan")
  })

  it("resolves a custom mode selected as a preset", () => {
    seedCustomMode()
    useAgentRuntimeStore.setState({ sessionCompositions: { s1: { presetId: "my-reviewer" } } })

    const resolved = resolveTurnAgentMode({ sessionId: "s1" })

    expect(resolved.preset?.systemPromptDelta).toBe("Be exacting.")
    expect(resolved.mode?.id).toBe("my-reviewer")
    // The mode record speaks for itself downstream, so this rung stays quiet.
    expect(resolved.requestedAuthority).toBeUndefined()
  })

  it("falls back to Standard for a preset that no longer exists", () => {
    useAgentRuntimeStore.setState({ sessionCompositions: { s1: { presetId: "deleted" } } })

    expect(resolveTurnAgentMode({ sessionId: "s1" }).preset?.id).toBe("standard")
  })

  // `plan` / `build` became axis values rather than mode records.
  it("passes an explicit authority axis through", () => {
    useAgentRuntimeStore.setState({
      sessionCompositions: { s1: { presetId: "standard", authority: "plan" } },
    })

    expect(resolveTurnAgentMode({ sessionId: "s1" }).requestedAuthority).toBe("plan")
  })

  it("caps a requested authority at the preset's ceiling", () => {
    useAgentRuntimeStore.setState({
      sessionCompositions: { s1: { presetId: "minimal", authority: "bypassPermissions" } },
    })

    expect(resolveTurnAgentMode({ sessionId: "s1" }).requestedAuthority).toBe("plan")
  })

  it("leaves an authority below the ceiling alone", () => {
    useAgentRuntimeStore.setState({
      sessionCompositions: { s1: { presetId: "creator", authority: "plan" } },
    })

    expect(resolveTurnAgentMode({ sessionId: "s1" }).requestedAuthority).toBe("plan")
  })
})
