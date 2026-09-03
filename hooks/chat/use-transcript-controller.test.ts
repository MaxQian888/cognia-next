/** @jest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react"

import type { TranscriptSource } from "@/lib/chat/transcript/source"
import { useTranscriptController } from "./use-transcript-controller"
import { transcriptCapabilitiesV1 } from "@/lib/chat/transcript/source"

describe("useTranscriptController", () => {
  it("loads a session and exposes paging actions", async () => {
    const source: TranscriptSource = {
      capabilities: jest.fn(async () => transcriptCapabilitiesV1()),
      timeline: jest.fn(async () => ({ items: [], revision: 3, hasMore: false })),
      turnMessages: jest.fn(),
    }

    const { result, unmount } = renderHook(() => useTranscriptController("s1", source))

    await waitFor(() => expect(result.current.snapshot.loading).toBe(false))
    expect(result.current.snapshot.revision).toBe(3)
    await act(async () => result.current.loadOlder())
    expect(source.timeline).toHaveBeenCalledTimes(1)
    unmount()
  })

  it("opens the revision subscription from an effect, never during render", async () => {
    const subscribeRevision = jest.fn(() => jest.fn())
    const source: TranscriptSource = {
      capabilities: jest.fn(async () => transcriptCapabilitiesV1()),
      timeline: jest.fn(async () => ({ items: [], revision: 1, hasMore: false })),
      turnMessages: jest.fn(),
      subscribeRevision,
    }
    const subscribedWhileRendering: number[] = []

    const { result, unmount } = renderHook(() => {
      const value = useTranscriptController("s1", source)
      subscribedWhileRendering.push(subscribeRevision.mock.calls.length)
      return value
    })

    // The transport opens its WebSocket inside `subscribeRevision`, which flips
    // the companion connection state and wakes every other subscriber. Doing it
    // in the first render is React's "Cannot update a component while rendering
    // a different component".
    expect(subscribedWhileRendering[0]).toBe(0)
    await waitFor(() => expect(result.current.snapshot.loading).toBe(false))
    expect(subscribeRevision).toHaveBeenCalledTimes(1)
    unmount()
  })

  it("stays inert when no session is selected", () => {
    const source: TranscriptSource = {
      capabilities: jest.fn(),
      timeline: jest.fn(),
      turnMessages: jest.fn(),
    }
    const { result } = renderHook(() => useTranscriptController(null, source))

    expect(result.current.snapshot).toMatchObject({ items: [], loading: false })
    expect(source.timeline).not.toHaveBeenCalled()
  })
})
