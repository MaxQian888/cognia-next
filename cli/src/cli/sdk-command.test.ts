import { parseArgv } from "./args"
import type { OutputSink } from "./output"
import { sdkCommand, type SdkCommandDeps } from "./sdk-command"

function setup(overrides: Partial<SdkCommandDeps> = {}) {
  const stdout: string[] = []
  const stderr: string[] = []
  const json: unknown[] = []
  const out: OutputSink = {
    write: (value) => stdout.push(value),
    error: (value) => stderr.push(value),
    json: (value) => json.push(value),
  }
  const shutdown = jest.fn(async () => undefined)
  const deps: SdkCommandDeps = {
    out,
    buildSnapshot: jest.fn(
      () => ({ counts: { native: 34, equivalent: 0, unsupported: 6, total: 40 } }) as never
    ),
    bootstrap: jest.fn(async () => ({ shutdown })),
    api: {
      list: jest.fn(async () => [{ sessionId: "s1", summary: "One" }]),
      info: jest.fn(async () => ({ sessionId: "s1" })),
      messages: jest.fn(async () => [{ type: "user" }]),
      subagents: jest.fn(async () => [{ agentId: "agent-1" }]),
      subagentMessages: jest.fn(async () => [{ type: "assistant" }]),
      rename: jest.fn(async () => undefined),
      tag: jest.fn(async () => undefined),
      delete: jest.fn(async () => undefined),
      fork: jest.fn(async () => ({ sessionId: "s2" })),
      settings: jest.fn(async () => ({ model: "opus" })),
    },
    ...overrides,
  }
  return { deps, stdout, stderr, json, shutdown }
}

describe("sdkCommand", () => {
  it("prints the shared capability snapshot without starting the sidecar", async () => {
    const state = setup()
    expect(await sdkCommand(parseArgv(["sdk", "capabilities", "--json"]), state.deps)).toBe(0)
    expect(state.json[0]).toMatchObject({ counts: { total: 40 } })
    expect(state.deps.bootstrap).not.toHaveBeenCalled()
  })

  it("lists native sessions through a scoped sidecar", async () => {
    const state = setup()
    expect(await sdkCommand(parseArgv(["sdk", "sessions", "--json"]), state.deps)).toBe(0)
    expect(state.deps.api!.list).toHaveBeenCalled()
    expect(state.json[0]).toEqual([{ sessionId: "s1", summary: "One" }])
    expect(state.shutdown).toHaveBeenCalled()
  })

  it("refuses transcript deletion without explicit confirmation", async () => {
    const state = setup()
    expect(await sdkCommand(parseArgv(["sdk", "delete", "--session", "s1"]), state.deps)).toBe(2)
    expect(state.deps.api!.delete).not.toHaveBeenCalled()
    expect(state.stderr.join("")).toMatch(/--confirm/)
  })

  it("renames a native session and always shuts down the sidecar", async () => {
    const state = setup()
    expect(
      await sdkCommand(
        parseArgv(["sdk", "rename", "--session", "s1", "--title", "New title"]),
        state.deps
      )
    ).toBe(0)
    expect(state.deps.api!.rename).toHaveBeenCalledWith("s1", "New title")
    expect(state.shutdown).toHaveBeenCalled()
  })

  it("lists subagents and reads one subagent transcript", async () => {
    const state = setup()
    expect(
      await sdkCommand(parseArgv(["sdk", "subagents", "--session", "s1", "--json"]), state.deps)
    ).toBe(0)
    expect(state.deps.api!.subagents).toHaveBeenCalledWith("s1")

    expect(
      await sdkCommand(
        parseArgv(["sdk", "subagent-messages", "--session", "s1", "--agent", "agent-1", "--json"]),
        state.deps
      )
    ).toBe(0)
    expect(state.deps.api!.subagentMessages).toHaveBeenCalledWith("s1", "agent-1")
  })

  it("requires an agent id before reading a subagent transcript", async () => {
    const state = setup()
    expect(
      await sdkCommand(parseArgv(["sdk", "subagent-messages", "--session", "s1"]), state.deps)
    ).toBe(2)
    expect(state.deps.api!.subagentMessages).not.toHaveBeenCalled()
    expect(state.stderr.join("")).toMatch(/--agent/)
  })
})
