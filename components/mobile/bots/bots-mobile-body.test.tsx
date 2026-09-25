/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react"

import type { BotConsoleRow, BotConsoleSummary } from "@/lib/bot/console/bot-rows"

let rows: BotConsoleRow[] = []
let summary: BotConsoleSummary = { total: 0, armed: 0, needsAttention: 0, deadLetters: 0 }
let loading = false
let failed = false

jest.mock("@/hooks/bots/use-bot-installations", () => ({
  useBotInstallations: () => ({ rows, summary, loading, failed }),
  enabledPluginKey: () => "",
}))
jest.mock("@/components/bots/bot-runtime-notice", () => ({
  BotRuntimeNotice: ({ hasBots }: { hasBots?: boolean }) => (
    <div data-testid="bot-runtime-notice-stub" data-has-bots={String(hasBots)} />
  ),
}))
jest.mock("@/components/bots/install-bot-sheet", () => ({
  InstallBotSheet: ({ open }: { open: boolean }) =>
    open ? <div data-testid="install-bot-sheet-stub" /> : null,
}))

// The detail subtree has its own suite; what matters here is which surface it
// lands in and what its props hand back.
let detailProps: Record<string, unknown> | undefined
jest.mock("@/components/bots/bot-detail", () => ({
  BotDetail: (props: Record<string, unknown>) => {
    detailProps = props
    const row = props.row as { id: string } | null
    return <div data-testid="mobile-bot-detail">{row?.id ?? "none"}</div>
  },
}))
jest.mock("@/components/shared/responsive-detail-sheet", () => ({
  ResponsiveDetailSheet: ({
    open,
    onOpenChange,
    children,
  }: {
    open: boolean
    onOpenChange: (open: boolean) => void
    children: React.ReactNode
  }) =>
    open ? (
      <div data-testid="bot-detail-sheet">
        <button data-testid="bot-detail-sheet-close" onClick={() => onOpenChange(false)} />
        {children}
      </div>
    ) : null,
}))

import { BotsMobileBody } from "./bots-mobile-body"

function row(over: Partial<BotConsoleRow> = {}): BotConsoleRow {
  return {
    id: "boti_1",
    definitionId: "acme:review",
    source: "plugin",
    name: "Review",
    executor: "handler",
    status: "enabled",
    scope: { kind: "account" },
    orphaned: false,
    problems: [],
    triggers: [{ id: "push", kind: "event", armed: true }],
    armedTriggers: 1,
    unboundSlots: [],
    requiredSlots: [],
    credentials: [],
    config: {},
    deadLetters: 0,
    updatedAt: 10,
    ...over,
  }
}

const noop = () => {}

beforeEach(() => {
  failed = false
  rows = [row()]
  summary = { total: 1, armed: 1, needsAttention: 0, deadLetters: 0 }
  loading = false
  detailProps = undefined
})

describe("BotsMobileBody", () => {
  it("renders the Bot list directly, not behind a sheet trigger", () => {
    // The inversion is the whole reason this body exists next to BotConsole:
    // on a phone the list IS the page and the detail arrives on demand.
    render(<BotsMobileBody onSelect={noop} onDeselect={noop} />)
    expect(screen.getByTestId("bot-list-pane")).toBeInTheDocument()
    expect(screen.queryByTestId("bot-detail-sheet")).toBeNull()
  })

  it("opens the detail drawer on the ?bot= deep link", () => {
    render(<BotsMobileBody selectedId="boti_1" onSelect={noop} onDeselect={noop} />)
    expect(screen.getByTestId("bot-detail-sheet")).toBeInTheDocument()
    expect(screen.getByTestId("mobile-bot-detail")).toHaveTextContent("boti_1")
  })

  it("leaves the drawer shut when the deep link names nothing on this device", () => {
    render(<BotsMobileBody selectedId="boti_missing" onSelect={noop} onDeselect={noop} />)
    expect(screen.queryByTestId("bot-detail-sheet")).toBeNull()
  })

  it("hands the route the tapped installation id", () => {
    const onSelect = jest.fn()
    render(<BotsMobileBody onSelect={onSelect} onDeselect={noop} />)
    fireEvent.click(screen.getByTestId("bot-row-boti_1"))
    expect(onSelect).toHaveBeenCalledWith("boti_1")
  })

  it("clears ?bot= when the drawer closes, which is also how uninstall flows out", () => {
    const onDeselect = jest.fn()
    render(<BotsMobileBody selectedId="boti_1" onSelect={noop} onDeselect={onDeselect} />)
    fireEvent.click(screen.getByTestId("bot-detail-sheet-close"))
    expect(onDeselect).toHaveBeenCalled()

    ;(detailProps?.onUninstalled as (() => void) | undefined)?.()
    expect(onDeselect).toHaveBeenCalledTimes(2)
  })

  it("shows the page description on an empty account rather than an armed-fraction of nothing", () => {
    rows = []
    summary = { total: 0, armed: 0, needsAttention: 0, deadLetters: 0 }
    render(<BotsMobileBody onSelect={noop} onDeselect={noop} />)
    expect(screen.queryByText("0 of 0 armed")).not.toBeInTheDocument()
    expect(
      screen.getByText("Installed Bots: what wakes each one up, what runs it, and what it is allowed to do.")
    ).toBeInTheDocument()
  })

  it("reports a host read failure instead of claiming no installations", () => {
    failed = true
    render(<BotsMobileBody onSelect={noop} onDeselect={noop} />)
    expect(screen.getByRole("alert")).toBeInTheDocument()
  })

  it("does not alarm about a runner before anything is installed", () => {
    rows = []
    const { unmount } = render(<BotsMobileBody onSelect={noop} onDeselect={noop} />)
    expect(screen.getByTestId("bot-runtime-notice-stub")).toHaveAttribute("data-has-bots", "false")
    unmount()
    rows = [row()]
    render(<BotsMobileBody onSelect={noop} onDeselect={noop} />)
    expect(screen.getByTestId("bot-runtime-notice-stub")).toHaveAttribute("data-has-bots", "true")
  })

  it("opens the install sheet from the empty list", () => {
    rows = []
    render(<BotsMobileBody onSelect={noop} onDeselect={noop} />)
    fireEvent.click(screen.getByTestId("bot-list-install"))
    expect(screen.getByTestId("install-bot-sheet-stub")).toBeInTheDocument()
  })

  it("opens the install sheet from the header button", () => {
    render(<BotsMobileBody onSelect={noop} onDeselect={noop} />)
    fireEvent.click(screen.getByTestId("mobile-bots-install"))
    expect(screen.getByTestId("install-bot-sheet-stub")).toBeInTheDocument()
  })

  it("opens the install sheet on ?install=1 and does not slam a hand-opened one when it clears", () => {
    const { rerender } = render(
      <BotsMobileBody installParam="1" onSelect={noop} onDeselect={noop} />
    )
    expect(screen.getByTestId("install-bot-sheet-stub")).toBeInTheDocument()
    rerender(<BotsMobileBody installParam={null} onSelect={noop} onDeselect={noop} />)
    expect(screen.getByTestId("install-bot-sheet-stub")).toBeInTheDocument()
  })
})
