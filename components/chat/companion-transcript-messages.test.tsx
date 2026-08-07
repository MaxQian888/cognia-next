import { render, screen } from "@testing-library/react"
import type { UIMessage } from "ai"

import {
  CompanionTranscriptMessages,
  selectActiveTurnMessages,
} from "./companion-transcript-messages"

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
      items: [],
      expandedTurnKeys: new Set(),
      hasMore: false,
      loading: false,
      loadingOlder: false,
      error: null,
    },
    getDetail: jest.fn(),
    expandTurn: jest.fn(),
    collapseTurn: jest.fn(),
    loadOlder: jest.fn(),
    retry: jest.fn(),
  }),
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
  beforeEach(() => surfaceProps.splice(0))

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
      />
    )

    expect(screen.getByTestId("timeline-surface")).toBeInTheDocument()
    expect((surfaceProps[0]?.liveMessages as UIMessage[]).map((message) => message.id)).toEqual([
      "u2",
      "a2",
    ])
    expect(surfaceProps[0]?.renderAdapters).toMatchObject({
      onCopy,
      onRegenerate,
      onEditResend,
    })
  })
})
