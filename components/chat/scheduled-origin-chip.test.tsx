/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const push = jest.fn()
jest.mock("next/navigation", () => ({ useRouter: () => ({ push }) }))
const liveTask = jest.fn()
jest.mock("@/hooks/scheduler/use-live-scheduled-task", () => ({
  useLiveScheduledTask: (id: string | undefined) => liveTask(id),
}))
const companionShell = jest.fn(() => false)
jest.mock("@/lib/chat/room/shell", () => ({ isCompanionShell: () => companionShell() }))

import type { ChatSession } from "@cognia/agent-config-types"
import { TooltipProvider } from "@/components/ui/tooltip"

import { ScheduledOriginChip } from "./scheduled-origin-chip"

function session(overrides: Partial<ChatSession> = {}): ChatSession {
  return { id: "s1", title: "Morning digest (scheduled)", ...overrides } as ChatSession
}

function renderChip(value: ChatSession) {
  return render(
    <TooltipProvider>
      <ScheduledOriginChip session={value} />
    </TooltipProvider>
  )
}

beforeEach(() => {
  push.mockReset()
  liveTask.mockReset()
  companionShell.mockReset().mockReturnValue(false)
})

describe("ScheduledOriginChip", () => {
  it("renders nothing for a conversation a person opened", () => {
    liveTask.mockReturnValue(null)
    const { container } = renderChip(session())
    expect(container).toBeEmptyDOMElement()
  })

  it("names the task that opened the conversation and opens that run", async () => {
    const user = userEvent.setup()
    liveTask.mockReturnValue({ id: "t1", name: "Morning digest", type: "chat" })
    renderChip(
      session({
        origin: { kind: "scheduled-task", taskId: "t1", taskName: "Old name", runId: "r9" },
      })
    )
    const chip = screen.getByTestId("scheduled-origin-chip")
    // The live name wins over the one stamped when it ran.
    expect(chip).toHaveTextContent("Scheduled · Morning digest")
    await user.click(chip)
    expect(push).toHaveBeenCalledWith("/scheduler?item=app%3At1&run=app%3Ar9")
  })

  it("keeps the stamped name and goes inert once the task is deleted", () => {
    liveTask.mockReturnValue(null)
    renderChip(
      session({ origin: { kind: "scheduled-task", taskId: "t1", taskName: "Morning digest" } })
    )
    const chip = screen.getByTestId("scheduled-origin-chip")
    expect(chip).toHaveTextContent("Scheduled · Morning digest")
    expect(chip).toBeDisabled()
    expect(chip).toHaveAttribute("data-gone", "true")
  })

  it("stays live on a companion shell, whose schedule lives on the host", async () => {
    const user = userEvent.setup()
    companionShell.mockReturnValue(true)
    liveTask.mockReturnValue(null)
    renderChip(
      session({
        origin: { kind: "scheduled-task", taskId: "t1", taskName: "Morning digest", runId: "r9" },
      })
    )
    const chip = screen.getByTestId("scheduled-origin-chip")
    expect(chip).toBeEnabled()
    expect(chip).not.toHaveAttribute("data-gone")
    await user.click(chip)
    expect(push).toHaveBeenCalledWith("/scheduler?item=app%3At1&run=app%3Ar9")
  })

  it("ignores other origins", () => {
    liveTask.mockReturnValue(undefined)
    const { container } = renderChip(
      session({ origin: { kind: "gateway-api", keyId: "k", keyName: "CI" } })
    )
    expect(container).toBeEmptyDOMElement()
  })
})
