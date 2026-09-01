/** @jest-environment jsdom */
import { act, renderHook } from "@testing-library/react"
import { compositionForSession, useAgentRuntimeStore } from "./agent-runtime-store"
import { BUILTIN_RUNTIME_REF } from "@/lib/ai/agent/runtime-catalog/types"
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
      runtimeRef: BUILTIN_RUNTIME_REF,
      runtime: "claude-sdk",
      modeId: "general",
      externalAgentId: null,
      externalHostConfig: null,
    })
  })

  it("has the documented defaults", () => {
    const { result } = renderHook(() => useAgentRuntimeStore())
    expect(result.current.runtimeRef).toEqual({ kind: "builtin" })
    expect(result.current.runtime).toBe("claude-sdk")
    expect(result.current.modeId).toBe("general")
    expect(result.current.externalAgentId).toBeNull()
  })

  it("setRuntimeRef switches lanes and keeps every deprecated mirror in step", () => {
    const { result } = renderHook(() => useAgentRuntimeStore())

    act(() => result.current.setRuntimeRef({ kind: "external", agentId: "agent-42" }))
    expect(result.current.runtime).toBe("external")
    expect(result.current.externalAgentId).toBe("agent-42")
    expect(result.current.externalHostConfig).toBeNull()

    act(() => result.current.setRuntimeRef(BUILTIN_RUNTIME_REF))
    expect(result.current.runtime).toBe("claude-sdk")
    expect(result.current.externalAgentId).toBeNull()
  })

  it("setModeId updates the active mode id", () => {
    const { result } = renderHook(() => useAgentRuntimeStore())

    act(() => result.current.setModeId("research"))
    expect(result.current.modeId).toBe("research")
  })

  it("a host ref mirrors the full admission stamp", () => {
    const { result } = renderHook(() => useAgentRuntimeStore())

    act(() =>
      result.current.setRuntimeRef({
        kind: "host",
        configId: "eac_1",
        revision: "eacr_1",
        lifecycleGeneration: 2,
        name: "Pi",
      })
    )
    expect(result.current.runtime).toBe("external")
    expect(result.current.externalAgentId).toBeNull()
    expect(result.current.externalHostConfig).toEqual({
      configId: "eac_1",
      revision: "eacr_1",
      lifecycleGeneration: 2,
      name: "Pi",
    })
  })

  it("persists under the documented localStorage key", () => {
    // Trigger a state change to flush the persist middleware
    act(() => useAgentRuntimeStore.getState().setModeId("persisted-mode"))

    // The persist middleware writes synchronously to localStorage on set.
    const stored = window.localStorage.getItem("cognia-next.agent-runtime")
    expect(stored).not.toBeNull()
    const parsed = JSON.parse(stored as string)
    expect(parsed.state.modeId).toBe("persisted-mode")
    // v2 (ADR-0117) gained `defaultComposition` and per-session selections,
    // with `modeId` left as the compatibility adapter. v3 folded the three lane
    // fields into one `runtimeRef` and left them as deprecated mirrors.
    expect(parsed.version).toBe(3)
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

describe("v2 to v3 migration", () => {
  // The migration is exercised through the persist middleware's own entry
  // point rather than by reaching into the store, so what is tested is the
  // path a real upgrade takes.
  const migrate = useAgentRuntimeStore.persist.getOptions().migrate as (
    persisted: unknown,
    version: number
  ) => { runtimeRef: unknown; runtime: string; externalAgentId: string | null }

  it("folds a local external selection into one ref", () => {
    const next = migrate(
      { runtime: "external", externalAgentId: "a1", externalHostConfig: null },
      2
    )
    expect(next.runtimeRef).toEqual({ kind: "external", agentId: "a1" })
  })

  it("prefers the host stamp when a half-applied v2 write left both set", () => {
    const next = migrate(
      {
        runtime: "external",
        externalAgentId: "a1",
        externalHostConfig: {
          configId: "eac_1",
          revision: "eacr_1",
          lifecycleGeneration: 3,
          name: "Pi",
        },
      },
      2
    )
    expect(next.runtimeRef).toEqual({
      kind: "host",
      configId: "eac_1",
      revision: "eacr_1",
      lifecycleGeneration: 3,
      name: "Pi",
    })
  })

  it("drops v2's dead 'external with no target' state to the default lane", () => {
    // That state could not send a turn. Carrying it forward would only
    // reproduce the chip's "External (none selected)" dead end.
    const next = migrate(
      { runtime: "external", externalAgentId: null, externalHostConfig: null },
      2
    )
    expect(next.runtimeRef).toEqual({ kind: "builtin" })
    expect(next.runtime).toBe("claude-sdk")
  })

  it("leaves a v2 builtin selection on the default lane", () => {
    expect(migrate({ runtime: "claude-sdk" }, 2).runtimeRef).toEqual({ kind: "builtin" })
  })
})

describe("the lanes are exclusive by construction", () => {
  // These used to be four tests policing that three separate fields stayed in
  // agreement. One ref cannot disagree with itself, so what is left to check is
  // that each lane's mirrors are complete and that the others are cleared.
  beforeEach(() => {
    useAgentRuntimeStore.getState().setRuntimeRef(BUILTIN_RUNTIME_REF)
  })

  const hostRef = {
    kind: "host",
    configId: "eac_1",
    revision: "eacr_1",
    lifecycleGeneration: 1,
    name: "Pi",
  } as const

  it("a host selection leaves no local agent behind", () => {
    useAgentRuntimeStore.getState().setRuntimeRef({ kind: "external", agentId: "local-1" })
    useAgentRuntimeStore.getState().setRuntimeRef(hostRef)
    expect(useAgentRuntimeStore.getState().externalAgentId).toBeNull()
    expect(useAgentRuntimeStore.getState().runtimeRef).toEqual(hostRef)
  })

  it("a local selection leaves no host config behind", () => {
    useAgentRuntimeStore.getState().setRuntimeRef(hostRef)
    useAgentRuntimeStore.getState().setRuntimeRef({ kind: "external", agentId: "local-1" })
    expect(useAgentRuntimeStore.getState().externalHostConfig).toBeNull()
    expect(useAgentRuntimeStore.getState().externalAgentId).toBe("local-1")
  })

  it("returning to the builtin lane clears both targets", () => {
    useAgentRuntimeStore.getState().setRuntimeRef(hostRef)
    useAgentRuntimeStore.getState().setRuntimeRef(BUILTIN_RUNTIME_REF)
    expect(useAgentRuntimeStore.getState().externalHostConfig).toBeNull()
    expect(useAgentRuntimeStore.getState().externalAgentId).toBeNull()
  })
})
