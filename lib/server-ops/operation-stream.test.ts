import type { Operation, OperationEvent } from "./client"
import { followOperationStream } from "./operation-stream"

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
