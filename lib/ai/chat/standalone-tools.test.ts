/**
 * @jest-environment jsdom
 */
import type { SendOptions } from "@cognia/agent-config-types"

const handlePluginToolExec = jest.fn()
jest.mock("@/lib/claude/plugin-tool-ipc", () => ({
  handlePluginToolExec: (...args: unknown[]) => handlePluginToolExec(...args),
}))

import {
  buildStandaloneTools,
  isUsableStandaloneToolName,
  STANDALONE_MAX_STEPS,
} from "./standalone-tools"

type Manifest = NonNullable<SendOptions["pluginTools"]>

const entry = (name: string, overrides: Partial<Manifest[number]> = {}): Manifest[number] => ({
  name,
  description: `${name} description`,
  jsonSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
  pluginId: "cognia-web-builtin",
  ...overrides,
})

/** AI SDK passes `(input, options)`; only `toolCallId` matters here. */
const runTool = (tool: unknown, args: Record<string, unknown>, toolCallId = "call-1") =>
  (
    tool as {
      execute: (a: unknown, o: { toolCallId: string }) => Promise<unknown>
    }
  ).execute(args, { toolCallId })

beforeEach(() => {
  handlePluginToolExec.mockReset()
})

describe("isUsableStandaloneToolName", () => {
  it.each(["web_search", "web-fetch", "Tool123", "a".repeat(128)])("accepts %s", (name) => {
    expect(isUsableStandaloneToolName(name)).toBe(true)
  })

  it.each(["", "has space", "dots.in.name", "emoji🙂", "a".repeat(129)])("rejects %s", (name) => {
    expect(isUsableStandaloneToolName(name)).toBe(false)
  })
})

describe("buildStandaloneTools", () => {
  it("returns undefined when the turn carries no tool manifest", () => {
    expect(buildStandaloneTools({}, "s1")).toBeUndefined()
    expect(buildStandaloneTools({ pluginTools: [] }, "s1")).toBeUndefined()
  })

  it("projects each manifest entry onto a described AI SDK tool", () => {
    const result = buildStandaloneTools(
      { pluginTools: [entry("web_search"), entry("web_fetch")] },
      "s1"
    )

    expect(Object.keys(result!.tools)).toEqual(["web_search", "web_fetch"])
    expect(result!.rejected).toEqual([])
    expect((result!.tools.web_search as { description?: string }).description).toBe(
      "web_search description"
    )
  })

  it("drops provider-invalid names instead of failing the whole turn", () => {
    const result = buildStandaloneTools(
      { pluginTools: [entry("bad name"), entry("web_search")] },
      "s1"
    )

    expect(Object.keys(result!.tools)).toEqual(["web_search"])
    expect(result!.rejected).toEqual(["bad name"])
  })

  it("returns undefined when every entry was rejected", () => {
    expect(buildStandaloneTools({ pluginTools: [entry("bad name")] }, "s1")).toBeUndefined()
  })

  it("keeps the first registration when a name is duplicated", () => {
    const result = buildStandaloneTools(
      {
        pluginTools: [
          entry("web_search", { description: "builtin" }),
          entry("web_search", { description: "plugin duplicate" }),
        ],
      },
      "s1"
    )

    expect(Object.keys(result!.tools)).toHaveLength(1)
    expect((result!.tools.web_search as { description?: string }).description).toBe("builtin")
  })

  it("executes through the renderer tool handler with the session + call id", async () => {
    handlePluginToolExec.mockResolvedValue({
      type: "plugin_tool_response",
      sessionId: "s1",
      toolUseId: "call-9",
      result: { hits: 3 },
    })

    const result = buildStandaloneTools({ pluginTools: [entry("web_search")] }, "s1")
    await expect(runTool(result!.tools.web_search, { q: "cognia" }, "call-9")).resolves.toEqual({
      hits: 3,
    })

    expect(handlePluginToolExec).toHaveBeenCalledWith({
      type: "plugin_tool_exec",
      sessionId: "s1",
      toolUseId: "call-9",
      name: "web_search",
      args: { q: "cognia" },
    })
  })

  it("projects spawn_task through the same renderer executor", async () => {
    handlePluginToolExec.mockResolvedValue({ result: { ok: true, taskSessionId: "task-1" } })
    const result = buildStandaloneTools({ pluginTools: [entry("spawn_task")] }, "parent-1")

    await expect(runTool(result!.tools.spawn_task, { title: "Fix cleanup" })).resolves.toEqual({
      ok: true,
      taskSessionId: "task-1",
    })
    expect(handlePluginToolExec).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "parent-1", name: "spawn_task" })
    )
  })

  it("normalises missing args to an empty object", async () => {
    handlePluginToolExec.mockResolvedValue({ result: "ok" })
    const result = buildStandaloneTools({ pluginTools: [entry("web_search")] }, "s1")

    await runTool(result!.tools.web_search, undefined as unknown as Record<string, unknown>)

    expect(handlePluginToolExec.mock.calls[0][0].args).toEqual({})
  })

  it("rethrows a handler error so the SDK emits a tool-error part", async () => {
    handlePluginToolExec.mockResolvedValue({ error: "blocked by the PII redaction gate" })
    const result = buildStandaloneTools({ pluginTools: [entry("web_search")] }, "s1")

    await expect(runTool(result!.tools.web_search, { q: "x" })).rejects.toThrow(
      "blocked by the PII redaction gate"
    )
  })

  it("bounds the loop so a mis-prompted model cannot run away", () => {
    expect(STANDALONE_MAX_STEPS).toBeGreaterThan(1)
    expect(STANDALONE_MAX_STEPS).toBeLessThanOrEqual(16)
  })
})
