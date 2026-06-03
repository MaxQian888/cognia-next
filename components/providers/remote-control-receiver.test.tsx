/** @jest-environment jsdom */

import { render, waitFor } from "@testing-library/react"
import { RemoteControlReceiver } from "./remote-control-receiver"
import { isTauri } from "@/lib/tauri"

jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(),
}))

const mockedIsTauri = isTauri as jest.MockedFunction<typeof isTauri>

const mockListen = jest.fn()
jest.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => mockListen(...args),
}))

const runTaskNow = jest.fn()
jest.mock("@/stores/scheduler/scheduler-store", () => ({
  useSchedulerStore: { getState: () => ({ runTaskNow }) },
}))

const recordInboundCall = jest.fn()
const hydrate = jest.fn()
jest.mock("@/stores/remote-control/store", () => ({
  useRemoteControlStore: {
    getState: () => ({ recordInboundCall, hydrate }),
  },
}))

const emitSchedulerEvent = jest.fn()
jest.mock("@/lib/scheduler/event-integration", () => ({
  emitSchedulerEvent: (...args: unknown[]) => emitSchedulerEvent(...args),
}))

const dispatchRemoteCommand = jest.fn().mockResolvedValue({ runId: "run_1", status: "accepted" })
jest.mock("@/lib/remote-control/dispatch", () => ({
  dispatchRemoteCommand: (...args: unknown[]) => dispatchRemoteCommand(...args),
}))

beforeEach(() => {
  jest.clearAllMocks()
})

describe("RemoteControlReceiver", () => {
  it("does nothing on web (no listeners registered, no hydrate)", async () => {
    mockedIsTauri.mockReturnValue(false)
    render(
      <RemoteControlReceiver>
        <div>child</div>
      </RemoteControlReceiver>
    )
    await waitFor(() => {
      expect(mockListen).not.toHaveBeenCalled()
    })
    expect(hydrate).not.toHaveBeenCalled()
  })

  it("subscribes to all three remote-control events and hydrates on desktop", async () => {
    mockedIsTauri.mockReturnValue(true)
    const handlers: Record<string, (event: { payload: unknown }) => void> = {}
    mockListen.mockImplementation(
      async (eventName: string, handler: (e: { payload: unknown }) => void) => {
        handlers[eventName] = handler
        return jest.fn()
      }
    )

    render(
      <RemoteControlReceiver>
        <div>child</div>
      </RemoteControlReceiver>
    )

    await waitFor(() => {
      expect(handlers["remote-control://run-task"]).toBeDefined()
      expect(handlers["remote-control://emit-event"]).toBeDefined()
      expect(handlers["remote-control://inbound-call"]).toBeDefined()
      expect(handlers["remote-control://command"]).toBeDefined()
    })
    expect(hydrate).toHaveBeenCalled()
  })

  it("routes command events through dispatchRemoteCommand", async () => {
    mockedIsTauri.mockReturnValue(true)
    let commandHandler: ((e: { payload: unknown }) => void) | null = null
    mockListen.mockImplementation(
      async (eventName: string, handler: (e: { payload: unknown }) => void) => {
        if (eventName === "remote-control://command") commandHandler = handler
        return jest.fn()
      }
    )
    render(
      <RemoteControlReceiver>
        <div />
      </RemoteControlReceiver>
    )
    await waitFor(() => expect(commandHandler).not.toBeNull())
    const command = { target: "workflow.run", args: { workflowId: "wf_1" }, runId: "run_1" }
    commandHandler!({ payload: command })
    await waitFor(() => expect(dispatchRemoteCommand).toHaveBeenCalledWith(command))
  })

  it("ignores command events with no target", async () => {
    mockedIsTauri.mockReturnValue(true)
    let commandHandler: ((e: { payload: unknown }) => void) | null = null
    mockListen.mockImplementation(
      async (eventName: string, handler: (e: { payload: unknown }) => void) => {
        if (eventName === "remote-control://command") commandHandler = handler
        return jest.fn()
      }
    )
    render(
      <RemoteControlReceiver>
        <div />
      </RemoteControlReceiver>
    )
    await waitFor(() => expect(commandHandler).not.toBeNull())
    commandHandler!({ payload: {} })
    expect(dispatchRemoteCommand).not.toHaveBeenCalled()
  })

  it("invokes runTaskNow when run-task fires with a taskId", async () => {
    mockedIsTauri.mockReturnValue(true)
    let runHandler: ((e: { payload: unknown }) => void) | null = null
    mockListen.mockImplementation(
      async (eventName: string, handler: (e: { payload: unknown }) => void) => {
        if (eventName === "remote-control://run-task") runHandler = handler
        return jest.fn()
      }
    )
    render(
      <RemoteControlReceiver>
        <div />
      </RemoteControlReceiver>
    )
    await waitFor(() => expect(runHandler).not.toBeNull())
    runHandler!({ payload: { taskId: "task-123" } })
    expect(runTaskNow).toHaveBeenCalledWith("task-123")
  })

  it("ignores run-task events with no taskId", async () => {
    mockedIsTauri.mockReturnValue(true)
    let runHandler: ((e: { payload: unknown }) => void) | null = null
    mockListen.mockImplementation(
      async (eventName: string, handler: (e: { payload: unknown }) => void) => {
        if (eventName === "remote-control://run-task") runHandler = handler
        return jest.fn()
      }
    )
    render(
      <RemoteControlReceiver>
        <div />
      </RemoteControlReceiver>
    )
    await waitFor(() => expect(runHandler).not.toBeNull())
    runHandler!({ payload: {} })
    expect(runTaskNow).not.toHaveBeenCalled()
  })

  it("forwards emit-event to emitSchedulerEvent with eventSource and data", async () => {
    mockedIsTauri.mockReturnValue(true)
    let emitHandler: ((e: { payload: unknown }) => void) | null = null
    mockListen.mockImplementation(
      async (eventName: string, handler: (e: { payload: unknown }) => void) => {
        if (eventName === "remote-control://emit-event") emitHandler = handler
        return jest.fn()
      }
    )
    render(
      <RemoteControlReceiver>
        <div />
      </RemoteControlReceiver>
    )
    await waitFor(() => expect(emitHandler).not.toBeNull())
    emitHandler!({
      payload: {
        eventType: "session:completed",
        eventSource: "external",
        data: { foo: "bar" },
      },
    })
    expect(emitSchedulerEvent).toHaveBeenCalledWith("session:completed", { foo: "bar" }, "external")
  })

  it("ignores emit-event events with no eventType", async () => {
    mockedIsTauri.mockReturnValue(true)
    let emitHandler: ((e: { payload: unknown }) => void) | null = null
    mockListen.mockImplementation(
      async (eventName: string, handler: (e: { payload: unknown }) => void) => {
        if (eventName === "remote-control://emit-event") emitHandler = handler
        return jest.fn()
      }
    )
    render(
      <RemoteControlReceiver>
        <div />
      </RemoteControlReceiver>
    )
    await waitFor(() => expect(emitHandler).not.toBeNull())
    emitHandler!({ payload: {} })
    expect(emitSchedulerEvent).not.toHaveBeenCalled()
  })

  it("pushes inbound-call entries into the recent-calls ring", async () => {
    mockedIsTauri.mockReturnValue(true)
    let callHandler: ((e: { payload: unknown }) => void) | null = null
    mockListen.mockImplementation(
      async (eventName: string, handler: (e: { payload: unknown }) => void) => {
        if (eventName === "remote-control://inbound-call") callHandler = handler
        return jest.fn()
      }
    )
    render(
      <RemoteControlReceiver>
        <div />
      </RemoteControlReceiver>
    )
    await waitFor(() => expect(callHandler).not.toBeNull())
    const entry = {
      id: "id-1",
      at: "2026-05-03T10:00:00.000Z",
      route: "/api/v1/health",
      status: 200,
      remoteIp: "127.0.0.1",
    } as const
    callHandler!({ payload: entry })
    expect(recordInboundCall).toHaveBeenCalledWith(entry)
  })
})
