import {
  diffLaunchSpec,
  hasLaunchSpec,
  launchSpecMatches,
  launchSpecSeed,
  type ChatTemplateLaunchSpec,
  type LaunchSpecSubject,
} from "./launch-spec"

const session = (overrides: Partial<LaunchSpecSubject> = {}): LaunchSpecSubject => ({
  model: undefined,
  permissionMode: undefined,
  systemPrompt: undefined,
  workingDir: undefined,
  characterId: undefined,
  squadId: undefined,
  ...overrides,
})

describe("diffLaunchSpec", () => {
  it("reports nothing when the template asks for nothing", () => {
    expect(diffLaunchSpec(undefined, session())).toEqual([])
    expect(diffLaunchSpec({}, session({ model: "opus" }))).toEqual([])
  })

  it("does not propose a change that would be a no-op", () => {
    // A bar that warns about changes that are not changes is one people learn
    // to dismiss without reading.
    expect(diffLaunchSpec({ model: "opus" }, session({ model: "opus" }))).toEqual([])
  })

  it("reports what it would set and what it would replace", () => {
    const spec: ChatTemplateLaunchSpec = { model: "opus", characterId: "c_reviewer" }

    expect(diffLaunchSpec(spec, session({ model: "sonnet" }))).toEqual([
      { field: "characterId", wanted: "c_reviewer" },
      { field: "model", wanted: "opus", current: "sonnet" },
    ])
  })

  it("omits `current` when the session has nothing there", () => {
    const [diff] = diffLaunchSpec({ squadId: "sq_1" }, session())

    expect(diff).toEqual({ field: "squadId", wanted: "sq_1" })
  })

  it("reads the workspace through its projectId", () => {
    const spec: ChatTemplateLaunchSpec = { workspace: { projectId: "p_a", gitRemote: "git@x:y" } }

    expect(diffLaunchSpec(spec, session({ projectId: "p_b" }))).toEqual([
      { field: "projectId", wanted: "p_a", current: "p_b" },
    ])
  })

  it("treats a blank string as asking for nothing", () => {
    expect(diffLaunchSpec({ model: "   " }, session({ model: "opus" }))).toEqual([])
  })
})

describe("launchSpecMatches", () => {
  it("is true when nothing would change", () => {
    expect(launchSpecMatches({ model: "opus" }, session({ model: "opus" }))).toBe(true)
  })

  it("is false when something would", () => {
    expect(launchSpecMatches({ model: "opus" }, session({ model: "sonnet" }))).toBe(false)
  })
})

describe("hasLaunchSpec", () => {
  it("is false for absent, empty, and all-blank specs", () => {
    expect(hasLaunchSpec(undefined)).toBe(false)
    expect(hasLaunchSpec({})).toBe(false)
    expect(hasLaunchSpec({ model: "", allowedTools: [], workspace: {} })).toBe(false)
  })

  it("is true once anything is set, including a nested workspace field", () => {
    expect(hasLaunchSpec({ characterId: "c_1" })).toBe(true)
    expect(hasLaunchSpec({ allowedTools: ["Read"] })).toBe(true)
    expect(hasLaunchSpec({ workspace: { gitRemote: "git@x:y" } })).toBe(true)
  })
})

describe("launchSpecSeed", () => {
  it("carries only what startNewSession actually persists", () => {
    const spec: ChatTemplateLaunchSpec = {
      model: "opus",
      characterId: "c_1",
      squadId: "sq_1",
      workspace: { projectId: "p_1", gitRemote: "git@x:y" },
      // These live on the character / agent-mode store, not the session row.
      allowedTools: ["Read"],
      skillIds: ["s_1"],
      agentModeId: "m_1",
    }

    expect(launchSpecSeed(spec)).toEqual({
      model: "opus",
      characterId: "c_1",
      squadId: "sq_1",
      projectId: "p_1",
    })
  })

  it("is empty for an absent spec", () => {
    expect(launchSpecSeed(undefined)).toEqual({})
  })
})
