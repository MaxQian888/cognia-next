import {
  SUBAGENT_CONTRACT_TAG,
  buildSubagentContract,
  buildSubagentEnvBlock,
  composeSubagentSystemPrompt,
} from "./subagent-prompt-frame"

const NOW = Date.UTC(2026, 8, 9, 12, 0, 0)

describe("buildSubagentEnvBlock", () => {
  it("emits only the facts it was given, in a fixed order", () => {
    expect(buildSubagentEnvBlock({ cwd: "/repo", platform: "darwin", now: NOW })).toBe(
      [
        "<env>",
        "Working directory: /repo",
        "Platform: darwin",
        "Today's date: 2026-09-09",
        "</env>",
      ].join("\n")
    )
    expect(buildSubagentEnvBlock({ now: NOW })).toBe("<env>\nToday's date: 2026-09-09\n</env>")
  })

  it("emits nothing when nothing is known", () => {
    expect(buildSubagentEnvBlock({})).toBeUndefined()
    expect(buildSubagentEnvBlock({ cwd: "", now: Number.NaN })).toBeUndefined()
  })
})

describe("buildSubagentContract", () => {
  it("tells a leaf it cannot delegate and a nesting child that it may", () => {
    const leaf = buildSubagentContract({})
    expect(leaf).toContain("cannot dispatch subagents of your own")
    expect(leaf).not.toContain("dispatch_agent")
    const delegate = buildSubagentContract({ canDelegate: true })
    expect(delegate).toContain("`dispatch_agent`")
    expect(delegate).not.toContain("cannot dispatch subagents")
  })

  it("adds the working-directory rule only when a cwd is known", () => {
    expect(buildSubagentContract({ cwd: "/repo" })).toContain("Work inside the working directory")
    expect(buildSubagentContract({})).not.toContain("Work inside the working directory")
  })

  it("always states the final-message contract and the no-questions rule", () => {
    const text = buildSubagentContract({})
    expect(text).toContain("reads ONLY your final message")
    expect(text).toContain("cannot ask the dispatcher questions")
    expect(text.startsWith(`<${SUBAGENT_CONTRACT_TAG}>`)).toBe(true)
    expect(text.endsWith(`</${SUBAGENT_CONTRACT_TAG}>`)).toBe(true)
  })
})

describe("composeSubagentSystemPrompt", () => {
  it("orders identity, env, contract and separates them with blank lines", () => {
    const out = composeSubagentSystemPrompt("You are a reviewer.", { cwd: "/repo", now: NOW })
    const [identity, env, contract] = out.split("\n\n")
    expect(identity).toBe("You are a reviewer.")
    expect(env.startsWith("<env>")).toBe(true)
    expect(contract.startsWith(`<${SUBAGENT_CONTRACT_TAG}>`)).toBe(true)
  })

  it("frames an empty identity so a one-line agent file still gets the contract", () => {
    const out = composeSubagentSystemPrompt(undefined, {})
    expect(out.startsWith(`<${SUBAGENT_CONTRACT_TAG}>`)).toBe(true)
  })

  it("is idempotent: an already-framed prompt is returned unchanged", () => {
    const once = composeSubagentSystemPrompt("Identity.", { cwd: "/repo", now: NOW })
    const twice = composeSubagentSystemPrompt(once, { cwd: "/other", now: NOW + 1 })
    expect(twice).toBe(once)
  })

  it("trims stray whitespace around the identity", () => {
    expect(composeSubagentSystemPrompt("  hi \n\n", {})).toMatch(/^hi\n\n</)
  })
})
