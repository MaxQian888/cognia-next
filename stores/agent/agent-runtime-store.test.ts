/** @jest-environment jsdom */
import { act, renderHook } from "@testing-library/react"
import { compositionForSession, useAgentRuntimeStore } from "./agent-runtime-store"
import { useCustomModeStore } from "@/stores/agent/custom-mode-store"
// Touch the outer agent barrel so its `export *` lines are covered.
import * as outerAgentBarrel from "./"

it("outer agent barrel re-exports useAgentRuntimeStore", () => {
  expect(outerAgentBarrel.useAgentRuntimeStore).toBe(useAgentRuntimeStore)
})

describe("useAgentRuntimeStore", () => {
  beforeEach(() => {
    // Reset to documented defaults before each test
    useAgentRuntimeStore.setState({
      runtime: "claude-sdk",
      modeId: "general",
      externalAgentId: null,
    })
  })

  it("has the documented defaults", () => {
    const { result } = renderHook(() => useAgentRuntimeStore())
    expect(result.current.runtime).toBe("claude-sdk")
    expect(result.current.modeId).toBe("general")
    expect(result.current.externalAgentId).toBeNull()
  })

  it("setRuntime switches between claude-sdk and external", () => {
    const { result } = renderHook(() => useAgentRuntimeStore())

    act(() => result.current.setRuntime("external"))
    expect(result.current.runtime).toBe("external")

    act(() => result.current.setRuntime("claude-sdk"))
    expect(result.current.runtime).toBe("claude-sdk")
  })

  it("setModeId updates the active mode id", () => {
    const { result } = renderHook(() => useAgentRuntimeStore())

    act(() => result.current.setModeId("research"))
    expect(result.current.modeId).toBe("research")
  })

  it("setExternalAgentId accepts a string and null (clear)", () => {
    const { result } = renderHook(() => useAgentRuntimeStore())

    act(() => result.current.setExternalAgentId("agent-42"))
    expect(result.current.externalAgentId).toBe("agent-42")

    act(() => result.current.setExternalAgentId(null))
    expect(result.current.externalAgentId).toBeNull()
  })

  it("persists under the documented localStorage key", () => {
    // Trigger a state change to flush the persist middleware
    act(() => useAgentRuntimeStore.getState().setModeId("persisted-mode"))

    // The persist middleware writes synchronously to localStorage on set.
    const stored = window.localStorage.getItem("cognia-next.agent-runtime")
    expect(stored).not.toBeNull()
    const parsed = JSON.parse(stored as string)
    expect(parsed.state.modeId).toBe("persisted-mode")
    // v2 (ADR-0117): the persisted shape gained `defaultComposition` and
    // per-session selections; `modeId` stays as the compatibility adapter.
    expect(parsed.version).toBe(2)
  })

  it("keeps the legacy mode id and the default composition in step", () => {
    act(() => useAgentRuntimeStore.getState().setModeId("research"))
    expect(useAgentRuntimeStore.getState().defaultComposition.presetId).toBe("research")

    act(() => useAgentRuntimeStore.getState().setDefaultComposition({ presetId: "minimal" }))
    // An unmigrated reader of `modeId` must not see a stale preset.
    expect(useAgentRuntimeStore.getState().modeId).toBe("minimal")
  })

  it("maps a legacy permission mode onto the authority axis", () => {
    act(() => useAgentRuntimeStore.getState().setModeId("build"))
    const composition = useAgentRuntimeStore.getState().defaultComposition
    expect(composition.presetId).toBe("standard")
    expect(composition.authority).toBe("acceptEdits")
  })

  it("round-trips an axis mode without collapsing it to its preset", () => {
    // `plan` maps to `{presetId: "standard", authority: "plan"}`, so mirroring
    // `presetId` back onto `modeId` answered "standard" for a composition that
    // is still Plan. `resolveActiveAgentMode` has no `standard` record, so the
    // legacy send path silently lost plan-mode behaviour.
    act(() => useAgentRuntimeStore.getState().setModeId("plan"))
    const composition = useAgentRuntimeStore.getState().defaultComposition
    expect(composition.authority).toBe("plan")

    act(() => useAgentRuntimeStore.getState().setDefaultComposition(composition))
    expect(useAgentRuntimeStore.getState().modeId).toBe("plan")
    expect(useAgentRuntimeStore.getState().defaultComposition.authority).toBe("plan")
  })

  it("still mirrors the preset when a selection carries no legacy id", () => {
    act(() => useAgentRuntimeStore.getState().setDefaultComposition({ presetId: "minimal" }))
    expect(useAgentRuntimeStore.getState().modeId).toBe("minimal")
  })

  it("never elevates an unknown legacy mode", () => {
    act(() => useAgentRuntimeStore.getState().setModeId("mystery-mode"))
    expect(useAgentRuntimeStore.getState().defaultComposition.authority).toBe("default")
  })

  // Regression: the known-id set used to be the built-in catalog only, so every
  // user-authored mode looked like an unrecognised legacy id and collapsed to
  // Standard. The composer showed the custom mode, the settings sheet showed
  // Standard, and the recorded composition agreed with neither.
  it("keeps a user's custom mode as the preset instead of degrading it", () => {
    useCustomModeStore.setState({
      customModes: {
        "my-reviewer": {
          id: "my-reviewer",
          type: "custom",
          name: "My Reviewer",
          description: "Reviews things",
          icon: "Sparkles",
          isBuiltIn: false,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        },
      } as never,
    })

    act(() => useAgentRuntimeStore.getState().setModeId("my-reviewer"))

    expect(useAgentRuntimeStore.getState().defaultComposition.presetId).toBe("my-reviewer")
    expect(useAgentRuntimeStore.getState().modeId).toBe("my-reviewer")

    useCustomModeStore.setState({ customModes: {} })
  })

  it("scopes a composition to one session without touching the default", () => {
    const store = useAgentRuntimeStore.getState()
    act(() => store.setDefaultComposition({ presetId: "standard" }))
    act(() => store.setSessionComposition("s1", { presetId: "minimal" }))

    expect(compositionForSession("s1").presetId).toBe("minimal")
    // The whole point of per-session scoping: another session is unaffected.
    expect(compositionForSession("s2").presetId).toBe("standard")
    expect(useAgentRuntimeStore.getState().defaultComposition.presetId).toBe("standard")
  })

  it("falls back to the default once a session selection is cleared", () => {
    const store = useAgentRuntimeStore.getState()
    act(() => store.setSessionComposition("s1", { presetId: "minimal" }))
    act(() => store.clearSessionComposition("s1"))
    expect(compositionForSession("s1").presetId).toBe(
      useAgentRuntimeStore.getState().defaultComposition.presetId
    )
  })

  it("treats an unknown session as the default", () => {
    expect(compositionForSession(undefined).presetId).toBe(
      useAgentRuntimeStore.getState().defaultComposition.presetId
    )
  })
})

describe("the two external lanes are mutually exclusive", () => {
  beforeEach(() => {
    useAgentRuntimeStore.setState({ externalAgentId: null, externalHostConfig: null })
  })

  const selection = {
    configId: "eac_1",
    revision: "eacr_1",
    lifecycleGeneration: 1,
    name: "Pi",
  }

  it("selecting a host config drops a local agent", () => {
    useAgentRuntimeStore.getState().setExternalAgentId("local-1")
    useAgentRuntimeStore.getState().setExternalHostConfig(selection)
    expect(useAgentRuntimeStore.getState().externalAgentId).toBeNull()
    expect(useAgentRuntimeStore.getState().externalHostConfig).toEqual(selection)
  })

  it("selecting a local agent drops a host config", () => {
    useAgentRuntimeStore.getState().setExternalHostConfig(selection)
    useAgentRuntimeStore.getState().setExternalAgentId("local-1")
    expect(useAgentRuntimeStore.getState().externalHostConfig).toBeNull()
    expect(useAgentRuntimeStore.getState().externalAgentId).toBe("local-1")
  })

  // Clearing one lane must not clear the other: "no local agent" is not the
  // same statement as "no agent anywhere".
  it("clearing one lane leaves the other alone", () => {
    useAgentRuntimeStore.getState().setExternalHostConfig(selection)
    useAgentRuntimeStore.getState().setExternalAgentId(null)
    expect(useAgentRuntimeStore.getState().externalHostConfig).toEqual(selection)
  })

  it("clearing the host config leaves a local agent alone", () => {
    useAgentRuntimeStore.getState().setExternalAgentId("local-1")
    useAgentRuntimeStore.getState().setExternalHostConfig(null)
    expect(useAgentRuntimeStore.getState().externalAgentId).toBe("local-1")
  })
})
