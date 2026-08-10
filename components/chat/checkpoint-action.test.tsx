/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import { CheckpointAction } from "./checkpoint-action"
import { TooltipProvider } from "@/components/ui/tooltip"

const rewindFilesMock = jest.fn()

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("@/lib/ai/agent/execution/feature-flags", () => ({
  isAgentExecutionFlagEnabled: () => true,
  subscribeToAgentExecutionFlags: () => () => {},
}))

describe("CheckpointAction", () => {
  beforeEach(() => rewindFilesMock.mockReset())

  const renderAction = (enabled = true) =>
    render(
      <TooltipProvider>
        <CheckpointAction checkpointId="u-1" enabled={enabled} rewindFiles={rewindFilesMock} />
      </TooltipProvider>
    )

  it("previews with dry-run before performing a confirmed rewind", async () => {
    rewindFilesMock
      .mockResolvedValueOnce({ status: "ready", paths: ["src/a.ts"] })
      .mockResolvedValueOnce({ status: "ready", paths: [] })
    renderAction()

    fireEvent.click(screen.getByRole("button", { name: "action" }))
    await screen.findByText(/src\/a\.ts/)
    expect(rewindFilesMock).toHaveBeenNthCalledWith(1, "u-1", true)

    fireEvent.click(screen.getByRole("button", { name: "confirm" }))
    await waitFor(() => expect(rewindFilesMock).toHaveBeenCalledTimes(2))
    expect(rewindFilesMock).toHaveBeenNthCalledWith(2, "u-1", false)
  })

  it("surfaces preview failures without enabling confirmation", async () => {
    rewindFilesMock.mockRejectedValue(new Error("unsupported"))
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
