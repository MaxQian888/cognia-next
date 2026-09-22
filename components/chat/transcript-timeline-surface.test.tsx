import { fireEvent, render, screen } from "@testing-library/react"
import type { UIMessage } from "ai"

import {
  TranscriptTimelineSurface,
  type TranscriptTimelineSurfaceProps,
} from "./transcript-timeline-surface"
import { resolveMessageDisplayOptions } from "@/lib/chat/message-display"

const messageRenderMock = jest.fn()

jest.mock("./message-renderer", () => ({
  MessageRenderer: jest
    .requireActual("react")
    .memo(
      ({
        message,
        onEditResend,
        messageDisplay,
      }: {
        message: UIMessage
        onEditResend?: unknown
        messageDisplay?: { preset?: string }
      }) => {
        messageRenderMock(message)
        return (
          <div
            data-testid={`message-${message.id}`}
            data-editable={Boolean(onEditResend)}
            data-preset={messageDisplay?.preset}
          >
            {message.parts.map((part) => (part.type === "text" ? part.text : part.type))}
          </div>
        )
      }
    ),
}))

const virtualizerMeasureMock = jest.fn()
let latestItemKey: ((index: number) => string | number) | undefined
jest.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (options: {
    count: number
    getItemKey?: (index: number) => string | number
    getScrollElement: () => Element | null
    estimateSize: () => number
    measureElement: (element?: Element) => number
  }) => {
    latestItemKey = options.getItemKey
    options.getScrollElement()
    options.estimateSize()
    options.measureElement()
    options.measureElement({ getBoundingClientRect: () => ({ height: 239.7 }) } as Element)
    return {
      getVirtualItems: () =>
        Array.from({ length: options.count }, (_, index) => ({
          index,
          key: options.getItemKey?.(index) ?? index,
          start: index * 240,
        })),
      getTotalSize: () => options.count * 240,
      measureElement: jest.fn(),
      measure: virtualizerMeasureMock,
    }
  },
}))

const labels = {
  expand: "Expand details",
  collapse: "Collapse details",
  loadOlder: "Load older",
  loading: "Loading",
  retry: "Retry",
}

describe("<TranscriptTimelineSurface />", () => {
  it("does not rerender settled messages when only the live tail changes", () => {
    const props: TranscriptTimelineSurfaceProps = {
      sessionId: "stream-session",
      items: [
        {
          kind: "system",
          itemKey: "system:history",
          revision: 1,
          startedAt: 1,
          status: "completed",
          message: { id: "history", role: "system", text: "Historical notice", createdAt: 1 },
        },
      ],
      expandedTurnKeys: new Set(),
      getDetail: () => undefined,
      onExpand: jest.fn(),
      onCollapse: jest.fn(),
      onLoadOlder: jest.fn(),
      onRetry: jest.fn(),
      hasMore: false,
      loading: false,
      loadingOlder: false,
      error: null,
      liveMessages: [{ id: "live", role: "assistant", parts: [{ type: "text", text: "A" }] }],
      liveStatus: "streaming",
      labels,
    }
    const { rerender } = render(<TranscriptTimelineSurface {...props} />)
    messageRenderMock.mockClear()
    rerender(
      <TranscriptTimelineSurface
        {...props}
        liveMessages={[{ id: "live", role: "assistant", parts: [{ type: "text", text: "AB" }] }]}
      />
    )
    expect(screen.getByTestId("message-live")).toHaveTextContent("AB")
    expect(messageRenderMock.mock.calls.map(([message]) => message.id)).toEqual(["live"])
    const historyKey = latestItemKey!(0)
    const newItem = {
      ...props.items[0],
      itemKey: "system:older",
      kind: "system" as const,
      status: "completed" as const,
      message: { id: "older", role: "system" as const, text: "Older notice", createdAt: 0 },
    }
    rerender(<TranscriptTimelineSurface {...props} items={[newItem, ...props.items]} />)
    expect(latestItemKey!(1)).toBe(historyKey)
    expect(screen.getAllByTestId(/^message-/).map((element) => element.textContent)).toEqual([
      "Older notice",
      "Historical notice",
      "A",
    ])
    rerender(<TranscriptTimelineSurface {...props} sessionId="other-session" />)
    expect(latestItemKey!(0)).not.toBe(historyKey)
    expect(messageRenderMock.mock.calls.at(-2)?.[0].metadata.sessionId).toBe("other-session")
  })

  it("refreshes summaries and loaded details without caching stale content or controls", () => {
    const item = {
      kind: "completed-turn" as const,
      itemKey: "turn:u1",
      turnKey: "turn:u1",
      revision: 1,
      detailRevision: 1,
      status: "completed" as const,
      userMessages: [{ id: "u1", role: "user" as const, text: "Question", createdAt: 1 }],
      finalResponse: { id: "a1", role: "assistant" as const, text: "Summary", createdAt: 2 },
      visibleResult: { id: "result", role: "assistant" as const, text: "Result", createdAt: 3 },
      collapsed: { exists: true, messageCount: 3, trailingCount: 1, mediaCount: 0 },
      startedAt: 1,
    }
    const props: TranscriptTimelineSurfaceProps = {
      sessionId: "s1",
      items: [item],
      expandedTurnKeys: new Set(),
      getDetail: () => undefined,
      onExpand: jest.fn(),
      onCollapse: jest.fn(),
      onLoadOlder: jest.fn(),
      onRetry: jest.fn(),
      hasMore: true,
      loading: false,
      loadingOlder: false,
      error: new Error("offline"),
      liveMessages: [],
      liveStatus: "idle",
      labels,
    }
    const { rerender } = render(<TranscriptTimelineSurface {...props} />)
    const streaming = {
      liveMessages: [
        { id: "live", role: "assistant" as const, parts: [{ type: "text" as const, text: "A" }] },
      ],
      liveStatus: "streaming" as const,
    }
    messageRenderMock.mockClear()
    rerender(<TranscriptTimelineSurface {...props} {...streaming} />)
    expect(messageRenderMock.mock.calls.map(([message]) => message.id)).toEqual(["live"])
    expect(screen.getAllByTestId(/^message-/).map((element) => element.textContent)).toEqual([
      "Question",
      "Summary",
      "Result",
      "A",
    ])
    fireEvent.click(screen.getByRole("button", { name: labels.loadOlder }))
    fireEvent.click(screen.getByRole("button", { name: labels.retry }))
    expect(props.onLoadOlder).toHaveBeenCalledTimes(1)
    expect(props.onRetry).toHaveBeenCalledTimes(1)
    rerender(
      <TranscriptTimelineSurface
        {...props}
        items={[
          { ...item, revision: 2, finalResponse: { ...item.finalResponse, text: "Revised" } },
        ]}
        expandedTurnKeys={new Set([item.turnKey])}
      />
    )
    expect(screen.getByTestId("message-a1")).toHaveTextContent("Revised")
    expect(screen.getByText(labels.loading)).toBeVisible()
    const detail = {
      messages: [
        {
          id: "a1",
          sessionId: "s1",
          turnKey: item.turnKey,
          role: "assistant" as const,
          parts: [{ type: "text" as const, text: "Full answer" }],
          createdAt: 2,
          metadata: { test: true },
        },
      ],
      revision: 2,
      detailRevision: 2,
      total: 1,
      approximateBytes: 100,
      hasMore: false,
    }
    rerender(
      <TranscriptTimelineSurface
        {...props}
        expandedTurnKeys={new Set([item.turnKey])}
        getDetail={() => detail}
        loadingOlder
        renderAdapters={{ onEditResend: jest.fn() }}
      />
    )
    expect(screen.getByTestId("message-a1")).toHaveTextContent("Full answer")
    expect(screen.getByTestId("message-a1")).toHaveAttribute("data-editable", "true")
    expect(screen.getByRole("button", { name: labels.loading })).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: labels.collapse }))
    expect(props.onCollapse).toHaveBeenCalledWith(item.turnKey)
    const expandedProps = {
      ...props,
      expandedTurnKeys: new Set([item.turnKey]),
      getDetail: () => detail,
    }
    rerender(<TranscriptTimelineSurface {...expandedProps} />)
    messageRenderMock.mockClear()
    rerender(<TranscriptTimelineSurface {...expandedProps} {...streaming} />)
    expect(messageRenderMock.mock.calls.map(([message]) => message.id)).toEqual(["live"])
    expect(screen.getByTestId("message-a1")).toHaveTextContent("Full answer")
    const onPageTurn = jest.fn()
    const pagedProps = {
      ...expandedProps,
      onPageTurn,
      getDetail: () => ({ ...detail, hasPrevious: true, hasMore: true, nextCursor: "next" }),
    }
    rerender(<TranscriptTimelineSurface {...pagedProps} />)
    fireEvent.click(screen.getByRole("button", { name: "Previous messages" }))
    fireEvent.click(screen.getByRole("button", { name: "Next messages" }))
    expect(onPageTurn.mock.calls).toEqual([
      [item.turnKey, "previous"],
      [item.turnKey, "next"],
    ])
    rerender(
      <TranscriptTimelineSurface {...pagedProps} loadingTurnKeys={new Set([item.turnKey])} />
    )
    expect(screen.getByRole("button", { name: "Previous messages" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Next messages" })).toBeDisabled()
    expect(screen.getByTestId("message-a1")).toHaveTextContent("Full answer")
  })

  it("renders a folded turn through MessageRenderer and expands lazily", () => {
    const onExpand = jest.fn()
    render(
      <TranscriptTimelineSurface
        sessionId="s1"
        items={[
          {
            kind: "completed-turn",
            itemKey: "turn:u1",
            turnKey: "turn:u1",
            revision: 2,
            detailRevision: 2,
            status: "completed",
            userMessages: [{ id: "u1", role: "user", text: "question", createdAt: 1 }],
            finalResponse: { id: "a1", role: "assistant", text: "answer", createdAt: 2 },
            collapsed: { exists: true, messageCount: 3, trailingCount: 1, mediaCount: 0 },
            startedAt: 1,
            completedAt: 2,
          },
        ]}
        expandedTurnKeys={new Set()}
        getDetail={() => undefined}
        onExpand={onExpand}
        onCollapse={jest.fn()}
        onLoadOlder={jest.fn()}
        onRetry={jest.fn()}
        hasMore={false}
        loading={false}
        loadingOlder={false}
        error={null}
        liveMessages={[]}
        liveStatus="idle"
        labels={labels}
      />
    )

    expect(screen.getByTestId("message-u1")).toHaveTextContent("question")
    expect(screen.getByTestId("message-a1")).toHaveTextContent("answer")
    fireEvent.click(screen.getByRole("button", { name: "Expand details" }))
    expect(onExpand).toHaveBeenCalledWith("turn:u1", 2, 2)
  })

  it("renders fetched detail and the active live lane without merging them into timeline state", () => {
    render(
      <TranscriptTimelineSurface
        sessionId="s1"
        items={[]}
        expandedTurnKeys={new Set(["turn:u1"])}
        getDetail={() => undefined}
        onExpand={jest.fn()}
        onCollapse={jest.fn()}
        onLoadOlder={jest.fn()}
        onRetry={jest.fn()}
        hasMore={false}
        loading={false}
        loadingOlder={false}
        error={null}
        liveMessages={[
          { id: "live", role: "assistant", parts: [{ type: "text", text: "stream" }] },
        ]}
        liveStatus="streaming"
        labels={labels}
        renderAdapters={{
          messageDisplay: resolveMessageDisplayOptions({ preset: "inspector" }),
        }}
      />
    )

    expect(screen.getByTestId("message-live")).toHaveTextContent("stream")
    expect(screen.getByTestId("message-live")).toHaveAttribute("data-preset", "inspector")
    expect(virtualizerMeasureMock).toHaveBeenCalled()
  })

  it("does not expose mutation controls for summary rows outside the writable window", () => {
    render(
      <TranscriptTimelineSurface
        sessionId="s1"
        items={[
          {
            kind: "completed-turn",
            itemKey: "turn:u1",
            turnKey: "turn:u1",
            revision: 1,
            detailRevision: 1,
            status: "completed",
            userMessages: [{ id: "u1", role: "user", text: "old", createdAt: 1 }],
            finalResponse: { id: "a1", role: "assistant", text: "done", createdAt: 2 },
            collapsed: { exists: false, messageCount: 2, trailingCount: 0, mediaCount: 0 },
            startedAt: 1,
            completedAt: 2,
          },
        ]}
        expandedTurnKeys={new Set()}
        getDetail={() => undefined}
        onExpand={jest.fn()}
        onCollapse={jest.fn()}
        onLoadOlder={jest.fn()}
        onRetry={jest.fn()}
        hasMore={false}
        loading={false}
        loadingOlder={false}
        error={null}
        liveMessages={[]}
        liveStatus="idle"
        labels={labels}
        renderAdapters={{
          onEditResend: jest.fn(),
          mutableMessageIds: new Set(),
        }}
      />
    )

    expect(screen.getByTestId("message-u1")).toHaveAttribute("data-editable", "false")
  })
})
