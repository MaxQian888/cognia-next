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

  it("teammate_fix gate approve sends action=rejoin", () => {
    const onApprove = jest.fn()
    renderDialog({ gateType: "teammate_fix", onApprove })
    fireEvent.click(screen.getByRole("button", { name: /Approve/i }))
    expect(onApprove).toHaveBeenCalledWith({ action: "rejoin" })
  })

  it("does not render when open=false", () => {
    renderDialog({ open: false })
    expect(screen.queryByText(/Token budget critical/i)).not.toBeInTheDocument()
  })
})
