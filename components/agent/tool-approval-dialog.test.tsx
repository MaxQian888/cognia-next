/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

import en from "@/i18n/messages/en.json"
import { TooltipProvider } from "@/components/ui/tooltip"
import type { AcpPermissionOption } from "@/types/agent/external-agent"

import { ToolApprovalDialog, type ToolApprovalRequest } from "./tool-approval-dialog"

jest.mock("@/components/ai-elements/code-block", () => ({
  CodeBlock: ({ code }: { code: string }) => <pre data-testid="code-block">{code}</pre>,
}))

const wrap = (ui: React.ReactNode) => (
  <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
    <TooltipProvider>{ui}</TooltipProvider>
  </NextIntlClientProvider>
)

const baseRequest: ToolApprovalRequest = {
  id: "req-1",
  toolName: "filesystem_write",
  toolDescription: "Write a file to disk",
  args: { path: "/tmp/file.txt", content: "hello" },
  riskLevel: "low",
}

describe("ToolApprovalDialog (ACP variant)", () => {
  it("returns null when there is no request", () => {
    const { container } = render(
      wrap(
        <ToolApprovalDialog
          request={null}
          open={false}
          onOpenChange={() => {}}
          onApprove={() => {}}
          onDeny={() => {}}
        />
      )
    )
    expect(container.firstChild).toBeNull()
  })

  it("renders tool info, risk badge and parameters", () => {
    render(
      wrap(
        <ToolApprovalDialog
          request={baseRequest}
          open
          onOpenChange={() => {}}
          onApprove={() => {}}
          onDeny={() => {}}
        />
      )
    )

    expect(screen.getByText("filesystem_write")).toBeInTheDocument()
    expect(screen.getByText("Write a file to disk")).toBeInTheDocument()
    expect(screen.getByText("Low Risk")).toBeInTheDocument()
    expect(screen.getByTestId("code-block").textContent).toContain('"path": "/tmp/file.txt"')
  })

  it("invokes onApprove with always-allow flag when checkbox is checked", () => {
    const onApprove = jest.fn()
    render(
      wrap(
        <ToolApprovalDialog
          request={baseRequest}
          open
          onOpenChange={() => {}}
          onApprove={onApprove}
          onDeny={() => {}}
        />
      )
    )

    fireEvent.click(screen.getByRole("checkbox"))
    fireEvent.click(screen.getByRole("button", { name: /approve/i }))

    expect(onApprove).toHaveBeenCalledWith("req-1", true)
  })

  it("invokes onDeny when the deny button is clicked", () => {
    const onDeny = jest.fn()
    render(
      wrap(
        <ToolApprovalDialog
          request={baseRequest}
          open
          onOpenChange={() => {}}
          onApprove={() => {}}
          onDeny={onDeny}
        />
      )
    )
    fireEvent.click(screen.getByRole("button", { name: /deny/i }))
    expect(onDeny).toHaveBeenCalledWith("req-1")
  })

  it("hides the always-allow checkbox for non-low risk levels", () => {
    render(
      wrap(
        <ToolApprovalDialog
          request={{ ...baseRequest, riskLevel: "high" }}
          open
          onOpenChange={() => {}}
          onApprove={() => {}}
          onDeny={() => {}}
        />
      )
    )
    expect(screen.queryByRole("checkbox")).toBeNull()
    expect(screen.getByText("High Risk")).toBeInTheDocument()
  })

  it("renders ACP options instead of approve/deny when provided", () => {
    const options: AcpPermissionOption[] = [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once", isDefault: true },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ]
    const onSelectOption = jest.fn()
    render(
      wrap(
        <ToolApprovalDialog
          request={{ ...baseRequest, acpOptions: options }}
          open
          onOpenChange={() => {}}
          onApprove={() => {}}
          onDeny={() => {}}
          onSelectOption={onSelectOption}
        />
      )
    )

    fireEvent.click(screen.getByRole("button", { name: "Allow once" }))
    expect(onSelectOption).toHaveBeenCalledWith("req-1", "allow-once")

    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /approve/i })).toBeNull()
  })

  it("renders medium risk badge styling", () => {
    render(
      wrap(
        <ToolApprovalDialog
          request={{ ...baseRequest, riskLevel: "medium" }}
          open
          onOpenChange={() => {}}
          onApprove={() => {}}
          onDeny={() => {}}
        />
      )
    )
    expect(screen.getByText("Medium Risk")).toBeInTheDocument()
  })

  it("treats cancel click in ACP options as deny", () => {
    const options: AcpPermissionOption[] = [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
    ]
    const onDeny = jest.fn()
    render(
      wrap(
        <ToolApprovalDialog
          request={{ ...baseRequest, acpOptions: options }}
          open
          onOpenChange={() => {}}
          onApprove={() => {}}
          onDeny={onDeny}
        />
      )
    )
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }))
    expect(onDeny).toHaveBeenCalledWith("req-1")
  })
})
