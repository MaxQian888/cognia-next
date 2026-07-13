import * as core from "@tauri-apps/api/core"
import { setTtsHost } from "../host"
import { synthesizeRealtimeStream } from "./openai-realtime"
import type { TTSStreamEvent } from "./adapter"

// Host-injected native-shell gate (ADR-0068 E3) — stands in for isTauri().
const mockIsTauri = jest.fn()
const mockInvoke = core.invoke as unknown as jest.Mock

function collect() {
  const events: TTSStreamEvent[] = []
  return { events, onEvent: (e: TTSStreamEvent) => events.push(e) }
}

beforeEach(() => {
  mockIsTauri.mockReset()
  mockInvoke.mockReset()
  mockInvoke.mockResolvedValue(undefined) // default: thenable; overridden per-test
  setTtsHost({ isNativeShell: () => mockIsTauri() as boolean })
})

afterAll(() => {
  setTtsHost({})
})

describe("synthesizeRealtimeStream", () => {
  it("returns a desktop-only error in browser mode", async () => {
    mockIsTauri.mockReturnValue(false)
    const { events, onEvent } = collect()
    await synthesizeRealtimeStream({
      text: "hi",
      apiKey: "k",
      runtime: {},
      requestId: "r1",
      onEvent,
      signal: new AbortController().signal,
    })
    expect(events).toEqual([{ kind: "error", message: expect.stringMatching(/desktop app/i) }])
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it("forwards audio/done channel messages to onEvent and passes runtime options", async () => {
    mockIsTauri.mockReturnValue(true)
    const { events, onEvent } = collect()
    mockInvoke.mockImplementationOnce(
      async (_cmd, args: { onEvent: { onmessage: (m: unknown) => void } }) => {
        const ch = args.onEvent
        ch.onmessage({ event: "audio", data: "AAA=" })
        ch.onmessage({ event: "audio", data: "BBB=" })
        ch.onmessage({ event: "done" })
      }
    )

    await synthesizeRealtimeStream({
      text: "read this",
      apiKey: "secret",
      runtime: { voice: "cedar", model: "gpt-realtime", instructions: "be calm" },
      requestId: "r2",
      onEvent,
      signal: new AbortController().signal,
    })

    expect(events).toEqual([
      { kind: "audio", audioBase64: "AAA=" },
      { kind: "audio", audioBase64: "BBB=" },
      { kind: "done" },
    ])
    expect(mockInvoke).toHaveBeenCalledWith(
      "tts_realtime_synthesize",
      expect.objectContaining({
        request: expect.objectContaining({
          requestId: "r2",
          apiKey: "secret",
          text: "read this",
          voice: "cedar",
          model: "gpt-realtime",
          instructions: "be calm",
        }),
      })
    )
  })

  it("defaults voice/model/instructions when runtime omits them", async () => {
    mockIsTauri.mockReturnValue(true)
    const { onEvent } = collect()
    mockInvoke.mockResolvedValueOnce(undefined)
    await synthesizeRealtimeStream({
      text: "hi",
      apiKey: "k",
      runtime: {},
      requestId: "r3",
      onEvent,
      signal: new AbortController().signal,
    })
    expect(mockInvoke).toHaveBeenCalledWith(
      "tts_realtime_synthesize",
      expect.objectContaining({
        request: expect.objectContaining({
          voice: "marin",
          model: "gpt-realtime",
          instructions: "",
        }),
      })
    )
  })

  it("forwards a channel error message", async () => {
    mockIsTauri.mockReturnValue(true)
    const { events, onEvent } = collect()
    mockInvoke.mockImplementationOnce(
      async (_cmd, args: { onEvent: { onmessage: (m: unknown) => void } }) => {
        args.onEvent.onmessage({ event: "error", data: "ws closed" })
      }
    )
    await synthesizeRealtimeStream({
      text: "hi",
      apiKey: "k",
      runtime: {},
      requestId: "r4",
      onEvent,
      signal: new AbortController().signal,
    })
    expect(events).toEqual([{ kind: "error", message: "ws closed" }])
  })

  it("surfaces an invoke rejection as an error event", async () => {
    mockIsTauri.mockReturnValue(true)
    const { events, onEvent } = collect()
    mockInvoke.mockRejectedValueOnce(new Error("command failed"))
    await synthesizeRealtimeStream({
      text: "hi",
      apiKey: "k",
      runtime: {},
      requestId: "r5",
      onEvent,
      signal: new AbortController().signal,
    })
    expect(events).toEqual([{ kind: "error", message: "command failed" }])
  })

  it("stringifies a non-Error rejection", async () => {
    mockIsTauri.mockReturnValue(true)
    const { events, onEvent } = collect()
    mockInvoke.mockRejectedValueOnce("plain string failure")
    await synthesizeRealtimeStream({
      text: "hi",
      apiKey: "k",
      runtime: {},
      requestId: "r5b",
      onEvent,
      signal: new AbortController().signal,
    })
    expect(events).toEqual([{ kind: "error", message: "plain string failure" }])
  })

  it("ignores an audio message that carries no data", async () => {
    mockIsTauri.mockReturnValue(true)
    const { events, onEvent } = collect()
    mockInvoke.mockImplementationOnce(
      async (_cmd, args: { onEvent: { onmessage: (m: unknown) => void } }) => {
        args.onEvent.onmessage({ event: "audio" }) // no `data`
        args.onEvent.onmessage({ event: "done" })
      }
    )
    await synthesizeRealtimeStream({
      text: "hi",
      apiKey: "k",
      runtime: {},
      requestId: "r5c",
      onEvent,
      signal: new AbortController().signal,
    })
    expect(events).toEqual([{ kind: "done" }])
  })

  it("invokes the cancel command when the signal aborts mid-stream", async () => {
    mockIsTauri.mockReturnValue(true)
    const controller = new AbortController()
    const { onEvent } = collect()
    mockInvoke.mockImplementationOnce(async () => {
      controller.abort() // simulate orchestrator stop()
    })
    await synthesizeRealtimeStream({
      text: "hi",
      apiKey: "k",
      runtime: {},
      requestId: "r6",
      onEvent,
      signal: controller.signal,
    })
    expect(mockInvoke).toHaveBeenCalledWith("tts_realtime_cancel", { requestId: "r6" })
  })

  it("cancels immediately if the signal is already aborted", async () => {
    mockIsTauri.mockReturnValue(true)
    const controller = new AbortController()
    controller.abort()
    const { onEvent } = collect()
    await synthesizeRealtimeStream({
      text: "hi",
      apiKey: "k",
      runtime: {},
      requestId: "r7",
      onEvent,
      signal: controller.signal,
    })
    expect(mockInvoke).toHaveBeenCalledWith("tts_realtime_cancel", { requestId: "r7" })
    expect(mockInvoke).not.toHaveBeenCalledWith("tts_realtime_synthesize", expect.anything())
  })
})
