/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

import en from "@/i18n/messages/en.json"
import { TooltipProvider } from "@/components/ui/tooltip"
import type { AcpElicitationRequest } from "@/types/agent/external-agent"

import { ExternalAgentElicitationDialog } from "./elicitation-dialog"

const wrap = (ui: React.ReactNode) => (
  <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
    <TooltipProvider>{ui}</TooltipProvider>
  </NextIntlClientProvider>
)

/** A Pi dialog as `piDialogSchema` actually shapes it: one property per method. */
function piRequest(
  method: "confirm" | "select" | "input" | "editor",
  property: Record<string, unknown>,
  overrides: Partial<AcpElicitationRequest> = {}
): AcpElicitationRequest {
  return {
    id: "dlg-1",
    mode: "form",
    message: "Pick a branch",
    requestedSchema: {
      type: "object",
      title: "Branch",
      properties: { [method]: property as never },
      required: [method],
    },
    raw: { method },
    ...overrides,
  }
}

describe("ExternalAgentElicitationDialog", () => {
  it("renders nothing when no question is pending", () => {
    const { container } = render(
      wrap(<ExternalAgentElicitationDialog request={null} onRespond={jest.fn()} />)
    )
    expect(container).toBeEmptyDOMElement()
  })

  it("renders a select dialog as radio choices and returns the picked value", () => {
    const onRespond = jest.fn()
    render(
      wrap(
        <ExternalAgentElicitationDialog
          request={piRequest("select", { type: "string", title: "Branch", enum: ["main", "dev"] })}
          onRespond={onRespond}
        />
      )
    )

    expect(screen.getByText("Pick a branch")).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText("dev"))
    fireEvent.click(screen.getByRole("button", { name: en.externalAgent.elicitation.submit }))

    expect(onRespond).toHaveBeenCalledWith({
      requestId: "dlg-1",
      action: "accept",
      content: { select: "dev" },
    })
  })

  /**
   * `false` is a real answer to a confirm, not a missing one — the submit
   * button must not be gated on the box being ticked.
   */
  it("lets a confirm dialog be answered false", () => {
    const onRespond = jest.fn()
    render(
      wrap(
        <ExternalAgentElicitationDialog
          request={piRequest("confirm", { type: "boolean", title: "Delete it?" })}
          onRespond={onRespond}
        />
      )
    )

    const submit = screen.getByRole("button", { name: en.externalAgent.elicitation.submit })
    expect(submit).not.toBeDisabled()
    fireEvent.click(submit)

    expect(onRespond).toHaveBeenCalledWith({
      requestId: "dlg-1",
      action: "accept",
      content: { confirm: false },
    })
  })

  it("blocks submit until a required text answer is given", () => {
    const onRespond = jest.fn()
    render(
      wrap(
        <ExternalAgentElicitationDialog
          request={piRequest("input", { type: "string", title: "Name" })}
          onRespond={onRespond}
        />
      )
    )

    const submit = screen.getByRole("button", { name: en.externalAgent.elicitation.submit })
    expect(submit).toBeDisabled()

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "feature-x" } })
    expect(submit).not.toBeDisabled()
    fireEvent.click(submit)

    expect(onRespond).toHaveBeenCalledWith({
      requestId: "dlg-1",
      action: "accept",
      content: { input: "feature-x" },
    })
  })

  /**
   * An `editor` dialog arrives with its prefill as the schema default. Dropping
   * it would make the user retype content the extension already supplied.
   */
  it("seeds an editor dialog from its prefill", () => {
    const onRespond = jest.fn()
    render(
      wrap(
        <ExternalAgentElicitationDialog
          request={piRequest("editor", {
            type: "string",
            title: "Commit message",
            default: "fix: something",
          })}
          onRespond={onRespond}
        />
      )
    )

    const field = screen.getByLabelText("Commit message")
    expect(field).toHaveValue("fix: something")

    fireEvent.click(screen.getByRole("button", { name: en.externalAgent.elicitation.submit }))
    expect(onRespond).toHaveBeenCalledWith({
      requestId: "dlg-1",
      action: "accept",
      content: { editor: "fix: something" },
    })
  })

  it("reports an explicit refusal as decline", () => {
    const onRespond = jest.fn()
    render(
      wrap(
        <ExternalAgentElicitationDialog
          request={piRequest("confirm", { type: "boolean", title: "Delete it?" })}
          onRespond={onRespond}
        />
      )
    )

    fireEvent.click(screen.getByRole("button", { name: en.externalAgent.elicitation.decline }))
    expect(onRespond).toHaveBeenCalledWith({
      requestId: "dlg-1",
      action: "decline",
      content: undefined,
    })
  })

  /**
   * Dismissal and refusal are different answers: the agent reads `decline` as a
   * deliberate no and `cancel` as the user walking away.
   */
  it("reports dismissal as cancel, not decline", () => {
    const onRespond = jest.fn()
    render(
      wrap(
        <ExternalAgentElicitationDialog
          request={piRequest("confirm", { type: "boolean", title: "Delete it?" })}
          onRespond={onRespond}
        />
      )
    )

    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })
    expect(onRespond).toHaveBeenCalledWith({
      requestId: "dlg-1",
      action: "cancel",
      content: undefined,
    })
  })

  it("does not carry one question's answer into the next", () => {
    const onRespond = jest.fn()
    const { rerender } = render(
      wrap(
        <ExternalAgentElicitationDialog
          request={piRequest("input", { type: "string", title: "Name" })}
          onRespond={onRespond}
        />
      )
    )
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "first" } })

    rerender(
      wrap(
        <ExternalAgentElicitationDialog
          request={piRequest("input", { type: "string", title: "Name" }, { id: "dlg-2" })}
          onRespond={onRespond}
        />
      )
    )

    expect(screen.getByLabelText("Name")).toHaveValue("")
  })

  it("surfaces a punycode warning on a url elicitation", () => {
    render(
      wrap(
        <ExternalAgentElicitationDialog
          request={{
            id: "dlg-url",
            mode: "url",
            message: "Finish signing in",
            url: "https://xn--80ak6aa92e.com/auth",
            origin: "https://xn--80ak6aa92e.com",
            hasPunycodeWarning: true,
            raw: {},
          }}
          onRespond={jest.fn()}
        />
      )
    )

    expect(screen.getByText(en.externalAgent.elicitation.punycodeWarning)).toBeInTheDocument()
    expect(screen.getByRole("link")).toHaveAttribute("href", "https://xn--80ak6aa92e.com/auth")
  })
})
