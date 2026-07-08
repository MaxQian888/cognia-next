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

  it("guards against a double-submit: a second approve click is ignored", () => {
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
    const approveBtn = screen.getByRole("button", { name: /approve/i })
    fireEvent.click(approveBtn)
    fireEvent.click(approveBtn)
    expect(onApprove).toHaveBeenCalledTimes(1)
    expect(approveBtn).toBeDisabled()
  })

  describe("question mode (Codex requestUserInput)", () => {
    const questionRequest: ToolApprovalRequest = {
      ...baseRequest,
      id: "q-item",
      userInput: {
        autoResolutionMs: 30000,
        questions: [
          {
            id: "q1",
            header: "Region",
            question: "Which region?",
            options: [
              { label: "us-east", description: "Virginia" },
              { label: "eu-west", description: "Ireland" },
            ],
            isOther: true,
          },
        ],
      },
    }

    it("renders questions with options and submits the selected answer", () => {
      const onSubmitAnswers = jest.fn()
      render(
        wrap(
          <ToolApprovalDialog
            request={questionRequest}
            open
            onOpenChange={() => {}}
            onApprove={() => {}}
            onDeny={() => {}}
            onSubmitAnswers={onSubmitAnswers}
          />
        )
      )
      expect(screen.getByTestId("user-input-dialog")).toBeInTheDocument()
      expect(screen.getByText("Which region?")).toBeInTheDocument()
      expect(screen.getByTestId("user-input-auto-resolve")).toBeInTheDocument()

      const submit = screen.getByTestId("user-input-submit")
      expect(submit).toBeDisabled()

      fireEvent.click(screen.getByLabelText(/eu-west/))
      expect(submit).not.toBeDisabled()
      fireEvent.click(submit)
      expect(onSubmitAnswers).toHaveBeenCalledWith("q-item", { q1: ["eu-west"] })
    })

    it("submits free text via the Other choice", () => {
      const onSubmitAnswers = jest.fn()
      render(
        wrap(
          <ToolApprovalDialog
            request={questionRequest}
            open
            onOpenChange={() => {}}
            onApprove={() => {}}
            onDeny={() => {}}
            onSubmitAnswers={onSubmitAnswers}
          />
        )
      )
      fireEvent.click(screen.getByLabelText(/other/i))
      const input = screen.getByTestId("user-input-other")
      fireEvent.change(input, { target: { value: "ap-southeast" } })
      fireEvent.click(screen.getByTestId("user-input-submit"))
      expect(onSubmitAnswers).toHaveBeenCalledWith("q-item", { q1: ["ap-southeast"] })
    })

    it("renders a plain input for option-less questions and masks secrets", () => {
      const onSubmitAnswers = jest.fn()
      render(
        wrap(
          <ToolApprovalDialog
            request={{
              ...baseRequest,
              id: "q-secret",
              userInput: {
                questions: [{ id: "q1", question: "API key?", isSecret: true }],
              },
            }}
            open
            onOpenChange={() => {}}
            onApprove={() => {}}
            onDeny={() => {}}
            onSubmitAnswers={onSubmitAnswers}
          />
        )
      )
      const input = screen.getByTestId("user-input-other")
      expect(input).toHaveAttribute("type", "password")
      fireEvent.change(input, { target: { value: "sk-123" } })
      fireEvent.click(screen.getByTestId("user-input-submit"))
      expect(onSubmitAnswers).toHaveBeenCalledWith("q-secret", { q1: ["sk-123"] })
    })

    it("skip denies the request", () => {
      const onDeny = jest.fn()
      render(
        wrap(
          <ToolApprovalDialog
            request={questionRequest}
            open
            onOpenChange={() => {}}
            onApprove={() => {}}
            onDeny={onDeny}
            onSubmitAnswers={() => {}}
          />
        )
      )
      fireEvent.click(screen.getByRole("button", { name: /skip/i }))
      expect(onDeny).toHaveBeenCalledWith("q-item")
    })
  })
})
