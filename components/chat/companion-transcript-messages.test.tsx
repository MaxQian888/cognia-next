import { render, screen } from "@testing-library/react"
import type { UIMessage } from "ai"

import {
  CompanionTranscriptMessages,
  selectActiveTurnMessages,
} from "./companion-transcript-messages"

const mockPageTurn = jest.fn()
const mockTimeline: { items: unknown[]; revision: number | null } = { items: [], revision: null }
const mockLiveReply: { current: unknown } = { current: null }

const surfaceProps: Array<Record<string, unknown>> = []

jest.mock("./transcript-timeline-surface", () => ({
  TranscriptTimelineSurface: (props: Record<string, unknown>) => {
    surfaceProps.push(props)
    return <div data-testid="timeline-surface" />
  },
}))

jest.mock("@/hooks/chat/session-media-provider", () => ({
  SessionMediaProvider: ({ children }: { children: React.ReactNode }) => children,
}))

jest.mock("@/hooks/chat/use-transcript-controller", () => ({
  useTranscriptController: () => ({
    snapshot: {
      items: mockTimeline.items,
      revision: mockTimeline.revision,
      expandedTurnKeys: new Set(),
      loadingTurnKeys: new Set(["turn:u1"]),
      hasMore: false,
      loading: false,
      loadingOlder: false,
      error: null,
    },
    getDetail: jest.fn(),
    expandTurn: jest.fn(),
    pageTurn: mockPageTurn,
    collapseTurn: jest.fn(),
    loadOlder: jest.fn(),
    retry: jest.fn(),
  }),
}))

jest.mock("@/hooks/chat/use-transcript-live-turn", () => ({
  useTranscriptLiveTurn: () => mockLiveReply.current,
}))

jest.mock("@/lib/data-hooks/context", () => ({ useCharacters: () => [] }))
jest.mock("@/hooks/data/use-stable-character-by-id", () => ({
  useStableCharacterById: () => new Map(),
}))
jest.mock("@/lib/tauri/transport-instance", () => ({
  transport: { call: jest.fn(), subscribe: jest.fn() },
}))
jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

const messages: UIMessage[] = [
  { id: "u1", role: "user", parts: [{ type: "text", text: "old" }] },
  { id: "a1", role: "assistant", parts: [{ type: "text", text: "done" }] },
  { id: "u2", role: "user", parts: [{ type: "text", text: "new" }] },
  { id: "a2", role: "assistant", parts: [{ type: "text", text: "typing" }] },
]

describe("selectActiveTurnMessages", () => {
  it("retains only the unfinished turn while streaming", () => {
    expect(selectActiveTurnMessages(messages, "streaming").map((message) => message.id)).toEqual([
      "u2",
      "a2",
    ])
  })

  it("retains no completed tail while idle", () => {
    expect(selectActiveTurnMessages(messages, "idle")).toEqual([])
  })
})

describe("<CompanionTranscriptMessages />", () => {
  beforeEach(() => {
    surfaceProps.splice(0)
    mockTimeline.items = []
    mockTimeline.revision = null
    mockLiveReply.current = null
  })

  const liveReply = (state: "streaming" | "settled") => ({
    sessionId: "s1",
    messageId: "assistant-x",
    replyTo: "u2",
    seq: 4,
    parts: [{ type: "text", text: "live words" }],
    state,
    stale: false,
  })

  it("p6e draws a member agent's live reply in place of the timeline's older copy", () => {
    mockTimeline.items = [
      {
        kind: "completed-turn",
        itemKey: "turn:u2",
        turnKey: "turn:u2",
        revision: 5,
        detailRevision: 5,
        status: "completed",
        userMessages: [{ id: "u2", role: "user", text: "new", createdAt: 1 }],
        finalResponse: { id: "assistant-x", role: "assistant", text: "live", createdAt: 2 },
        collapsed: { exists: true, messageCount: 2, trailingCount: 0, mediaCount: 0 },
        startedAt: 1,
      },
    ]
    mockLiveReply.current = liveReply("streaming")
    render(
      <CompanionTranscriptMessages
        sessionId="s1"
        messages={messages}
        status="streaming"
        onCopy={jest.fn()}
      />
    )
    const [turn] = surfaceProps[0]?.items as Array<Record<string, unknown>>
    expect(turn?.userMessages).toEqual([{ id: "u2", role: "user", text: "new", createdAt: 1 }])
    expect(turn?.finalResponse).toBeUndefined()
    expect(surfaceProps[0]?.liveMessages).toEqual([
      { id: "assistant-x", role: "assistant", parts: [{ type: "text", text: "live words" }] },
    ])
  })

  it("p6e keeps a finished live reply after the turn settles, and drops a streaming one", () => {
    mockLiveReply.current = liveReply("settled")
    render(
      <CompanionTranscriptMessages
        sessionId="s1"
        messages={messages}
        status="idle"
        onCopy={jest.fn()}
      />
    )
    // The timeline has not read this turn yet: the store's tail draws the user side.
    expect((surfaceProps[0]?.liveMessages as UIMessage[]).map((message) => message.id)).toEqual([
      "u2",
      "a2",
      "assistant-x",
    ])
    surfaceProps.splice(0)
    // A reply still marked streaming once the Host says the turn ended is stale.
    mockLiveReply.current = liveReply("streaming")
    render(
      <CompanionTranscriptMessages
        sessionId="s1"
        messages={messages}
        status="idle"
        onCopy={jest.fn()}
      />
    )
    expect(surfaceProps[0]?.liveMessages).toEqual([])
  })

  it("leaves AI rewrite actions absent when the conversation does not support them", () => {
    render(
      <CompanionTranscriptMessages
        sessionId="platform-session"
        messages={messages}
        status="idle"
        onCopy={jest.fn()}
      />
    )

    expect(surfaceProps[0]?.renderAdapters).toMatchObject({
      onRegenerate: undefined,
      onEditResend: undefined,
    })
  })

  it("wires the bounded transcript surface with active-turn messages and local actions", () => {
    const onCopy = jest.fn()
    const onRegenerate = jest.fn()
    const onEditResend = jest.fn()

    render(
      <CompanionTranscriptMessages
        sessionId="s1"
        messages={messages}
        status="streaming"
        onCopy={onCopy}
        onRegenerate={onRegenerate}
        onEditResend={onEditResend}
        messageDisplayOverride={{ preset: "focused" }}
      />
    )

    expect(screen.getByTestId("timeline-surface")).toBeInTheDocument()
    ;(surfaceProps[0].onPageTurn as (key: string, direction: string) => void)("turn:u1", "next")
    expect(mockPageTurn).toHaveBeenCalledWith("turn:u1", "next")
    expect(surfaceProps[0].loadingTurnKeys).toEqual(new Set(["turn:u1"]))
    expect((surfaceProps[0]?.liveMessages as UIMessage[]).map((message) => message.id)).toEqual([
      "u2",
      "a2",
    ])
    expect(surfaceProps[0]?.renderAdapters).toMatchObject({
      onCopy,
      onRegenerate,
      onEditResend,
      messageDisplay: { preset: "focused" },
    })
  })
})
