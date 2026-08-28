/** @jest-environment node */
import { DEFAULT_RESOLVED_CONFIG } from "../config/schema"
import { makeConfiguredCliPluginToolHandle } from "./configured-plugin-tool-handle"
import type {
  PluginToolExecHostDeps,
  PluginToolExecRequest,
  PluginToolExecResponse,
} from "@/lib/claude/plugin-tool-ipc"

describe("makeConfiguredCliPluginToolHandle", () => {
  it("injects the resolved CLI search configuration into the shared executor", async () => {
    const execute = jest.fn<
      Promise<PluginToolExecResponse>,
      [PluginToolExecRequest, PluginToolExecHostDeps?]
    >(async (request, hostDeps) => ({
      type: "plugin_tool_response" as const,
      sessionId: request.sessionId,
      toolUseId: request.toolUseId,
      result: await hostDeps?.resolveWebToolDeps?.(),
    }))
    const handle = makeConfiguredCliPluginToolHandle(
      {
        ...DEFAULT_RESOLVED_CONFIG,
        cwd: "/tmp/cognia-cli-test",
        search: {
          defaultProvider: "brave",
          providers: {
            brave: { apiKey: "cli-key", enabled: true, priority: 1 },
          },
        },
      },
      execute
    )

    const response = await handle({
      type: "plugin_tool_exec",
      sessionId: "s1",
      toolUseId: "w1",
      name: "web_search",
      args: { query: "Cognia" },
    })

    // Provider settings are no longer copied onto the tool deps — they ride
    // inside the executor's own settings snapshot — so the observable contract
    // is that the CLI config produced a bound executor.
    expect(response.result).toMatchObject({ enabled: true })
    expect((response.result as { searchExecutor?: unknown })?.searchExecutor).toEqual(
      expect.any(Function)
    )
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it("carries no per-plugin host dependencies", async () => {
    // The CLI used to hand one named plugin its own model bridge here. Every
    // plugin now reaches the model through `ctx.ai` and the session's host
    // runtime, so the only host dep left is the shared web policy.
    const execute = jest.fn<
      Promise<PluginToolExecResponse>,
      [PluginToolExecRequest, PluginToolExecHostDeps?]
    >(async (request) => ({
      type: "plugin_tool_response" as const,
      sessionId: request.sessionId,
      toolUseId: request.toolUseId,
      result: null,
    }))
    const handle = makeConfiguredCliPluginToolHandle(
      { ...DEFAULT_RESOLVED_CONFIG, cwd: "/tmp/cognia-cli-test" },
      execute
    )

    await handle({
      type: "plugin_tool_exec",
      sessionId: "s-deep",
      toolUseId: "w-deep",
      name: "deep_research",
      args: { query: "Cognia" },
    })

    expect(Object.keys(execute.mock.calls[0]?.[1] ?? {})).toEqual(["resolveWebToolDeps"])
  })
})
