/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

import { TemplateUpdateDialog } from "./template-update-dialog"
import type { TemplateUpdatePlan } from "@/lib/templates/service"

const messages = {
  templateStudio: {
    updateDialog: {
      title: "Update this instance",
      description: "From {from} to {to}.",
      cancel: "Cancel",
      confirm: "Apply update",
      changes: "{count, plural, =1 {1 change} other {# changes}}",
      conflicts: "{count, plural, =1 {1 conflict} other {# conflicts}} with your local edits",
      status: { ready: "Ready", "needs-confirmation": "Needs confirmation", blocked: "Blocked" },
    },
  },
}

function makePlan(over: Partial<TemplateUpdatePlan> = {}): TemplateUpdatePlan {
  return {
    id: "plan_1",
    instanceId: "inst_1",
    source: { version: "1.0.0" },
    next: { version: "1.1.0" },
    diff: { changes: [{ path: "payload.name" }], conflicts: [] },
    status: "ready",
    issues: [],
    ...over,
  } as unknown as TemplateUpdatePlan
}

function renderDialog(plan: TemplateUpdatePlan | undefined) {
  const onConfirm = jest.fn()
  render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <TemplateUpdateDialog plan={plan} onOpenChange={jest.fn()} onConfirm={onConfirm} />
    </NextIntlClientProvider>
  )
  return { onConfirm }
}

describe("TemplateUpdateDialog", () => {
  it("stays shut until a plan is computed", () => {
    renderDialog(undefined)
    expect(screen.queryByTestId("template-update-dialog")).toBeNull()
  })

  it("lists the paths the release changes", () => {
    renderDialog(makePlan())
    expect(screen.getByTestId("template-update-changes")).toHaveTextContent("payload.name")
  })

  /**
   * A conflict is a path the user edited locally AND the release changed.
   * Applying picks the release, so naming them is what tells the user which of
   * their own edits is about to go.
   */
  it("names the conflicts with the user's local edits", () => {
    renderDialog(
      makePlan({
        diff: { changes: [], conflicts: [{ path: "payload.systemPrompt" }] },
      } as never)
    )
    expect(screen.getByTestId("template-update-conflicts")).toHaveTextContent(
      "payload.systemPrompt"
    )
  })

  it("refuses to apply a blocked plan, which applyUpdate would throw on", () => {
    renderDialog(makePlan({ status: "blocked" } as never))
    expect(screen.getByTestId("template-update-confirm")).toBeDisabled()
  })

  it("confirms with the plan the service will consume", () => {
    const plan = makePlan()
    const { onConfirm } = renderDialog(plan)
    fireEvent.click(screen.getByTestId("template-update-confirm"))
    expect(onConfirm).toHaveBeenCalledWith(plan)
  })
})
