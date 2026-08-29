/**
 * Coverage for the CLI-bridge renderer request source: listener install,
 * command dispatch, and the response envelope posted back through the
 * `cli_bridge_renderer_response` Tauri command.
 */

const twinContextGetMock = jest.fn()
jest.mock("./handlers/twin-context", () => ({
  twinContextGet: (...args: unknown[]) => twinContextGetMock(...args),
}))

const agentTeamListMock = jest.fn()
const agentTeamRunMock = jest.fn()
const agentTeamRunStatusMock = jest.fn()
jest.mock("./handlers/agent-team", () => ({
  agentTeamList: (...args: unknown[]) => agentTeamListMock(...args),
  agentTeamRun: (...args: unknown[]) => agentTeamRunMock(...args),
  agentTeamRunStatus: (...args: unknown[]) => agentTeamRunStatusMock(...args),
}))

const desktopWriteDispatchMock = jest.fn()
jest.mock("@/lib/companion/desktop-write-source", () => ({
  dispatchCommand: (...args: unknown[]) => desktopWriteDispatchMock(...args),
}))

const pluginDevReloadMock = jest.fn()
jest.mock("./handlers/plugin-dev-reload", () => ({
  pluginDevReload: (...args: unknown[]) => pluginDevReloadMock(...args),
}))

const recordReloadResultMock = jest.fn()
jest.mock("@/stores/plugins/plugin-dev-session-store", () => ({
  usePluginDevSessionStore: {
    getState: () => ({ recordReloadResult: recordReloadResultMock }),
  },
}))

// The real @tauri-apps imports must never load in jsdom-free node tests —
// every test below injects a fake bridge.
jest.mock("@tauri-apps/api/event", () => ({ listen: jest.fn() }))
jest.mock("@tauri-apps/api/core", () => ({ invoke: jest.fn() }))

import { dispatchCommand, installCliRendererRequestSource } from "./renderer-request-source"

interface CapturedListener {
  event: string
  handler: (e: { payload: unknown }) => void
}

function makeBridge() {
  const listeners: CapturedListener[] = []
  const invocations: Array<{ name: string; args: Record<string, unknown> }> = []
  const unlisten = jest.fn()
  return {
    bridge: {
      listen: async <T>(event: string, handler: (e: { payload: T }) => void) => {
        listeners.push({ event, handler: handler as CapturedListener["handler"] })
        return unlisten
      },
      invoke: async (name: string, args: Record<string, unknown>) => {
        invocations.push({ name, args })
        return undefined
      },
    },
    listeners,
    invocations,
    unlisten,
  }
}

beforeEach(() => {
  twinContextGetMock.mockReset()
  agentTeamListMock.mockReset()
  agentTeamRunMock.mockReset()
  agentTeamRunStatusMock.mockReset()
  desktopWriteDispatchMock.mockReset()
  pluginDevReloadMock.mockReset()
  recordReloadResultMock.mockReset()
})

describe("dispatchCommand", () => {
  it("routes each command to its handler", async () => {
    twinContextGetMock.mockResolvedValue({ ok: true })
    agentTeamListMock.mockResolvedValue({ ok: true, teams: [] })
    agentTeamRunMock.mockResolvedValue({ ok: true, started: true })
    agentTeamRunStatusMock.mockResolvedValue({ ok: true })

    await dispatchCommand("twin_context_get", { message: "hi" })
    expect(twinContextGetMock).toHaveBeenCalledWith({ message: "hi" })

    await dispatchCommand("agent_team_list", {})
    expect(agentTeamListMock).toHaveBeenCalled()

    await dispatchCommand("agent_team_run", { teamId: "t1" })
    expect(agentTeamRunMock).toHaveBeenCalledWith({ teamId: "t1" })

    await dispatchCommand("agent_team_run_status", { teamId: "t1", sinceTs: 5 })
    expect(agentTeamRunStatusMock).toHaveBeenCalledWith({ teamId: "t1", sinceTs: 5 })

    pluginDevReloadMock.mockResolvedValue({ ok: true, outcome: "activated" })
    const reloadPayload = { pluginId: "demo.plugin", attempt: 1 }
    await dispatchCommand("plugin_dev_reload", reloadPayload)
    expect(pluginDevReloadMock).toHaveBeenCalledWith(reloadPayload)
    expect(recordReloadResultMock).toHaveBeenCalledWith({ ok: true, outcome: "activated" })
  })

  it("throws on an unknown command", async () => {
    await expect(dispatchCommand("bogus", {})).rejects.toThrow(/unknown cli-bridge/)
  })

  it.each(["host_state_snapshot", "host_state_submit", "host_state_status"])(
    "routes %s through the desktop HostState authority with the bridge",
    async (command) => {
      const { bridge } = makeBridge()
      desktopWriteDispatchMock.mockResolvedValue({ ok: true })
      const payload = { runtimeTargetId: "target-a" }

      await expect(dispatchCommand(command, payload, bridge)).resolves.toEqual({ ok: true })
      expect(desktopWriteDispatchMock).toHaveBeenCalledWith(command, payload, bridge)
    }
  )
})

describe("installCliRendererRequestSource", () => {
  it("listens on the renderer-request event and posts the result envelope", async () => {
    const { bridge, listeners, invocations } = makeBridge()
    twinContextGetMock.mockResolvedValue({ ok: true, degraded: false })

    const teardown = await installCliRendererRequestSource({ bridge, forceReinstall: true })
    expect(listeners).toHaveLength(1)
    expect(listeners[0].event).toBe("cli-bridge://renderer-request")

    listeners[0].handler({
      payload: { requestId: "rid-1", command: "twin_context_get", payload: { message: "hi" } },
    })
    await new Promise((r) => setTimeout(r, 0))

    expect(invocations).toEqual([
      {
        name: "cli_bridge_renderer_response",
        args: {
          response: { requestId: "rid-1", result: { ok: true, degraded: false }, error: null },
        },
      },
    ])
    teardown()
  })

  it("posts the error envelope when the handler throws", async () => {
    const { bridge, listeners, invocations } = makeBridge()
    const teardown = await installCliRendererRequestSource({ bridge, forceReinstall: true })

    listeners[0].handler({
      payload: { requestId: "rid-2", command: "no_such_command", payload: {} },
    })
    await new Promise((r) => setTimeout(r, 0))

    expect(invocations).toHaveLength(1)
    const { response } = invocations[0].args as {
      response: { requestId: string; result: unknown; error: string }
    }
    expect(response.requestId).toBe("rid-2")
    expect(response.result).toBeNull()
    expect(response.error).toMatch(/unknown cli-bridge/)
    teardown()
  })

  it("is idempotent unless forceReinstall is set", async () => {
    const { bridge, listeners } = makeBridge()
    const teardown = await installCliRendererRequestSource({ bridge, forceReinstall: true })
    const noop = await installCliRendererRequestSource({ bridge })
    expect(listeners).toHaveLength(1)
    noop()
    teardown()
    // After teardown a fresh install works again.
    const teardown2 = await installCliRendererRequestSource({ bridge })
    expect(listeners).toHaveLength(2)
    teardown2()
  })
})
