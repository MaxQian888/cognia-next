/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { BotConsoleRow } from "@/lib/bot/console/bot-rows"

const uninstall = jest.fn(async (_id: string) => true)

jest.mock("@/hooks/bots/use-bot-lifecycle-actions", () => ({
  useBotLifecycleReadiness: () => ({
    availability: { state: "available", reason: "local-host" },
    can: true,
  }),
  useBotLifecycleActions: () => ({
    pending: new Set<string>(),
    uninstall: (id: string) => uninstall(id),
  }),
}))

import { UninstallBotDialog } from "./uninstall-bot-dialog"

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
    triggers: [],
    armedTriggers: 0,
    unboundSlots: [],
    requiredSlots: [],
    credentials: [],
    config: {},
    deadLetters: 0,
    updatedAt: 10,
    ...over,
  }
}

beforeEach(() => {
  uninstall.mockClear().mockResolvedValue(true)
})

describe("UninstallBotDialog", () => {
  it("names the Bot and what goes with it, not just 'are you sure'", () => {
    render(<UninstallBotDialog row={row()} open onOpenChange={jest.fn()} />)
    expect(screen.getByText("Uninstall Review?")).toBeInTheDocument()
    expect(screen.getByTestId("uninstall-bot-dialog")).toHaveTextContent(
      "scheduler tasks are removed"
    )
  })

  it("says something different for an orphan, where removal is all that is left", () => {
    render(<UninstallBotDialog row={row({ orphaned: true })} open onOpenChange={jest.fn()} />)
    expect(screen.getByTestId("uninstall-bot-dialog")).toHaveTextContent(
      "definition is already gone"
    )
  })

  it("removes the row and reports it upward so the console can deselect", async () => {
    const user = userEvent.setup()
    const onOpenChange = jest.fn()
    const onUninstalled = jest.fn()
    render(
      <UninstallBotDialog
        row={row()}
        open
        onOpenChange={onOpenChange}
        onUninstalled={onUninstalled}
      />
    )
    await user.click(screen.getByTestId("uninstall-bot-confirm"))
    expect(uninstall).toHaveBeenCalledWith("boti_1")
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onUninstalled).toHaveBeenCalled()
  })

  it("stays open when the write refuses, so the toast has something to sit beside", async () => {
    // A dialog that closed on a refusal would leave the row on screen with
    // nothing saying why it is still there.
    uninstall.mockResolvedValue(false)
    const user = userEvent.setup()
    const onOpenChange = jest.fn()
    const onUninstalled = jest.fn()
    render(
      <UninstallBotDialog
        row={row()}
        open
        onOpenChange={onOpenChange}
        onUninstalled={onUninstalled}
      />
    )
    await user.click(screen.getByTestId("uninstall-bot-confirm"))
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(onUninstalled).not.toHaveBeenCalled()
  })
})
