import { claudeCodeManifest, CLAUDE_CODE_RUNTIMES, CLAUDE_CODE_SESSION_SOURCE_ID } from "./manifest"

describe("Claude Code manifest", () => {
  it("owns one runtime row per declared runtime and no protocol", () => {
    expect(claudeCodeManifest.protocols).toEqual([])
    expect(CLAUDE_CODE_RUNTIMES.map((row) => row.runtimeId)).toEqual([
      ...claudeCodeManifest.ecosystem.runtimeIds,
    ])
    expect(CLAUDE_CODE_RUNTIMES[0]).toMatchObject({ protocol: "acp", presetIds: ["claude-code"] })
    expect(claudeCodeManifest.ecosystem.sessionSourceIds).toEqual([CLAUDE_CODE_SESSION_SOURCE_ID])
    expect(Object.isFrozen(claudeCodeManifest)).toBe(true)
  })
})
