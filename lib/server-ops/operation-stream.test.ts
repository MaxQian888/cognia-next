import type { Operation, OperationEvent } from "./client"
import {
  followOperationStream,
  isTerminalOperation,
  pollOperationUpdates,
} from "./operation-stream"

const event = (id: number, operationId = `op-${id}`): OperationEvent => ({
  id,
  operationId,
  targetId: "production",
  state: "executing",
  timestamp: "2026-08-11T10:00:00Z",
  message: "working",
})

const operation = (id: string): Operation => ({
  id,
  targetId: "production",
  kind: "deploy",
  state: "executing",
  request: {},
  result: null,
  error: null,
  createdBy: "user",
  createdAt: "2026-08-11T10:00:00Z",
  updatedAt: "2026-08-11T10:00:00Z",
})

describe("followOperationStream", () => {
  it("hydrates operations and resumes from the latest event id after reconnecting", async () => {
    const controller = new AbortController()
    const streamEvents = jest
      .fn()
      .mockImplementationOnce(async function* () {
        yield event(2)
        throw new Error("connection reset")
      })
      .mockImplementationOnce(async function* () {
        yield event(3)
        controller.abort()
      })
    const getOperation = jest.fn((id: string) => Promise.resolve(operation(id)))
    const onOperation = jest.fn()

    await followOperationStream(
      { streamEvents, getOperation },
      { signal: controller.signal, onOperation, sleep: () => Promise.resolve() }
    )

    expect(streamEvents).toHaveBeenNthCalledWith(1, {
      lastEventId: undefined,
      signal: controller.signal,
    })
    expect(streamEvents).toHaveBeenNthCalledWith(2, {
      lastEventId: 2,
      signal: controller.signal,
    })
    expect(onOperation).toHaveBeenCalledWith(operation("op-2"), event(2))
    expect(onOperation).toHaveBeenCalledWith(operation("op-3"), event(3))
  })

  it("reports stream errors and backs off until aborted", async () => {
    const controller = new AbortController()
    const failure = new Error("offline")
    const streamEvents = jest.fn().mockImplementation(async function* () {
      throw failure
    })
    const sleep = jest.fn().mockImplementation(() => {
      controller.abort()
      return Promise.resolve()
    })
    const onError = jest.fn()

    await followOperationStream(
      { streamEvents, getOperation: jest.fn() },
      { signal: controller.signal, onOperation: jest.fn(), onError, sleep }
    )

    expect(onError).toHaveBeenCalledWith(failure)
    expect(sleep).toHaveBeenCalledWith(1000)
  })

  it("uses the default timer before reconnecting a normally closed stream", async () => {
    const controller = new AbortController()
    const timeout = jest.spyOn(global, "setTimeout").mockImplementation((handler) => {
      controller.abort()
      if (typeof handler === "function") handler()
      return 1 as unknown as NodeJS.Timeout
    })

    try {
      await followOperationStream(
        {
          streamEvents: jest.fn().mockImplementation(async function* () {}),
          getOperation: jest.fn(),
        },
        { signal: controller.signal, onOperation: jest.fn() }
      )
      expect(timeout).toHaveBeenCalledWith(expect.any(Function), 1000)
    } finally {
      timeout.mockRestore()
    }
  })

  it("stops immediately when an operation callback aborts the stream", async () => {
    const controller = new AbortController()
    const onOperation = jest.fn(() => controller.abort())

    await followOperationStream(
      {
        streamEvents: jest.fn().mockImplementation(async function* () {
          yield event(1)
        }),
        getOperation: jest.fn((id: string) => Promise.resolve(operation(id))),
      },
      { signal: controller.signal, onOperation }
    )

    expect(onOperation).toHaveBeenCalledTimes(1)
  })

  it("suppresses an abort error raised by the stream itself", async () => {
    const controller = new AbortController()
    const onError = jest.fn()

    await followOperationStream(
      {
        streamEvents: jest.fn().mockImplementation(async function* () {
          controller.abort()
          throw new Error("aborted")
        }),
        getOperation: jest.fn(),
      },
      { signal: controller.signal, onOperation: jest.fn(), onError }
    )

    expect(onError).not.toHaveBeenCalled()
  })
})

describe("pollOperationUpdates", () => {
  it("re-reads only the operations the caller still considers pending", async () => {
    const controller = new AbortController()
    // The pending list is read fresh each tick, so an operation that finishes
    // stops being polled without the loop being restarted.
    const pending = jest
      .fn<string[], []>()
      .mockReturnValueOnce(["op-1", "op-2"])
      .mockReturnValueOnce(["op-2"])
      .mockImplementation(() => {
        controller.abort()
        return []
      })
    const getOperation = jest.fn(async (id: string) => operation(id))
    const onOperation = jest.fn()

    await pollOperationUpdates(
      { getOperation },
      {
        signal: controller.signal,
        pending,
        onOperation,
        sleep: () => Promise.resolve(),
      }
    )

    expect(getOperation.mock.calls.map(([id]) => id)).toEqual(["op-1", "op-2", "op-2"])
    expect(onOperation).toHaveBeenCalledTimes(3)
  })

  it("keeps polling the rest of the fleet after one operation fails to load", async () => {
    const controller = new AbortController()
    let ticks = 0
    const pending = jest.fn(() => {
      ticks += 1
      if (ticks > 1) controller.abort()
      return ["op-broken", "op-fine"]
    })
    const getOperation = jest.fn(async (id: string) => {
      if (id === "op-broken") throw new Error("gone")
      return operation(id)
    })
    const onError = jest.fn()
    const onOperation = jest.fn()

    await pollOperationUpdates(
      { getOperation },
      { signal: controller.signal, pending, onOperation, onError, sleep: () => Promise.resolve() }
    )

    // One unreachable operation must not stop its neighbours from updating.
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onOperation).toHaveBeenCalledTimes(1)
    expect(onOperation.mock.calls[0][0].id).toBe("op-fine")
  })

  it("stops before the first read when the caller has already aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    const getOperation = jest.fn()

    await pollOperationUpdates(
      { getOperation },
      {
        signal: controller.signal,
        pending: () => ["op-1"],
        onOperation: jest.fn(),
        sleep: () => Promise.resolve(),
      }
    )

    expect(getOperation).not.toHaveBeenCalled()
  })
})

describe("isTerminalOperation", () => {
  it("treats every finished state as terminal, including a rollback failure", () => {
    // `rollback_failed` is the trap: it reads like something still in flight,
    // but the controller sends no further updates for it, so a poller that
    // kept it pending would spin forever.
    for (const state of [
      "succeeded",
      "failed",
      "rolled_back",
      "rollback_failed",
      "cancelled",
    ] as const) {
      expect(isTerminalOperation({ ...operation("op"), state })).toBe(true)
    }
    for (const state of ["queued", "validating", "preparing", "executing", "verifying"] as const) {
      expect(isTerminalOperation({ ...operation("op"), state })).toBe(false)
    }
  })
})
