/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import { CheckpointAction } from "./checkpoint-action"
import { TooltipProvider } from "@/components/ui/tooltip"

const sessionControlMock = jest.fn()

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("@/lib/claude/ipc", () => ({
  sessionControl: (...args: unknown[]) => sessionControlMock(...args),
}))
jest.mock("@/lib/ai/agent/execution/feature-flags", () => ({
  isAgentExecutionFlagEnabled: () => true,
  subscribeToAgentExecutionFlags: () => () => {},
}))

describe("CheckpointAction", () => {
  beforeEach(() => sessionControlMock.mockReset())

  const renderAction = (enabled = true) =>
    render(
      <TooltipProvider>
        <CheckpointAction checkpointId="u-1" enabled={enabled} sessionId="s-1" />
      </TooltipProvider>
    )

  it("previews with dry-run before performing a confirmed rewind", async () => {
    sessionControlMock.mockResolvedValueOnce({ files: ["src/a.ts"] }).mockResolvedValueOnce({})
    renderAction()

    fireEvent.click(screen.getByRole("button", { name: "action" }))
    await screen.findByText(/src\/a\.ts/)
    expect(sessionControlMock).toHaveBeenNthCalledWith(1, "s-1", "rewindFiles", {
      userMessageId: "u-1",
      options: { dryRun: true },
    })

    fireEvent.click(screen.getByRole("button", { name: "confirm" }))
    await waitFor(() => expect(sessionControlMock).toHaveBeenCalledTimes(2))
    expect(sessionControlMock).toHaveBeenNthCalledWith(2, "s-1", "rewindFiles", {
      userMessageId: "u-1",
      options: { dryRun: false },
    })
  })

  it("surfaces preview failures without enabling confirmation", async () => {
    sessionControlMock.mockRejectedValue(new Error("unsupported"))
    renderAction()

    fireEvent.click(screen.getByRole("button", { name: "action" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("previewFailed")
    expect(screen.getByRole("button", { name: "confirm" })).toBeDisabled()
  })

  it("does not render outside a supported active execution", () => {
    renderAction(false)
    expect(screen.queryByRole("button", { name: "action" })).toBeNull()
  })
})
