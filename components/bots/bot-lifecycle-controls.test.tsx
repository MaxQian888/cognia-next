/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { BotConsoleRow } from "@/lib/bot/console/bot-rows"

const setEnabled = jest.fn(async (_id: string, _enabled: boolean) => undefined)
const uninstall = jest.fn(async (_id: string) => true)
let readiness = { availability: { state: "available", reason: "local-host" }, can: true }
let pending = new Set<string>()

jest.mock("@/hooks/bots/use-bot-lifecycle-actions", () => ({
  useBotLifecycleReadiness: () => readiness,
  useBotLifecycleActions: () => ({
    pending,
    setEnabled: (id: string, enabled: boolean) => setEnabled(id, enabled),
    uninstall: (id: string) => uninstall(id),
  }),
}))

import { BotLifecycleControls } from "./bot-lifecycle-controls"

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
  setEnabled.mockClear()
  uninstall.mockClear().mockResolvedValue(true)
  readiness = { availability: { state: "available", reason: "local-host" }, can: true }
  pending = new Set<string>()
})

describe("BotLifecycleControls", () => {
  it("derives the switch from the row's status, never from local state", () => {
    // Asking to enable a Bot with an unbound slot answers `needs_setup`, and a
    // locally held switch would show an on state the row denies.
    const { unmount } = render(<BotLifecycleControls row={row()} />)
    expect(screen.getByTestId("bot-enabled-switch")).toBeChecked()
    unmount()

    render(<BotLifecycleControls row={row({ status: "needs_setup" })} />)
    expect(screen.getByTestId("bot-enabled-switch")).not.toBeChecked()
  })

  it("writes an absolute value rather than a toggle", async () => {
    const user = userEvent.setup()
    render(<BotLifecycleControls row={row()} />)
    await user.click(screen.getByTestId("bot-enabled-switch"))
    expect(setEnabled).toHaveBeenCalledWith("boti_1", false)
  })

  it("keeps uninstall available on an orphan while the switch refuses", () => {
    // An orphan has no definition to re-derive a status against, and removal
    // is the only remaining action.
    render(<BotLifecycleControls row={row({ orphaned: true })} />)
    expect(screen.getByTestId("bot-enabled-switch")).toBeDisabled()
    expect(screen.getByTestId("bot-uninstall")).toBeEnabled()
  })

  it("renders both DISABLED with the reason rather than hiding them", () => {
    readiness = {
      availability: { state: "unsupported", reason: "requires-companion" },
      can: false,
    }
    render(<BotLifecycleControls row={row()} />)
    expect(screen.getByTestId("bot-enabled-switch")).toBeDisabled()
    expect(screen.getByTestId("bot-uninstall")).toBeDisabled()
    expect(screen.getByTestId("bot-lifecycle-blocked")).toHaveTextContent(
      "This browser cannot run Bots"
    )
  })

  it("stops taking taps while its own write is in flight", () => {
    pending = new Set(["enabled:boti_1"])
    render(<BotLifecycleControls row={row()} />)
    expect(screen.getByTestId("bot-enabled-switch")).toBeDisabled()
  })

  it("opens the confirmation rather than uninstalling on the first click", async () => {
    const user = userEvent.setup()
    render(<BotLifecycleControls row={row()} />)
    await user.click(screen.getByTestId("bot-uninstall"))
    expect(uninstall).not.toHaveBeenCalled()
    expect(screen.getByTestId("uninstall-bot-dialog")).toBeInTheDocument()
  })
})
