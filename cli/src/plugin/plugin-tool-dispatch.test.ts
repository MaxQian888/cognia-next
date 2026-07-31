/**
 * @jest-environment node
 */
import { subscribePluginToolDispatch } from "./plugin-tool-dispatch"
import type { PluginToolExecRequest, PluginToolExecResponse } from "@/lib/claude/plugin-tool-ipc"

const req: PluginToolExecRequest = {
  type: "plugin_tool_exec",
  sessionId: "s1",
  toolUseId: "t1",
  name: "web_fetch",
  args: { url: "https://example.com" },
}

describe("subscribePluginToolDispatch", () => {
  it("runs each plugin_tool_exec event through the executor and sends the response", async () => {
    let handler: ((r: PluginToolExecRequest) => void) | null = null
    const sent: PluginToolExecResponse[] = []
    const unsub = jest.fn()

    const ret = await subscribePluginToolDispatch({
      subscribe: async (h) => {
        handler = h as (r: PluginToolExecRequest) => void
        return unsub
      },
      handle: async (r) => ({
        type: "plugin_tool_response",
        sessionId: r.sessionId,
        toolUseId: r.toolUseId,
        result: { ok: true },
      }),
      send: async (resp) => void sent.push(resp),
    })

    expect(ret).toBe(unsub)
    // Fire an event; the executor result must be sent back.
    handler!(req)
    await new Promise((r) => setImmediate(r))
    expect(sent).toEqual([
      { type: "plugin_tool_response", sessionId: "s1", toolUseId: "t1", result: { ok: true } },
    ])
  })

  it("returns the unsubscribe fn from the transport", async () => {
    const unsub = jest.fn()
    const ret = await subscribePluginToolDispatch({
      subscribe: async () => unsub,
      handle: async () => ({ type: "plugin_tool_response", sessionId: "x", toolUseId: "y" }),
      send: async () => {},
    })
    expect(ret).toBe(unsub)
  })
})
