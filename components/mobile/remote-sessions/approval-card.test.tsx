import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { ApprovalCard } from "./approval-card"
import type { PendingApproval } from "@/lib/claude/types"

const approval: PendingApproval = {
  sessionId: "s1",
  requestId: "r1",
  toolUseID: "tu1",
  toolName: "bash",
  displayName: "Bash",
  input: { command: "ls" },
}

describe("<ApprovalCard />", () => {
  it("renders the tool name and input", async () => {
    render(<ApprovalCard approval={approval} onRespond={jest.fn().mockResolvedValue(undefined)} />)
    expect(await screen.findByTestId("remote-approval-card")).toBeInTheDocument()
    expect(screen.getByText(/Bash/)).toBeInTheDocument()
    expect(screen.getByText(/ls/)).toBeInTheDocument()
  })

  it("allow forwards 'allow' to onRespond (biometric passes through in test)", async () => {
    const user = userEvent.setup()
    const onRespond = jest.fn().mockResolvedValue(undefined)
    render(<ApprovalCard approval={approval} onRespond={onRespond} />)
    await user.click(await screen.findByTestId("remote-approval-allow"))
    expect(onRespond).toHaveBeenCalledWith("allow")
  })

  it("allow-always forwards 'allow_always'", async () => {
    const user = userEvent.setup()
    const onRespond = jest.fn().mockResolvedValue(undefined)
    render(<ApprovalCard approval={approval} onRespond={onRespond} />)
    await user.click(await screen.findByTestId("remote-approval-allow-always"))
    expect(onRespond).toHaveBeenCalledWith("allow_always")
  })

  it("deny forwards 'deny' without a biometric prompt", async () => {
    const user = userEvent.setup()
    const onRespond = jest.fn().mockResolvedValue(undefined)
    render(<ApprovalCard approval={approval} onRespond={onRespond} />)
    await user.click(await screen.findByTestId("remote-approval-deny"))
    expect(onRespond).toHaveBeenCalledWith("deny")
  })
})
