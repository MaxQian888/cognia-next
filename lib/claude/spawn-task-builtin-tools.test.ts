import {
  buildSpawnTaskManifestEntries,
  isSpawnTaskBuiltinTool,
  runSpawnTaskBuiltinTool,
  type SpawnTaskToolRunDeps,
} from "./spawn-task-builtin-tools"

const args = {
  title: "Fix retry cleanup",
  tldr: "Handle the cleanup separately.",
  situation: "A completed request retains its abort controller.",
  code_locations: ["hooks/chat/use-stream.ts:42"],
  solution: "Clear it on the terminal event.",
  caveats: ["Preserve retries."],
  mode: "inherit",
}

function deps(overrides: Partial<SpawnTaskToolRunDeps> = {}): SpawnTaskToolRunDeps {
  return {
    gate: jest.fn(() => true),
    dispatch: jest.fn(async (_sessionId, brief) => ({
      ok: true,
      taskSessionId: "task-1",
      ...brief,
    })),
    ...overrides,
  }
}

describe("spawn-task-builtin-tools", () => {
  it("exposes one strict spawn_task manifest entry", () => {
    const entries = buildSpawnTaskManifestEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      name: "spawn_task",
      pluginId: "cognia-spawn-task-builtin",
      jsonSchema: expect.objectContaining({ additionalProperties: false }),
    })
    expect(isSpawnTaskBuiltinTool("spawn_task")).toBe(true)
    expect(isSpawnTaskBuiltinTool("dispatch_agent")).toBe(false)
  })

  it("validates and dispatches against the calling session", async () => {
    const d = deps()
    await expect(
      runSpawnTaskBuiltinTool("spawn_task", args, d, { sessionId: "parent-1" })
    ).resolves.toMatchObject({ ok: true, taskSessionId: "task-1", mode: "inherit" })
    expect(d.dispatch).toHaveBeenCalledWith(
      "parent-1",
      expect.objectContaining({ title: args.title, codeLocations: args.code_locations })
    )
  })

  it("runs the PII gate before any dispatch", async () => {
    const d = deps({ gate: jest.fn(() => false) })
    await expect(
      runSpawnTaskBuiltinTool("spawn_task", { ...args, tldr: "email me@example.com" }, d, {
        sessionId: "parent-1",
      })
    ).resolves.toEqual({ ok: false, error: "Spawned task blocked by the PII redaction gate" })
    expect(d.dispatch).not.toHaveBeenCalled()
  })

  it("returns structured errors for invalid input, unknown names, and missing dependencies", async () => {
    await expect(
      runSpawnTaskBuiltinTool("spawn_task", { ...args, title: "" }, deps(), {
        sessionId: "parent-1",
      })
    ).resolves.toEqual({ ok: false, error: "title must be a non-empty string" })
    await expect(
      runSpawnTaskBuiltinTool("unknown", args, deps(), { sessionId: "parent-1" })
    ).resolves.toEqual({ ok: false, error: "unknown spawn task tool: unknown" })
    await expect(
      runSpawnTaskBuiltinTool("spawn_task", args, undefined, { sessionId: "parent-1" })
    ).resolves.toEqual({ ok: false, error: "spawn_task host dependencies are unavailable" })
  })
})
