/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

let mockConnection: "online" | "connecting" | "offline" = "online"
jest.mock("@/hooks/use-runtime-snapshot", () => ({
  useRuntimeSnapshot: () => ({ connectionState: mockConnection }),
}))

import { MemoryHostChip } from "./memory-host-chip"

describe("MemoryHostChip", () => {
  it("says the memory shown is the host's and explains what that means", async () => {
    mockConnection = "online"
    render(<MemoryHostChip />)
    const chip = screen.getByTestId("memory-host-chip")
    expect(chip).toHaveTextContent("Host memory")
    expect(chip).toHaveAttribute("data-connection", "online")
    await userEvent.click(chip)
    expect(screen.getByText("Showing your host's memory")).toBeInTheDocument()
    expect(screen.getByText("Connected to the host.")).toBeInTheDocument()
  })

  it("tells an offline device its changes are waiting", async () => {
    mockConnection = "offline"
    render(<MemoryHostChip />)
    await userEvent.click(screen.getByTestId("memory-host-chip"))
    expect(screen.getByText(/Changes wait in the queue/)).toBeInTheDocument()
  })
})
