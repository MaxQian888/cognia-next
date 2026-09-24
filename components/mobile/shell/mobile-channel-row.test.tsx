/**
 * @jest-environment jsdom
 */
import "@/components/interactions/test-pointer-polyfill"
import { act, fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { Character, ChatSession, Team } from "@cognia/agent-config-types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
  useFormatter: () => ({
    dateTime: (date: Date, options: Record<string, unknown>) =>
      `dt:${date.getTime()}:${Object.keys(options).join(",")}`,
  }),
  useNow: () => new Date(2026, 8, 24, 12, 0, 0),
  // The runner's own zone: the fixtures are written in local time.
  useTimeZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
}))
jest.mock("@/lib/capacitor/haptics", () => ({
  impact: () => Promise.resolve({ kind: "ok" }),
}))

import {
  MobileChannelRow,
  resolveMobileRowMetadata,
  type MobileChannelRowProps,
  type MobileChannelRowSettings,
} from "./mobile-channel-row"

const settings: MobileChannelRowSettings = {
  density: "comfortable",
  showPreview: false,
  showTimestamps: true,
  showCustomIcons: true,
  metadataFields: [],
  groupAxis: null,
}

const baseSession: ChatSession = {
  id: "s1",
  title: "Daily standup",
  createdAt: 1,
  updatedAt: new Date(2026, 8, 24, 9, 30).getTime(),
  kind: "direct",
}

function renderRow(overrides: Partial<MobileChannelRowProps> = {}) {
  const props: MobileChannelRowProps = {
    session: baseSession,
    active: false,
    unread: 0,
    contentMatch: false,
    settings,
    renaming: false,
    actionsHintId: "hint",
    onSelect: jest.fn(),
    onOpenActions: jest.fn(),
    onSwipeAction: jest.fn(),
    onCommitRename: jest.fn(),
    onCancelRename: jest.fn(),
    ...overrides,
  }
  const utils = render(<MobileChannelRow {...props} />)
  return { ...utils, props }
}

describe("<MobileChannelRow />", () => {
  it("is memoized, so unchanged rows skip a list re-render", () => {
    expect((MobileChannelRow as unknown as { $$typeof: symbol }).$$typeof).toBe(
      Symbol.for("react.memo")
    )
  })

  it("opens the conversation on tap and is described by the shared actions hint", async () => {
    const user = userEvent.setup()
    const { props } = renderRow()
    const row = screen.getByTestId("mobile-channel-row-s1")
    expect(row).toHaveAttribute("aria-describedby", "hint")
    await user.click(row)
    expect(props.onSelect).toHaveBeenCalledWith("s1")
  })

  it("ellipsizes the title inside a shrinkable column", () => {
    renderRow({ session: { ...baseSession, title: "A very long title ".repeat(10) } })
    const title = screen.getByText(/A very long title/)
    expect(title).toHaveClass("truncate", "min-w-0", "flex-1")
    expect(title.parentElement?.parentElement).toHaveClass("min-w-0", "flex-1")
  })

  it("falls back to the untitled label for an empty title", () => {
    renderRow({ session: { ...baseSession, title: "" } })
    expect(screen.getByTestId("mobile-channel-row-s1")).toHaveTextContent("untitled")
  })

  it("opens the action sheet on a long-press without also opening the conversation", () => {
    jest.useFakeTimers()
    try {
      const { props } = renderRow()
      const row = screen.getByTestId("mobile-channel-row-s1")
      fireEvent.pointerDown(row, { clientX: 10, clientY: 10, pointerType: "touch" })
      act(() => {
        jest.advanceTimersByTime(500)
      })
      fireEvent.pointerUp(row, { clientX: 10, clientY: 10, pointerType: "touch" })
      fireEvent.click(row)
      expect(props.onOpenActions).toHaveBeenCalledWith("s1")
      expect(props.onSelect).not.toHaveBeenCalled()
    } finally {
      jest.useRealTimers()
    }
  })

  it("opens the action sheet from the context-menu key or a right-click", () => {
    const { props } = renderRow()
    fireEvent.contextMenu(screen.getByTestId("mobile-channel-row-s1"))
    expect(props.onOpenActions).toHaveBeenCalledWith("s1")
  })

  it("offers Pin on the leading swipe and More / Archive / Delete on the trailing one", async () => {
    const user = userEvent.setup()
    const { props } = renderRow()
    for (const action of ["pin", "more", "archive", "delete"] as const) {
      await user.click(screen.getByTestId(`swipe-action-${action}`))
      expect(props.onSwipeAction).toHaveBeenLastCalledWith("s1", action)
    }
    expect(screen.getByTestId("swipe-action-pin")).toHaveTextContent("swipePin")
  })

  it("labels the swipe actions for the row's own state", () => {
    renderRow({ session: { ...baseSession, pinned: true, archivedAt: 5 } })
    expect(screen.getByTestId("swipe-action-pin")).toHaveTextContent("swipeUnpin")
    expect(screen.getByTestId("swipe-action-archive")).toHaveTextContent("swipeUnarchive")
  })

  it("marks a handed-off conversation read-only and offers only the action sheet", () => {
    renderRow({
      session: {
        ...baseSession,
        handoffLock: { ticketId: "t", state: "frozen" } as ChatSession["handoffLock"],
      },
    })
    expect(screen.getByTestId("mobile-channel-locked-s1")).toHaveAccessibleName("handoffReadonly")
    expect(screen.getByTestId("swipe-action-more")).toBeInTheDocument()
    expect(screen.queryByTestId("swipe-action-pin")).toBeNull()
    expect(screen.queryByTestId("swipe-action-archive")).toBeNull()
    expect(screen.queryByTestId("swipe-action-delete")).toBeNull()
  })

  it("badges unread messages with an announced count", () => {
    renderRow({ unread: 3 })
    const badge = screen.getByTestId("mobile-channel-unread-s1")
    expect(badge).toHaveTextContent("3")
    expect(within(badge).getByText('unreadCount:{"count":3}')).toHaveClass("sr-only")
    expect(screen.getByText("Daily standup")).toHaveClass("font-semibold")
  })

  it("caps the badge text at 99+", () => {
    renderRow({ unread: 250 })
    expect(screen.getByTestId("mobile-channel-unread-s1")).toHaveTextContent("99+")
  })

  it("shows the compact activity timestamp, and hides it when timestamps are off", () => {
    const { unmount } = renderRow()
    const time = screen.getByTestId("mobile-channel-time-s1")
    expect(time.tagName).toBe("TIME")
    // Same day → the clock-time shape.
    expect(time).toHaveTextContent(`dt:${baseSession.updatedAt}:hour,minute`)
    unmount()
    renderRow({ settings: { ...settings, showTimestamps: false } })
    expect(screen.queryByTestId("mobile-channel-time-s1")).toBeNull()
  })

  // A row mounted before midnight kept printing "09:30" all of the next day.
  it("shapes the stamp against the list's day clock, not its own mount time", () => {
    const nextDay = new Date(2026, 8, 25, 8, 0).getTime()
    renderRow({ now: nextDay })
    expect(screen.getByTestId("mobile-channel-time-s1")).toHaveTextContent(
      `dt:${baseSession.updatedAt}:weekday`
    )
  })

  it("prefers the last message time over a newer metadata write", () => {
    renderRow({ session: { ...baseSession, lastMessageAt: 100, updatedAt: 200 } })
    expect(screen.getByTestId("mobile-channel-time-s1")).toHaveTextContent(/^dt:100:/)
  })

  it("says why a row surfaced when only its messages matched", () => {
    renderRow({ contentMatch: true })
    expect(screen.getByTestId("mobile-channel-content-match-s1")).toHaveTextContent("contentMatch")
  })

  it("shows the preview line only when the preference is on", () => {
    const session = { ...baseSession, lastMessagePreview: "see you at 9" }
    const { unmount } = renderRow({ session })
    expect(screen.queryByTestId("mobile-channel-subtitle-s1")).toBeNull()
    unmount()
    renderRow({ session, settings: { ...settings, showPreview: true } })
    expect(screen.getByTestId("mobile-channel-subtitle-s1")).toHaveTextContent("see you at 9")
  })

  it("renders the chosen metadata fields in order", () => {
    const character = { id: "c1", name: "Octopus", avatarColor: "#abc" } as Character
    renderRow({
      session: { ...baseSession, characterId: "c1", model: "custom-model" },
      character,
      settings: { ...settings, metadataFields: ["agent", "model"] },
    })
    const line = screen.getByTestId("mobile-channel-metadata-s1")
    expect(
      Array.from(line.querySelectorAll("[data-metadata-kind]")).map((el) =>
        el.getAttribute("data-metadata-kind")
      )
    ).toEqual(["agent", "model"])
    expect(line).toHaveTextContent("Octopus")
    expect(line).toHaveTextContent("custom-model")
  })

  it("shows the bound agent's avatar, or the kind icon when custom icons are off", () => {
    const character = { id: "c1", name: "Octopus", avatarEmoji: "🐙", avatarColor: "#abc" } as Character
    const session = { ...baseSession, characterId: "c1" }
    const { unmount } = renderRow({ session, character })
    expect(screen.getByText("🐙")).toBeInTheDocument()
    unmount()
    renderRow({ session, character, settings: { ...settings, showCustomIcons: false } })
    expect(screen.queryByText("🐙")).toBeNull()
  })

  it("uses the team's face for a team conversation", () => {
    const team = { id: "t1", name: "Squad", avatarEmoji: "🛡", avatarColor: "#123" } as Team
    renderRow({ session: { ...baseSession, kind: "team", teamId: "t1" }, team })
    expect(screen.getByText("🛡")).toBeInTheDocument()
  })

  it("derives an unbound conversation's initials from its words, not its punctuation", () => {
    renderRow({ session: { ...baseSession, title: "Document mobile tab bar #399" } })
    expect(screen.getByText("DB")).toBeInTheDocument()
    expect(screen.queryByText("D#")).toBeNull()
  })

  it("marks the open conversation", () => {
    renderRow({ active: true })
    const row = screen.getByTestId("mobile-channel-row-s1")
    expect(row).toHaveAttribute("data-active", "true")
    expect(row).toHaveAttribute("aria-current", "true")
    expect(screen.getByTestId("mobile-channel-row-active-bar")).toBeInTheDocument()
  })

  describe("rename", () => {
    it("commits a trimmed new title on Enter, once", async () => {
      const user = userEvent.setup()
      const { props } = renderRow({ renaming: true })
      const input = screen.getByTestId("mobile-channel-rename-s1")
      expect(input).toHaveAttribute("type", "text")
      expect(input).toHaveFocus()
      await user.clear(input)
      await user.type(input, "  Renamed  {Enter}")
      fireEvent.blur(input)
      expect(props.onCommitRename).toHaveBeenCalledTimes(1)
      expect(props.onCommitRename).toHaveBeenCalledWith("s1", "Renamed")
    })

    it("commits on blur, the way a phone keyboard is usually dismissed", async () => {
      const user = userEvent.setup()
      const { props } = renderRow({ renaming: true })
      const input = screen.getByTestId("mobile-channel-rename-s1")
      await user.type(input, "!")
      fireEvent.blur(input)
      expect(props.onCommitRename).toHaveBeenCalledWith("s1", "Daily standup!")
    })

    it("cancels on Escape without letting the drawer close", () => {
      const { props } = renderRow({ renaming: true })
      const input = screen.getByTestId("mobile-channel-rename-s1")
      const notCancelled = fireEvent.keyDown(input, { key: "Escape" })
      expect(notCancelled).toBe(false)
      expect(props.onCancelRename).toHaveBeenCalledWith("s1")
      expect(props.onCommitRename).not.toHaveBeenCalled()
    })

    it("treats an unchanged or blank title as a cancel", async () => {
      const user = userEvent.setup()
      const { props } = renderRow({ renaming: true })
      const input = screen.getByTestId("mobile-channel-rename-s1")
      await user.clear(input)
      await user.type(input, "   {Enter}")
      expect(props.onCommitRename).not.toHaveBeenCalled()
      expect(props.onCancelRename).toHaveBeenCalledWith("s1")
    })
  })
})

describe("resolveMobileRowMetadata", () => {
  const character = { id: "c1", name: "Octopus", model: "char-model" } as Character
  const session: ChatSession = { ...baseSession, characterId: "c1", projectId: "w1" }

  it("resolves each field from the conversation, then its agent, then the defaults", () => {
    expect(
      resolveMobileRowMetadata({
        session,
        character,
        workspaceName: "Alpha",
        fields: ["workspace", "agent", "model"],
        groupAxis: null,
      })
    ).toEqual([
      { kind: "workspace", value: "Alpha" },
      { kind: "agent", value: "Octopus" },
      { kind: "model", value: "char-model" },
    ])
  })

  it("drops a field the section header above already names", () => {
    const fields = ["workspace", "agent"] as const
    expect(
      resolveMobileRowMetadata({ session, character, workspaceName: "Alpha", fields: [...fields], groupAxis: "workspace" })
    ).toEqual([{ kind: "agent", value: "Octopus" }])
    expect(
      resolveMobileRowMetadata({ session, character, workspaceName: "Alpha", fields: [...fields], groupAxis: "agent" })
    ).toEqual([{ kind: "workspace", value: "Alpha" }])
  })

  it("skips a field with nothing to say", () => {
    expect(
      resolveMobileRowMetadata({ session: baseSession, fields: ["agent", "workspace"], groupAxis: null })
    ).toEqual([])
  })
})
