/** @jest-environment jsdom */
import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ChatSession } from "@cognia/agent-config-types"

import {
  SessionSummaryButton,
  SessionSummaryStageHost,
  useSummaryCardRuntime,
} from "./session-summary-trigger"
import { useSessionNeedsYou } from "@/hooks/chat/use-session-needs-you"
import { useAppShortcut } from "@/hooks/shortcuts/use-app-shortcut"
import { useChatStore } from "@/stores/chat"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    `${key}${values ? JSON.stringify(values) : ""}`,
}))
let stageWidth = 0
jest.mock("@/hooks/use-element-axis-size", () => ({
  useElementAxisSize: jest.fn((el: HTMLElement | null, axis: "width" | "height") =>
    !el ? 0 : axis === "width" ? stageWidth : 800
  ),
}))
jest.mock("@/hooks/chat/use-session-needs-you", () => ({ useSessionNeedsYou: jest.fn() }))
jest.mock("@/hooks/shortcuts/use-app-shortcut", () => ({ useAppShortcut: jest.fn() }))
jest.mock("@/stores/chat", () => ({ useChatStore: jest.fn() }))
jest.mock("./session-summary-card", () => ({
  SessionSummaryCard: ({
    mode,
    width,
    maxHeight,
    onNavigated,
    onManage,
    onManageSources,
    onHide,
  }: {
    mode: string
    width: number
    maxHeight?: number | string
    onNavigated: () => void
    onManage: () => void
    onManageSources: () => void
    onHide?: () => void
  }) => (
    <div data-testid={`card-${mode}`} data-width={width} data-max-height={maxHeight}>
      <button type="button" onClick={onNavigated}>
        navigate
      </button>
      <button type="button" onClick={onManage}>
        settings
      </button>
      <button type="button" onClick={onManageSources}>
        manage
      </button>
      {onHide ? (
        <button type="button" onClick={onHide}>
          hide
        </button>
      ) : null}
    </div>
  ),
}))
jest.mock("@/components/chat/session-settings-sheet", () => ({
  SessionSettingsSheet: ({ open, focusSection }: { open: boolean; focusSection?: string }) =>
    open ? <div data-testid="settings-sheet">{focusSection ?? "whole"}</div> : null,
}))

const session = { id: "s1", title: "T", createdAt: 1 } as unknown as ChatSession

function setActive(id: string | null) {
  jest
    .mocked(useChatStore)
    .mockImplementation(((selector: (s: { activeSessionId: string | null }) => unknown) =>
      selector({ activeSessionId: id })) as never)
}

/** The workspace shape: the button in the bar, the host on a measured stage. */
function renderWorkspace(width: number) {
  stageWidth = width
  return render(
    <>
      <SessionSummaryButton session={session} />
      <div data-slot="chat-surface-stage">
        <SessionSummaryStageHost session={session} />
      </div>
    </>
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(useSessionNeedsYou).mockReturnValue({ items: [], jumpMessageId: null })
  setActive("s1")
  useSummaryCardRuntime.setState({ placement: {}, hidden: {} })
})

describe("on a stage too narrow to float", () => {
  it("opens the card as a popover under the button", async () => {
    const user = userEvent.setup()
    renderWorkspace(900)
    const trigger = screen.getByTestId("session-summary-trigger")
    expect(screen.queryByTestId("card-float")).not.toBeInTheDocument()
    expect(trigger).toHaveAttribute("aria-expanded", "false")
    await user.click(trigger)
    const card = await screen.findByTestId("card-popover")
    expect(card).toHaveAttribute("data-width", "288")
    expect(card).toHaveAttribute("data-max-height", "var(--radix-popover-content-available-height)")
    expect(trigger).toHaveAttribute("aria-expanded", "true")
  })

  it("closes the popover after a row hands the user to the dock", async () => {
    const user = userEvent.setup()
    renderWorkspace(900)
    await user.click(screen.getByTestId("session-summary-trigger"))
    await user.click(await screen.findByRole("button", { name: "navigate" }))
    expect(screen.queryByTestId("card-popover")).not.toBeInTheDocument()
  })
})

describe("on a stage with room beside the chat column", () => {
  it("floats the card on the stage without being asked", () => {
    renderWorkspace(1600)
    const card = screen.getByTestId("card-float")
    // 800 tall stage − 12 (top inset) − 16 (margin)
    expect(card).toHaveAttribute("data-max-height", "772")
    expect(screen.getByTestId("session-summary-trigger")).toHaveAttribute("aria-expanded", "true")
  })

  it("hides and shows it from the bar button and from the card", async () => {
    const user = userEvent.setup()
    renderWorkspace(1600)
    await user.click(screen.getByTestId("session-summary-trigger"))
    expect(screen.queryByTestId("card-float")).not.toBeInTheDocument()
    expect(useSummaryCardRuntime.getState().hidden).toEqual({ s1: true })
    await user.click(screen.getByTestId("session-summary-trigger"))
    await user.click(screen.getByRole("button", { name: "hide" }))
    expect(screen.queryByTestId("card-float")).not.toBeInTheDocument()
    // Never both: a floating card means no popover.
    expect(screen.queryByTestId("card-popover")).not.toBeInTheDocument()
  })

  it("falls back to the popover once the stage host is gone", async () => {
    const user = userEvent.setup()
    const view = renderWorkspace(1600)
    view.rerender(<SessionSummaryButton session={session} />)
    expect(useSummaryCardRuntime.getState().placement).toEqual({})
    await user.click(screen.getByTestId("session-summary-trigger"))
    expect(await screen.findByTestId("card-popover")).toBeInTheDocument()
  })
})

it("uses the popover on a host without a stage", async () => {
  const user = userEvent.setup()
  render(<SessionSummaryButton session={session} />)
  await user.click(screen.getByTestId("session-summary-trigger"))
  expect(await screen.findByTestId("card-popover")).toBeInTheDocument()
})

it("flags pending requests on the button while the card is out of sight", () => {
  jest.mocked(useSessionNeedsYou).mockReturnValue({
    items: [{ kind: "approval", id: "a", label: "Run" }],
    jumpMessageId: "m1",
  })
  renderWorkspace(900)
  expect(screen.getByTestId("session-summary-trigger")).toHaveAccessibleName(
    'triggerPending{"count":1}'
  )
})

it("opens the session settings whole, or at the capabilities section", async () => {
  const user = userEvent.setup()
  const view = renderWorkspace(1600)
  await user.click(screen.getByRole("button", { name: "settings" }))
  expect(screen.getByTestId("settings-sheet")).toHaveTextContent("whole")
  view.unmount()
  renderWorkspace(1600)
  await user.click(screen.getByRole("button", { name: "manage" }))
  expect(screen.getByTestId("settings-sheet")).toHaveTextContent("power")
})

it("binds the shortcut only for the focused conversation", () => {
  renderWorkspace(1600)
  const [id, handler, options] = jest.mocked(useAppShortcut).mock.calls.at(-1)!
  expect(id).toBe("chat.summaryToggle")
  expect(options).toMatchObject({ enabled: true })
  act(() => handler(new KeyboardEvent("keydown")))
  expect(useSummaryCardRuntime.getState().hidden).toEqual({ s1: true })

  setActive("other")
  render(<SessionSummaryButton session={session} />)
  expect(jest.mocked(useAppShortcut).mock.calls.at(-1)![2]).toMatchObject({ enabled: false })
})

describe("useSummaryCardRuntime", () => {
  it("ignores no-op writes", () => {
    const before = useSummaryCardRuntime.getState()
    before.setHidden("s1", false)
    before.setPlacement("s1", null)
    expect(useSummaryCardRuntime.getState()).toBe(before)
    before.setPlacement("s1", { mode: "float", width: 288 })
    const after = useSummaryCardRuntime.getState()
    after.setPlacement("s1", { mode: "float", width: 288 })
    expect(useSummaryCardRuntime.getState()).toBe(after)
  })
})
