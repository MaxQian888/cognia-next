/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"

let mockState: unknown = { status: "idle" }
jest.mock("@/hooks/inbox/use-triage-conversation", () => ({
  useTriageConversation: (id: string | null) => {
    mockRequested(id)
    return mockState
  },
}))
const mockRequested = jest.fn()

let mockWidth = 0
jest.mock("@/hooks/use-element-width", () => ({ useElementWidth: () => mockWidth }))
jest.mock("@/hooks/connectors/use-pending-drafts", () => ({
  usePendingDrafts: () => [{ id: "d1" }, { id: "d2" }],
}))
jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(() => false) }))

jest.mock("./triage-preview-header", () => ({
  TriagePreviewHeader: (props: {
    onOpenInChat: () => void
    onOpenContact: () => void
    onClose?: () => void
  }) => (
    <div data-testid="header-stub">
      <button type="button" onClick={props.onOpenInChat}>
        reply
      </button>
      <button type="button" onClick={props.onOpenContact}>
        contact
      </button>
    </div>
  ),
}))
jest.mock("./triage-controls", () => ({
  TriageControls: ({ onOpenSettings }: { onOpenSettings: () => void }) => (
    <button type="button" data-testid="controls-stub" onClick={onOpenSettings}>
      settings-from-controls
    </button>
  ),
}))
jest.mock("./triage-drafts-section", () => ({
  TriageDraftsSection: () => <div data-testid="drafts-stub" />,
}))
jest.mock("./triage-transcript-tail", () => ({
  TriageTranscriptTail: ({ layout }: { layout: string }) => (
    <div data-testid="transcript-stub" data-layout={layout} />
  ),
}))
jest.mock("./triage-details", () => ({
  TriageDetails: ({ onOpenBindings }: { onOpenBindings: () => void }) => (
    <button type="button" data-testid="details-stub" onClick={onOpenBindings}>
      bindings
    </button>
  ),
}))
jest.mock("../overrides/conversation-override-dialog", () => ({
  ConversationOverrideDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="settings-dialog" /> : null,
}))
jest.mock("../contact-profile-drawer", () => ({
  ContactProfileDrawer: ({ open }: { open: boolean }) =>
    open ? <div data-testid="contact-drawer" /> : null,
}))
jest.mock("../debug/callback-bindings-inspector", () => ({
  CallbackBindingsInspector: () => <div data-testid="bindings-inspector" />,
}))

import { useActiveConversationStore } from "@/stores/inbox/active-conversation-store"
import { TRIAGE_TWO_COLUMN_MIN_PX, TriagePreviewPane } from "./triage-preview-pane"

const CONVERSATION = {
  session: { id: "s1", title: "Acme" },
  conversationKey: "lark:a1:oc",
  adapterId: "a1",
  platform: "lark",
  override: undefined,
  adapter: undefined,
  policy: undefined,
  unreadCount: 2,
}

beforeEach(() => {
  mockState = { status: "idle" }
  mockWidth = 0
  mockRequested.mockReset()
})

describe("TriagePreviewPane", () => {
  describe("empty state", () => {
    it("explains the pane, counts the waiting work and shows how to drive it", () => {
      render(
        <TriagePreviewPane
          sessionId={null}
          summary={{ total: 9, unread: 3, pending: 1, snoozed: 0 }}
          onOpenInChat={() => {}}
        />
      )
      expect(
        screen.getByRole("heading", { name: "Triage without leaving the inbox" })
      ).toBeInTheDocument()
      expect(screen.getByTestId("triage-empty-count-unread")).toHaveTextContent("3")
      expect(screen.getByTestId("triage-empty-count-pending")).toHaveTextContent("1")
      expect(screen.getByTestId("triage-empty-count-snoozed")).toHaveTextContent("0")
      expect(screen.getByTestId("triage-empty-count-drafts")).toHaveTextContent("2")
      expect(screen.getByTestId("triage-empty-counts")).toHaveAccessibleName("9 open conversations")
      expect(screen.getByRole("list", { name: "How to use the list" })).toHaveTextContent(
        /Double-click/
      )
    })

    it("omits the counts until the list has loaded", () => {
      render(<TriagePreviewPane sessionId={null} onOpenInChat={() => {}} />)
      expect(screen.queryByTestId("triage-empty-counts")).not.toBeInTheDocument()
    })
  })

  it("shows a skeleton while the session loads", () => {
    mockState = { status: "loading" }
    render(<TriagePreviewPane sessionId="s1" onOpenInChat={() => {}} />)
    expect(screen.getByTestId("triage-loading")).toHaveAttribute("aria-busy", "true")
  })

  it("explains a missing session and offers to close the preview", () => {
    mockState = { status: "missing" }
    const onClose = jest.fn()
    render(<TriagePreviewPane sessionId="gone" onOpenInChat={() => {}} onClose={onClose} />)
    expect(screen.getByText("Conversation not found")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("triage-missing-clear"))
    expect(onClose).toHaveBeenCalled()
  })

  describe("ready", () => {
    beforeEach(() => {
      mockState = { status: "ready", conversation: CONVERSATION }
    })

    it("stacks the sections in one scroller when narrow, transcript in flow", () => {
      mockWidth = TRIAGE_TWO_COLUMN_MIN_PX - 1
      render(<TriagePreviewPane sessionId="s1" onOpenInChat={() => {}} />)
      expect(screen.getByTestId("triage-preview-body")).toHaveAttribute("data-layout", "stacked")
      expect(screen.getByTestId("transcript-stub")).toHaveAttribute("data-layout", "flow")
      expect(screen.queryByTestId("triage-rail")).not.toBeInTheDocument()
    })

    it("splits into transcript + triage rail when wide", () => {
      mockWidth = TRIAGE_TWO_COLUMN_MIN_PX
      render(<TriagePreviewPane sessionId="s1" onOpenInChat={() => {}} />)
      expect(screen.getByTestId("triage-preview-body")).toHaveAttribute("data-layout", "two-column")
      expect(screen.getByTestId("transcript-stub")).toHaveAttribute("data-layout", "fill")
      expect(screen.getByTestId("triage-rail")).toContainElement(
        screen.getByTestId("controls-stub")
      )
    })

    it("stays stacked when the host forces it (a drawer)", () => {
      mockWidth = 2000
      render(<TriagePreviewPane sessionId="s1" onOpenInChat={() => {}} layout="stacked" />)
      expect(screen.getByTestId("triage-preview-body")).toHaveAttribute("data-layout", "stacked")
    })

    it("hands the conversation to Reply in chat", () => {
      const onOpenInChat = jest.fn()
      render(<TriagePreviewPane sessionId="s1" onOpenInChat={onOpenInChat} />)
      fireEvent.click(screen.getByText("reply"))
      expect(onOpenInChat).toHaveBeenCalledWith(CONVERSATION)
    })

    it("opens the settings dialog and contact drawer it hosts", () => {
      render(<TriagePreviewPane sessionId="s1" onOpenInChat={() => {}} />)
      fireEvent.click(screen.getByTestId("controls-stub"))
      expect(screen.getByTestId("settings-dialog")).toBeInTheDocument()
      fireEvent.click(screen.getByText("contact"))
      expect(screen.getByTestId("contact-drawer")).toBeInTheDocument()
    })

    it("does not mount the desktop-only bindings inspector on the web", () => {
      render(<TriagePreviewPane sessionId="s1" onOpenInChat={() => {}} />)
      expect(screen.queryByTestId("bindings-inspector")).not.toBeInTheDocument()
    })

    it("never registers as a viewed conversation", () => {
      render(<TriagePreviewPane sessionId="s1" onOpenInChat={() => {}} />)
      const state = useActiveConversationStore.getState()
      expect(state.activeConversationKey).toBeNull()
      expect(state.visiblePanes).toEqual({})
    })
  })
})
