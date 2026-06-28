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
})
