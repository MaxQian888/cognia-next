import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { ItemHero, type ItemActions } from "./item-hero"
import type { UnifiedScheduledItem } from "@/types/scheduler/unified"

function item(overrides: Partial<UnifiedScheduledItem> = {}): UnifiedScheduledItem {
  return {
    unifiedId: "app:t1",
    kind: "app",
    sourceId: "t1",
    name: "Nightly build",
    description: "Builds main every night",
    status: "active",
    triggerSummary: { type: "cron", cron: "0 2 * * *" },
    nextRunAt: Date.now() + 3_600_000,
    origin: { deepLinkHref: "/scheduler?taskId=t1" },
    capabilities: { runNow: true, pause: true, edit: true, delete: true },
    ...overrides,
  }
}

function actions(overrides: Partial<ItemActions> = {}): ItemActions {
  return {
    onRunNow: jest.fn(),
    onPause: jest.fn(),
    onResume: jest.fn(),
    onDelete: jest.fn(),
    ...overrides,
  }
}

describe("ItemHero", () => {
  it("names the item and dispatches the primary actions", () => {
    const a = actions({ onEdit: jest.fn() })
    render(<ItemHero item={item()} actions={a} />)
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Nightly build")
    expect(screen.getByText("Builds main every night")).toBeInTheDocument()
    expect(screen.getByTestId("item-hero-next-run")).toHaveTextContent(/next/)
    fireEvent.click(screen.getByTestId("item-action-run"))
    fireEvent.click(screen.getByTestId("item-action-pause"))
    fireEvent.click(screen.getByTestId("item-action-edit"))
    fireEvent.click(screen.getByTestId("item-action-delete"))
    expect(a.onRunNow).toHaveBeenCalled()
    expect(a.onPause).toHaveBeenCalled()
    expect(a.onEdit).toHaveBeenCalled()
    expect(a.onDelete).toHaveBeenCalled()
    expect(screen.queryByTestId("item-action-more")).not.toBeInTheDocument()
  })

  it("offers Resume on a paused item and waits while a run is in flight", () => {
    const a = actions()
    render(<ItemHero item={item({ status: "paused" })} actions={a} busy />)
    fireEvent.click(screen.getByTestId("item-action-resume"))
    expect(a.onResume).toHaveBeenCalled()
    expect(screen.getByTestId("item-action-run")).toBeDisabled()
  })

  it("disables a control with a reason rather than hiding it", () => {
    render(
      <ItemHero
        item={item({
          kind: "connector",
          capabilities: { runNow: false, pause: false, edit: false, delete: false },
        })}
        actions={actions()}
      />
    )
    expect(screen.getByTestId("item-action-run")).toBeDisabled()
    expect(screen.getByTestId("item-action-run")).toHaveAttribute(
      "title",
      "This kind cannot be run on demand"
    )
    expect(screen.getByTestId("item-action-pause")).toBeDisabled()
    expect(screen.getByTestId("item-action-edit-disabled")).toBeDisabled()
    expect(screen.getByTestId("item-action-delete")).toBeDisabled()
  })

  it("points at the source editor when the item is editable but not here", () => {
    render(
      <ItemHero
        item={item({ kind: "backup", origin: { deepLinkHref: "/settings?section=data" } })}
        actions={actions()}
      />
    )
    expect(screen.getByTestId("item-action-edit-elsewhere")).toHaveAttribute(
      "href",
      "/settings?section=data"
    )
  })

  it("puts the app-only verbs behind the overflow menu", async () => {
    const user = userEvent.setup()
    const a = actions({
      onDuplicate: jest.fn(),
      onBackfill: jest.fn(),
      onOpenDependencyGraph: jest.fn(),
      onPromote: jest.fn(),
      promotionAvailable: false,
      promotionUnavailableReason: "not here",
    })
    render(<ItemHero item={item()} actions={a} />)
    await user.click(screen.getByTestId("item-action-more"))
    await user.click(await screen.findByTestId("item-action-duplicate"))
    expect(a.onDuplicate).toHaveBeenCalled()
    await user.click(screen.getByTestId("item-action-more"))
    expect(await screen.findByTestId("item-action-promote")).toHaveAttribute(
      "aria-disabled",
      "true"
    )
    expect(screen.getByTestId("item-action-backfill")).toBeInTheDocument()
    expect(screen.getByTestId("item-action-dependencies")).toBeInTheDocument()
  })

  it("offers Remove promotion when the task is promoted", async () => {
    const user = userEvent.setup()
    const a = actions({ onPromote: jest.fn(), onUnpromote: jest.fn(), promoted: true })
    render(<ItemHero item={item()} actions={a} />)
    await user.click(screen.getByTestId("item-action-more"))
    await user.click(await screen.findByTestId("item-action-unpromote"))
    expect(a.onUnpromote).toHaveBeenCalled()
    expect(screen.queryByTestId("item-action-promote")).not.toBeInTheDocument()
  })
})
