/**
 * @jest-environment jsdom
 */

import { createRef } from "react"
import { render, act } from "@testing-library/react"

const geometry = { positions: [], viewportTop: 0, viewportHeight: 1, activeIndex: 0 }
const scrollSyncSpy = jest.fn((_args: unknown) => geometry)
jest.mock("./minimap/use-timeline-scroll-sync", () => ({
  useTimelineScrollSync: (args: unknown) => scrollSyncSpy(args),
}))

jest.mock("./minimap/use-timeline-turns", () => ({
  useTimelineTurns: (messages: Array<{ id: string }>) =>
    messages.map((message, index) => ({
      id: message.id,
      index,
      messageIds: [message.id, `${message.id}-reply`],
      label: message.id,
      preview: message.id,
    })),
}))

import { ActiveTurnPublisher } from "./active-turn-publisher"
import { useChatViewportStore } from "@/stores/chat/chat-viewport-store"
import type { UIMessage } from "ai"

const messages = [{ id: "m1" }, { id: "m2" }] as unknown as UIMessage[]

function renderPublisher() {
  return render(
    <ActiveTurnPublisher
      messages={messages}
      scrollRef={createRef<HTMLDivElement>()}
      virtualizer={null}
      virtualize={false}
    />
  )
}

beforeEach(() => {
  geometry.activeIndex = 0
  scrollSyncSpy.mockClear()
  useChatViewportStore.setState({ activeTurnMessageIds: [] })
})

describe("ActiveTurnPublisher", () => {
  it("renders nothing — it exists only to absorb the per-frame scroll sync", () => {
    const { container } = renderPublisher()
    expect(container.firstChild).toBeNull()
  })

  it("publishes every message in the turn at the top of the viewport", () => {
    renderPublisher()

    // The whole turn, not just its anchor: an artifact is produced by an
    // assistant reply while the timeline tracks user turns, so matching on the
    // anchoring id alone would never line the two up.
    expect(useChatViewportStore.getState().activeTurnMessageIds).toEqual(["m1", "m1-reply"])
  })

  it("runs its scroll sync over the unfiltered turn set", () => {
    renderPublisher()

    // The minimap runs its own sync over a possibly bookmark-filtered list, and
    // reusing that instance's `activeIndex` would point at the wrong turn here.
    expect(scrollSyncSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        turns: expect.arrayContaining([expect.objectContaining({ id: "m2" })]),
      })
    )
  })

  it("clears the published turn when no turn is in view", () => {
    const { rerender } = renderPublisher()
    expect(useChatViewportStore.getState().activeTurnMessageIds).toEqual(["m1", "m1-reply"])

    geometry.activeIndex = -1
    act(() => {
      rerender(
        <ActiveTurnPublisher
          messages={messages}
          scrollRef={createRef<HTMLDivElement>()}
          virtualizer={null}
          virtualize={false}
        />
      )
    })

    expect(useChatViewportStore.getState().activeTurnMessageIds).toEqual([])
  })

  it("stops highlighting once the conversation goes away", () => {
    const { unmount } = renderPublisher()
    expect(useChatViewportStore.getState().activeTurnMessageIds).toEqual(["m1", "m1-reply"])

    unmount()

    expect(useChatViewportStore.getState().activeTurnMessageIds).toEqual([])
  })
})
