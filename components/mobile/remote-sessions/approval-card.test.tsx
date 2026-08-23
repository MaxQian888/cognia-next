import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { ApprovalCard } from "./approval-card"
import type { PendingApproval } from "@cognia/agent-config-types"

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
    // The tool-aware preview from the shared surface — a bash block, not the
    // raw JSON dump this card used to render.
    expect(screen.getByTestId("approval-bash-preview")).toBeInTheDocument()
    expect(screen.getByText(/ls/)).toBeInTheDocument()
  })

  /**
   * A watcher without control may see that a decision exists, but not the
   * arguments — those carry commands, file contents and credentials — and has
   * nothing to press.
   */
  it("redacts the arguments and offers no action in observe mode", async () => {
    render(
      <ApprovalCard
        approval={approval}
        onRespond={jest.fn().mockResolvedValue(undefined)}
        mode="observe"
      />
    )
    expect(await screen.findByTestId("approval-observe-redacted")).toBeInTheDocument()
    expect(screen.queryByTestId("approval-bash-preview")).not.toBeInTheDocument()
    expect(screen.queryByTestId("decision-allow")).not.toBeInTheDocument()
    expect(screen.queryByTestId("decision-deny")).not.toBeInTheDocument()
  })

  /**
   * An interrupted decision has no answer left: the sidecar waiter died with
   * the turn and the tool was already denied, so Allow and Deny would be lies.
   */
  it("offers only dismissal once the decision was interrupted", async () => {
    render(
      <ApprovalCard
        approval={{ ...approval, status: "interrupted" }}
        onRespond={jest.fn().mockResolvedValue(undefined)}
      />
    )
    expect(await screen.findByTestId("approval-interrupted-notice")).toBeInTheDocument()
    expect(screen.queryByTestId("decision-allow")).not.toBeInTheDocument()
  })

  it("allow forwards 'allow' to onRespond (biometric passes through in test)", async () => {
    const user = userEvent.setup()
    const onRespond = jest.fn().mockResolvedValue(undefined)
    render(<ApprovalCard approval={approval} onRespond={onRespond} />)
    await user.click(await screen.findByTestId("decision-allow"))
    expect(onRespond).toHaveBeenCalledWith("allow")
  })

  it("allow-always forwards 'allow_always'", async () => {
    const user = userEvent.setup()
    const onRespond = jest.fn().mockResolvedValue(undefined)
    render(<ApprovalCard approval={approval} onRespond={onRespond} />)
    await user.click(await screen.findByTestId("decision-allow-always"))
    expect(onRespond).toHaveBeenCalledWith("allow_always")
  })

  it("deny forwards 'deny' without a biometric prompt", async () => {
    const user = userEvent.setup()
    const onRespond = jest.fn().mockResolvedValue(undefined)
    render(<ApprovalCard approval={approval} onRespond={onRespond} />)
    await user.click(await screen.findByTestId("decision-deny"))
    expect(onRespond).toHaveBeenCalledWith("deny")
  })
})
