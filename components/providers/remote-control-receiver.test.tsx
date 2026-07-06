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

const appendRemoteControlAudit = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/db/remote-control-audit", () => ({
  appendRemoteControlAudit: (...args: unknown[]) => appendRemoteControlAudit(...args),
}))

const hasNoLeakingPii = jest.fn().mockReturnValue(true)
jest.mock("@/lib/twin/ingest/redact", () => ({
  hasNoLeakingPii: (...args: unknown[]) => hasNoLeakingPii(...args),
}))

const answerRemoteControlQuery = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/remote-control/query-answerer", () => ({
  answerRemoteControlQuery: (...args: unknown[]) => answerRemoteControlQuery(...args),
}))

const recordRemoteRunOutcome = jest.fn().mockResolvedValue(undefined)
const markRemoteRunStatus = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/db/remote-control-run-status", () => ({
  recordRemoteRunOutcome: (...args: unknown[]) => recordRemoteRunOutcome(...args),
  markRemoteRunStatus: (...args: unknown[]) => markRemoteRunStatus(...args),
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

  it("subscribes to all remote-control events and hydrates on desktop", async () => {
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
      expect(handlers["remote-control://query"]).toBeDefined()
    })
    expect(hydrate).toHaveBeenCalled()
  })

  it("routes query events through answerRemoteControlQuery", async () => {
    mockedIsTauri.mockReturnValue(true)
    let queryHandler: ((e: { payload: unknown }) => void) | null = null
    mockListen.mockImplementation(
      async (eventName: string, handler: (e: { payload: unknown }) => void) => {
        if (eventName === "remote-control://query") queryHandler = handler
        return jest.fn()
      }
    )
    render(
      <RemoteControlReceiver>
        <div />
      </RemoteControlReceiver>
    )
    await waitFor(() => expect(queryHandler).not.toBeNull())
    const query = { requestId: "rcq_1", kind: "tasks", params: {} }
    queryHandler!({ payload: query })
    await waitFor(() => expect(answerRemoteControlQuery).toHaveBeenCalledWith(query))
  })

  it("ignores query events with no requestId or kind", async () => {
    mockedIsTauri.mockReturnValue(true)
    let queryHandler: ((e: { payload: unknown }) => void) | null = null
    mockListen.mockImplementation(
      async (eventName: string, handler: (e: { payload: unknown }) => void) => {
        if (eventName === "remote-control://query") queryHandler = handler
        return jest.fn()
      }
    )
    render(
      <RemoteControlReceiver>
        <div />
      </RemoteControlReceiver>
    )
    await waitFor(() => expect(queryHandler).not.toBeNull())
    queryHandler!({ payload: { requestId: "rcq_1" } })
    expect(answerRemoteControlQuery).not.toHaveBeenCalled()
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
    await waitFor(() =>
      expect(appendRemoteControlAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          direction: "inbound",
          kind: "inbound.command",
          target: "workflow.run",
          runId: "run_1",
          result: "accepted",
          fields: { args: { workflowId: "wf_1" } },
        })
      )
    )
    await waitFor(() =>
      expect(recordRemoteRunOutcome).toHaveBeenCalledWith(
        expect.objectContaining({ runId: "run_1", target: "workflow.run", status: "accepted" })
      )
    )
  })

  it("advances the run-status projection when a handler exposes a settle hook", async () => {
    mockedIsTauri.mockReturnValue(true)
    dispatchRemoteCommand.mockResolvedValueOnce({
      runId: "run_9",
      status: "accepted",
      settle: Promise.resolve({ status: "succeeded", detail: "team done" }),
    })
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
    commandHandler!({
      payload: { target: "team.dispatch", args: { teamId: "tm_1" }, runId: "run_9" },
    })
    await waitFor(() =>
      expect(markRemoteRunStatus).toHaveBeenCalledWith("run_9", "succeeded", "team done")
    )
  })

  it("stores a redacted marker when command args leak PII", async () => {
    mockedIsTauri.mockReturnValue(true)
    hasNoLeakingPii.mockReturnValueOnce(false)
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
    commandHandler!({
      payload: { target: "goal.create", args: { rawObjective: "ssn 123" }, runId: "run_2" },
    })
    await waitFor(() =>
      expect(appendRemoteControlAudit).toHaveBeenCalledWith(
        expect.objectContaining({ fields: { redacted: true } })
      )
    )
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
