import {
  parseSpawnTaskArgs,
  renderSpawnedTaskPrompt,
  SPAWN_TASK_JSON_SCHEMA,
  spawnTaskModelReply,
} from "./spawn-task-core"

const valid = {
  title: "Fix stale cache invalidation",
  tldr: "Repair a cache invalidation bug found while working on auth.",
  situation: "The cache survives a credential rotation and serves stale data.",
  code_locations: ["lib/cache/credentials.ts:42"],
  solution: "Invalidate the credential cache after every successful rotation.",
  caveats: ["Do not change the token persistence format."],
}

describe("spawn-task core", () => {
  it("publishes a closed schema with all brief fields", () => {
    expect(SPAWN_TASK_JSON_SCHEMA).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["title", "tldr", "situation", "code_locations", "solution", "caveats"],
    })
  })

  it("parses a self-contained brief and defaults to aside mode", () => {
    expect(parseSpawnTaskArgs(valid)).toEqual({
      title: valid.title,
      tldr: valid.tldr,
      situation: valid.situation,
      codeLocations: valid.code_locations,
      solution: valid.solution,
      caveats: valid.caveats,
      mode: "aside",
    })
  })

  it.each([
    [{ ...valid, title: "" }, "title"],
    [{ ...valid, mode: "background" }, "mode"],
    [{ ...valid, code_locations: "lib/file.ts" }, "code_locations"],
    [{ ...valid, title: "x".repeat(61) }, "60"],
  ])("rejects invalid arguments", (args, message) => {
    expect(parseSpawnTaskArgs(args)).toMatchObject({ error: expect.stringContaining(message) })
  })

  it("renders a stable four-section handoff prompt", () => {
    const parsed = parseSpawnTaskArgs(valid)
    if ("error" in parsed) throw new Error(parsed.error)
    const prompt = renderSpawnedTaskPrompt(parsed)
    const headings = ["## Situation", "## Code locations", "## Proposed solution", "## Caveats"]
    expect(headings.map((heading) => prompt.indexOf(heading))).toEqual(
      expect.arrayContaining(headings.map(() => expect.any(Number)))
    )
    expect(prompt.indexOf(headings[0])).toBeLessThan(prompt.indexOf(headings[1]))
    expect(prompt.indexOf(headings[1])).toBeLessThan(prompt.indexOf(headings[2]))
    expect(prompt.indexOf(headings[2])).toBeLessThan(prompt.indexOf(headings[3]))
  })

  it("renders explicit placeholders when no locations or caveats are known", () => {
    const parsed = parseSpawnTaskArgs({ ...valid, code_locations: [], caveats: [] })
    if ("error" in parsed) throw new Error(parsed.error)

    expect(renderSpawnedTaskPrompt(parsed)).toContain("## Code locations\n\n- None identified")
    expect(renderSpawnedTaskPrompt(parsed)).toContain("## Caveats\n\n- None")
  })

  it("tells the model to leave the task for the user-started sidechat", () => {
    const parsed = parseSpawnTaskArgs(valid)
    if ("error" in parsed) throw new Error(parsed.error)
    expect(spawnTaskModelReply({ taskSessionId: "task-1", brief: parsed })).toMatchObject({
      ok: true,
      taskSessionId: "task-1",
      instruction: expect.stringMatching(/do not continue/i),
    })
  })
})
