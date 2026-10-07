import type { StoredMessage, TranscriptCapabilitiesV1 } from "@cognia/agent-config-types"

import { createRemoteTranscriptSource, transcriptCapabilitiesV1 } from "./source"

function row(id: string, role: StoredMessage["role"], text: string): StoredMessage {
  return {
    id,
    sessionId: "s1",
    role,
    parts: [{ type: "text", text }] as StoredMessage["parts"],
    createdAt: Number(id.slice(1)),
  }
}

describe("remote transcript source", () => {
  it("filters revision events to the observed session", () => {
    let handler: ((event: { sessionId?: string; revision?: number }) => void) | undefined
    const listener = jest.fn()
    const source = createRemoteTranscriptSource({
      call: jest.fn(),
      subscribe: jest.fn((_event, next) => {
        handler = next as typeof handler
        return jest.fn()
      }),
    } as never)

    source.subscribeRevision?.("s1", listener)
    handler?.({ sessionId: "s2", revision: 3 })
    handler?.({ sessionId: "s1", revision: 4 })

    expect(listener).toHaveBeenCalledWith(4)
  })

  // The defect: the callers built their source at module load and captured the
  // transport of that moment. A browser that paired afterwards still read the
  // web stub, so the timeline failed (`no_host_transport`) and a reply kept on
  // the host never appeared until a reload.
  it("reads through whichever transport is current and follows a swap", async () => {
    const stub = {
      call: jest.fn(async () => {
        throw Object.assign(new Error("tauri-only command from web mode"), {
          code: "no_host_transport",
        })
      }),
      subscribe: jest.fn(() => jest.fn()),
    }
    const unsubscribeHost = jest.fn()
    let hostRevision: ((event: { sessionId?: string; revision?: number }) => void) | undefined
    const host = {
      call: jest.fn(async (command: string) =>
        command === "transcript_capabilities"
          ? transcriptCapabilitiesV1()
          : { items: [], revision: 2, hasMore: false }
      ),
      subscribe: jest.fn((_event: string, next: unknown) => {
        hostRevision = next as typeof hostRevision
        return unsubscribeHost
      }),
    }
    let active: typeof stub | typeof host = stub
    let swapped: (() => void) | undefined
    const source = createRemoteTranscriptSource(() => active as never, {
      onTransportChange: (handler) => {
        swapped = handler
        return () => {
          swapped = undefined
        }
      },
    })
    const listener = jest.fn()
    const unsubscribe = source.subscribeRevision?.("s1", listener)
    await expect(source.capabilities()).rejects.toMatchObject({ code: "no_host_transport" })

    active = host
    swapped?.()
    await expect(
      source.timeline({ sessionId: "s1", direction: "backward" })
    ).resolves.toMatchObject({ revision: 2 })
    expect(host.call).toHaveBeenCalledWith("transcript_capabilities", {})
    hostRevision?.({ sessionId: "s1", revision: 2 })
    expect(listener).toHaveBeenCalledWith(2)

    unsubscribe?.()
    expect(unsubscribeHost).toHaveBeenCalled()
    expect(swapped).toBeUndefined()
  })

  it("uses the transcript RPCs when the host advertises the capability", async () => {
    const capabilities = transcriptCapabilitiesV1()
    const call = jest.fn(async (name: string) => {
      if (name === "transcript_capabilities") return capabilities
      if (name === "session_timeline") return { items: [], revision: 2, hasMore: false }
      throw new Error(`unexpected ${name}`)
    })
    const source = createRemoteTranscriptSource({ call } as never)

    await expect(source.capabilities()).resolves.toEqual(capabilities)
    await expect(source.timeline({ sessionId: "s1" })).resolves.toMatchObject({ revision: 2 })
    expect(call).not.toHaveBeenCalledWith("message_get_by_session", expect.anything())
  })

  it("falls back to the legacy message API only for an unsupported capability method", async () => {
    const call = jest.fn(async (name: string, args?: Record<string, unknown>) => {
      if (name === "transcript_capabilities") {
        throw Object.assign(new Error("Method not found"), { code: "METHOD_NOT_FOUND" })
      }
      if (name === "message_get_by_session") {
        expect(args).toMatchObject({ session_id: "s1", limit: 200 })
        return { rows: [row("u1", "user", "hello"), row("a2", "assistant", "hi")] }
      }
      throw new Error(`unexpected ${name}`)
    })
    const source = createRemoteTranscriptSource({ call } as never)

    await expect(source.capabilities()).resolves.toBeNull()
    await expect(source.timeline({ sessionId: "s1" })).resolves.toMatchObject({
      items: [{ kind: "completed-turn", turnKey: "turn:u1" }],
    })
  })

  it("does not silently trigger legacy hydration on timeouts or server failures", async () => {
    const call = jest.fn(async () => {
      throw Object.assign(new Error("request timed out"), { code: "ETIMEDOUT" })
    })
    const source = createRemoteTranscriptSource({ call } as never)

    await expect(source.capabilities()).rejects.toThrow("request timed out")
    expect(call).toHaveBeenCalledTimes(1)
  })

  it("publishes the versioned byte and page budgets", () => {
    const value: TranscriptCapabilitiesV1 = transcriptCapabilitiesV1()
    expect(value).toMatchObject({
      version: 1,
      maxTimelinePageSize: 100,
      maxTurnMessagePageSize: 200,
      maxTurnMessagePageBytes: 2 * 1024 * 1024,
      maxSummaryBytes: 64 * 1024,
      maxSummaryMediaRefs: 12,
      mediaVariants: ["thumbnail", "canonical"],
    })
  })
})
