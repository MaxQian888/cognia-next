import { fireEvent, render, screen } from "@testing-library/react"
import type { UIMessage } from "ai"

import { TranscriptTimelineSurface } from "./transcript-timeline-surface"

jest.mock("./message-renderer", () => ({
  MessageRenderer: ({ message, onEditResend }: { message: UIMessage; onEditResend?: unknown }) => (
    <div data-testid={`message-${message.id}`} data-editable={Boolean(onEditResend)}>
      {message.parts.map((part) => (part.type === "text" ? part.text : part.type))}
    </div>
  ),
}))

jest.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (options: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: options.count }, (_, index) => ({
        index,
        key: index,
        start: index * 240,
      })),
    getTotalSize: () => options.count * 240,
    measureElement: jest.fn(),
  }),
}))

const labels = {
  expand: "Expand details",
  collapse: "Collapse details",
  loadOlder: "Load older",
  loading: "Loading",
  retry: "Retry",
}

describe("<TranscriptTimelineSurface />", () => {
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
      />
    )

    expect(screen.getByTestId("message-live")).toHaveTextContent("stream")
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
