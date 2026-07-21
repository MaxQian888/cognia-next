import {
  __resetPythonEventBusForTesting,
  dispatchPythonPluginEvent,
  pythonPluginEventListenerCount,
  subscribePythonPluginEvents,
} from "./event-bus"
import type { PythonPluginEvent } from "./log-buffer"

const frame = (overrides: Partial<PythonPluginEvent> = {}): PythonPluginEvent => ({
  pluginId: "demo",
  kind: "log",
  data: "hello",
  ...overrides,
})

describe("python event bus", () => {
  beforeEach(() => {
    __resetPythonEventBusForTesting()
  })

  it("delivers every frame to all subscribers", () => {
    const first: PythonPluginEvent[] = []
    const second: PythonPluginEvent[] = []
    subscribePythonPluginEvents((event) => first.push(event))
    subscribePythonPluginEvents((event) => second.push(event))

    const event = frame({ kind: "chunk" })
    dispatchPythonPluginEvent(event)

    expect(first).toEqual([event])
    expect(second).toEqual([event])
  })

  it("stops delivering after unsubscribe, and unsubscribing twice is safe", () => {
    const seen: PythonPluginEvent[] = []
    const unsubscribe = subscribePythonPluginEvents((event) => seen.push(event))

    dispatchPythonPluginEvent(frame())
    unsubscribe()
    unsubscribe()
    dispatchPythonPluginEvent(frame({ kind: "exit" }))

    expect(seen).toHaveLength(1)
    expect(pythonPluginEventListenerCount()).toBe(0)
  })

  it("keeps dispatching when one subscriber throws", () => {
    const seen: string[] = []
    subscribePythonPluginEvents(() => {
      throw new Error("subscriber blew up")
    })
    subscribePythonPluginEvents((event) => seen.push(event.kind))

    expect(() => dispatchPythonPluginEvent(frame({ kind: "progress" }))).not.toThrow()
    expect(seen).toEqual(["progress"])
  })

  it("tolerates a subscriber unsubscribing during dispatch", () => {
    const seen: string[] = []
    const unsubscribe = subscribePythonPluginEvents(() => {
      unsubscribe()
      seen.push("first")
    })
    subscribePythonPluginEvents(() => seen.push("second"))

    dispatchPythonPluginEvent(frame())

    // Both still run for this frame (dispatch iterates a snapshot)…
    expect(seen).toEqual(["first", "second"])
    // …and the self-removing one is gone for the next.
    expect(pythonPluginEventListenerCount()).toBe(1)
  })

  it("reports the live listener count", () => {
    expect(pythonPluginEventListenerCount()).toBe(0)
    const a = subscribePythonPluginEvents(() => {})
    subscribePythonPluginEvents(() => {})
    expect(pythonPluginEventListenerCount()).toBe(2)
    a()
    expect(pythonPluginEventListenerCount()).toBe(1)
  })
})
