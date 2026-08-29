/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { ApprovalGateDialog } from "./approval-gate-dialog"
import en from "@/i18n/messages/en.json"

const renderDialog = (props: Partial<React.ComponentProps<typeof ApprovalGateDialog>> = {}) =>
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <ApprovalGateDialog
        open
        onClose={() => {}}
        gateType="budget"
        scopeId="run-1"
        onApprove={() => {}}
        onReject={() => {}}
        {...props}
      />
    </NextIntlClientProvider>
  )

describe("ApprovalGateDialog", () => {
  it("renders the budget gate title", () => {
    renderDialog({ gateType: "budget" })
    expect(screen.getByText(/Token budget critical/i)).toBeInTheDocument()
  })

  it("calls onApprove with budget payload on approve", () => {
    const onApprove = jest.fn()
    renderDialog({ gateType: "budget", onApprove })
    const input = screen.getByPlaceholderText(/50000/) as HTMLInputElement
    fireEvent.change(input, { target: { value: "50000" } })
    fireEvent.click(screen.getByRole("button", { name: /Approve/i }))
    expect(onApprove).toHaveBeenCalledWith({ extraTokens: 50000 })
  })

  it("calls onReject when reject clicked", () => {
    const onReject = jest.fn()
    renderDialog({ gateType: "budget", onReject })
    fireEvent.click(screen.getByRole("button", { name: /Reject/i }))
    expect(onReject).toHaveBeenCalledTimes(1)
  })

  it("deadlock gate exposes the resetAll option", () => {
    renderDialog({ gateType: "deadlock" })
    expect(screen.getByText(/Reset all teammates/i)).toBeInTheDocument()
  })

  it("plan gate renders body without payload inputs", () => {
    renderDialog({ gateType: "plan" })
    expect(screen.queryByPlaceholderText(/50000/)).not.toBeInTheDocument()
  })

  it("plan_step gate renders its own title and approves with no payload", () => {
    const onApprove = jest.fn()
    renderDialog({ gateType: "plan_step", onApprove })
    expect(screen.getByText(/Plan step needs approval/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /Approve/i }))
    expect(onApprove).toHaveBeenCalledWith()
  })

  // The reject reason becomes the plan step's failure text, so it has to reach
  // the caller rather than being collected and dropped.
  it("plan_step gate forwards the reject reason", () => {
    const onReject = jest.fn()
    renderDialog({ gateType: "plan_step", onReject })
    fireEvent.change(screen.getByTestId("plan-step-gate-feedback"), {
      target: { value: "  wrong branch  " },
    })
    fireEvent.click(screen.getByRole("button", { name: /Reject/i }))
    expect(onReject).toHaveBeenCalledWith("wrong branch")
  })

  it("only the plan_step gate collects reject feedback", () => {
    renderDialog({ gateType: "plan" })
    expect(screen.queryByTestId("plan-step-gate-feedback")).not.toBeInTheDocument()
  })

  it("teammate_fix gate approve sends action=rejoin", () => {
    const onApprove = jest.fn()
    renderDialog({ gateType: "teammate_fix", onApprove })
    fireEvent.click(screen.getByRole("button", { name: /Approve/i }))
    expect(onApprove).toHaveBeenCalledWith({ action: "rejoin" })
  })

  it("teammate_fix gate resolves its camelCase i18n title (not the raw key)", () => {
    renderDialog({ gateType: "teammate_fix" })
    expect(screen.getByText(/Teammate disqualified/i)).toBeInTheDocument()
    expect(screen.queryByText(/teammate_fix\.title/)).not.toBeInTheDocument()
  })

  it("does not render when open=false", () => {
    renderDialog({ open: false })
    expect(screen.queryByText(/Token budget critical/i)).not.toBeInTheDocument()
  })

  it("replan gate renders its title and body, approving with no payload", () => {
    const onApprove = jest.fn()
    renderDialog({ gateType: "replan", onApprove, body: "add a verifier" })
    expect(screen.getByText(/Re-plan checkpoint/i)).toBeInTheDocument()
    expect(screen.getByText("add a verifier")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /Approve/i }))
    expect(onApprove).toHaveBeenCalledWith()
  })

  it("capability_audit gate renders its variant copy and approves with no payload", () => {
    const onApprove = jest.fn()
    const onReject = jest.fn()
    renderDialog({ gateType: "capability_audit", onApprove, onReject })
    expect(screen.getByText(/Stale capabilities detected/i)).toBeInTheDocument()
    // Variant button labels replace the generic Approve/Reject pair.
    fireEvent.click(screen.getByRole("button", { name: /Run anyway/i }))
    expect(onApprove).toHaveBeenCalledWith()
    fireEvent.click(screen.getByRole("button", { name: /Cancel run/i }))
    expect(onReject).toHaveBeenCalledTimes(1)
  })
})

// The dialog is mounted at the app root, so it can appear over any surface with
// no surrounding context. Everything the operator needs in order to know WHAT
// they are releasing has to be inside the modal itself.
describe("ApprovalGateDialog identity", () => {
  it("renders the producer's own title when the caller supplies one", () => {
    renderDialog({ title: "Budget exceeded — research lead" })
    expect(screen.getByTestId("approval-gate-title")).toHaveTextContent(
      "Budget exceeded — research lead"
    )
  })

  it("falls back to the gate-kind title when the caller has none", () => {
    renderDialog()
    expect(screen.getByTestId("approval-gate-title")).toHaveTextContent("Token budget critical")
  })

  it("still names the gate kind when a producer title has replaced it in the heading", () => {
    // Two signals, not one: the title says WHICH gate, the badge says what KIND
    // it is. A producer title that shadowed the kind would leave the operator
    // guessing which decision the two buttons make.
    renderDialog({ title: "Budget exceeded — research lead" })
    expect(screen.getByTestId("approval-gate-kind")).toHaveTextContent("Token budget critical")
  })

  it("drops the kind badge when the heading already is the kind", () => {
    // Otherwise the same string renders twice and reads as two facts about the
    // gate when it is one.
    renderDialog()
    expect(screen.queryByTestId("approval-gate-kind")).not.toBeInTheDocument()
  })

  it("shows the scope id it approves against", () => {
    // `scopeId` was declared "display only" and then never displayed, so two
    // simultaneous gates of the same kind rendered as identical modals.
    renderDialog({ scopeId: "run-42" })
    expect(screen.getByTestId("approval-gate-scope")).toHaveTextContent("run-42")
  })
})
