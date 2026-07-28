/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

const saveMock = jest.fn(async (_patch: Record<string, unknown>): Promise<void> => undefined)
const enqueueMock = jest.fn(async (_arg: unknown): Promise<void> => undefined)

const settingsRef: { current: Record<string, unknown> | undefined } = {
  current: { conversationTitle: { model: "fast" }, conversationTimeline: {} },
}

jest.mock("@/stores/settings", () => ({
  useSettingsStore: (
    selector: (s: {
      settings: Record<string, unknown> | undefined
      save: (patch: Record<string, unknown>) => Promise<void>
    }) => unknown
  ) =>
    selector({
      settings: settingsRef.current,
      save: async (patch: Record<string, unknown>) => {
        if (settingsRef.current) settingsRef.current = { ...settingsRef.current, ...patch }
        await saveMock(patch)
      },
    }),
}))

jest.mock("@/lib/db/mobile-outbound-queue", () => ({
  enqueue: (arg: unknown) => enqueueMock(arg),
}))

import Page from "./page"

beforeEach(() => {
  saveMock.mockReset()
  enqueueMock.mockReset()
  settingsRef.current = { conversationTitle: { model: "fast" }, conversationTimeline: {} }
})

describe("MobileConversationPage", () => {
  it("renders both toggles inside the shell, defaulting to on", () => {
    render(<Page />)
    expect(screen.getByTestId("mobile-conversation-page")).toBeInTheDocument()
    expect(screen.getByTestId("conversation-auto-title")).toBeChecked()
    expect(screen.getByTestId("conversation-timeline")).toBeChecked()
  })

  it("merge-updates conversationTitle, preserving sibling keys", async () => {
    render(<Page />)
    fireEvent.click(screen.getByTestId("conversation-auto-title"))
    await Promise.resolve()
    await Promise.resolve()
    expect(saveMock).toHaveBeenCalledWith({
      conversationTitle: { model: "fast", enabled: false },
    })
    expect(enqueueMock).toHaveBeenCalled()
  })

  it("merge-updates the timeline toggle", async () => {
    render(<Page />)
    fireEvent.click(screen.getByTestId("conversation-timeline"))
    await Promise.resolve()
    await Promise.resolve()
    expect(saveMock).toHaveBeenCalledWith({
      conversationTimeline: { enabled: false },
    })
  })

  it("falls back to enabled defaults when settings are absent", () => {
    settingsRef.current = undefined
    render(<Page />)
    expect(screen.getByTestId("conversation-auto-title")).toBeChecked()
    expect(screen.getByTestId("conversation-timeline")).toBeChecked()
  })

  it("reflects explicit disabled state from persisted settings", () => {
    settingsRef.current = {
      conversationTitle: { enabled: false },
      conversationTimeline: { enabled: false },
    }
    render(<Page />)
    expect(screen.getByTestId("conversation-auto-title")).not.toBeChecked()
    expect(screen.getByTestId("conversation-timeline")).not.toBeChecked()
  })

  it("renders the composer + stream toggles defaulting to on", () => {
    render(<Page />)
    expect(screen.getByTestId("composer-send-on-enter")).toBeChecked()
    expect(screen.getByTestId("composer-persist-drafts")).toBeChecked()
    expect(screen.getByTestId("conversation-stream-partial")).toBeChecked()
  })

  it("merge-updates composerBehavior, preserving sibling keys", async () => {
    settingsRef.current = { composerBehavior: { clearAfterSend: false } }
    render(<Page />)
    fireEvent.click(screen.getByTestId("composer-send-on-enter"))
    await Promise.resolve()
    await Promise.resolve()
    expect(saveMock).toHaveBeenCalledWith({
      composerBehavior: { clearAfterSend: false, sendOnEnter: false },
    })
  })

  it("writes streamPartialMessages directly", async () => {
    render(<Page />)
    fireEvent.click(screen.getByTestId("conversation-stream-partial"))
    await Promise.resolve()
    await Promise.resolve()
    expect(saveMock).toHaveBeenCalledWith({ streamPartialMessages: false })
  })

  it("renders the conversation-list section with its defaults", () => {
    render(<Page />)
    expect(screen.getByTestId("me-section-conversation-sidebar")).toBeInTheDocument()
    // Workspace grouping + unread default on; compact / preview / content-search off.
    expect(screen.getByTestId("conversation-sidebar-group-by")).toHaveTextContent("Workspace")
    expect(screen.getByTestId("conversation-sidebar-unread")).toBeChecked()
    expect(screen.getByTestId("conversation-sidebar-compact")).not.toBeChecked()
    expect(screen.getByTestId("conversation-sidebar-preview")).not.toBeChecked()
    expect(screen.getByTestId("conversation-sidebar-content-search")).not.toBeChecked()
  })

  it("merge-updates conversationSidebar, preserving sibling keys", async () => {
    settingsRef.current = { conversationSidebar: { showPreview: true } }
    render(<Page />)
    fireEvent.click(screen.getByTestId("conversation-sidebar-compact"))
    await Promise.resolve()
    await Promise.resolve()
    expect(saveMock).toHaveBeenCalledWith({
      conversationSidebar: { showPreview: true, density: "compact" },
    })
  })

  it("enabling content search writes searchScope=titleAndContent", async () => {
    render(<Page />)
    fireEvent.click(screen.getByTestId("conversation-sidebar-content-search"))
    await Promise.resolve()
    await Promise.resolve()
    expect(saveMock).toHaveBeenCalledWith({
      conversationSidebar: { searchScope: "titleAndContent" },
    })
  })
})
