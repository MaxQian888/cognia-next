/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import en from "@/i18n/messages/en.json"

import { ApprovalGateDialog, type ApprovalGateDialogProps } from "./approval-gate-dialog"

const renderDialog = (over: Partial<ApprovalGateDialogProps> = {}) => {
  const props: ApprovalGateDialogProps = {
    open: true,
    onClose: jest.fn(),
    gateType: "budget",
    scopeId: "run-42",
    onApprove: jest.fn(),
    onReject: jest.fn(),
    ...over,
  }
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <ApprovalGateDialog {...props} />
    </NextIntlClientProvider>
  )
  return props
}

describe("ApprovalGateDialog identity", () => {
  // The dialog is mounted at the app root, so it can appear over any surface
  // with no surrounding context. Everything the operator needs to know WHAT
  // they are releasing has to be inside the modal.
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
    // Two different signals: the title says WHICH gate, the badge says WHAT
    // KIND. A producer title that shadowed the kind would leave the operator
    // guessing which decision the buttons make.
    renderDialog({ title: "Budget exceeded — research lead" })
    expect(screen.getByText("Token budget critical")).toBeInTheDocument()
  })

  it("shows the scope id it approves against", () => {
    // `scopeId` was declared "display only" and then never displayed, so two
    // simultaneous gates of the same kind rendered as identical modals.
    renderDialog({ scopeId: "run-42" })
    expect(screen.getByTestId("approval-gate-scope")).toHaveTextContent("run-42")
  })
})

describe("ApprovalGateDialog decisions", () => {
  it("returns the parsed extra budget on approve", () => {
    const props = renderDialog()
    fireEvent.change(screen.getByPlaceholderText(/50000/), { target: { value: "2500" } })
    fireEvent.click(screen.getByRole("button", { name: /^Approve$/i }))
    expect(props.onApprove).toHaveBeenCalledWith({ extraTokens: 2500 })
  })

  it("carries the inline feedback on a plan-step rejection", () => {
    const props = renderDialog({ gateType: "plan_step", scopeId: "step-7" })
    fireEvent.change(screen.getByTestId("plan-step-gate-feedback"), {
      target: { value: "not ready" },
    })
    fireEvent.click(screen.getByRole("button", { name: /^Reject$/i }))
    expect(props.onReject).toHaveBeenCalledWith("not ready")
  })

  it("uses the capability-audit wording for its two decisions", () => {
    renderDialog({ gateType: "capability_audit" })
    expect(screen.getByRole("button", { name: /Run anyway/i })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Cancel run/i })).toBeInTheDocument()
  })

  it("renders nothing while closed", () => {
    const { container } = render(
      <NextIntlClientProvider locale="en" messages={en}>
        <ApprovalGateDialog
          open={false}
          onClose={jest.fn()}
          gateType="budget"
          scopeId="run-42"
          onApprove={jest.fn()}
          onReject={jest.fn()}
        />
      </NextIntlClientProvider>
    )
    expect(container).toBeEmptyDOMElement()
  })
})
