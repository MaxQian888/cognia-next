/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

import { InstantiateConfirmDialog } from "./instantiate-confirm-dialog"
import type { TemplatePreflightPlan } from "@/lib/templates/service"

const messages = {
  templateStudio: {
    instantiateDialog: {
      title: "Create resources from this template",
      description: "This template binds values the app cannot read back.",
      sensitiveTitle: "{count, plural, =1 {1 sensitive binding} other {# sensitive bindings}}",
      cancel: "Cancel",
      confirm: "Create resources",
      kind: { secretRef: "credential reference", twinSlot: "digital twin slot" },
    },
  },
}

const PLAN = {
  definitionId: "t1",
  definitionHash: "sha256:x",
  status: "needs-confirmation",
  bindings: [
    { slotId: "apiKey", kind: "secretRef", resourceId: "kr_1", sensitive: true },
    { slotId: "twin", kind: "twinSlot", resourceId: "twin_1", sensitive: true },
    { slotId: "name", kind: "string", resourceId: "x", sensitive: false },
  ],
  issues: [],
  operations: [],
} as unknown as TemplatePreflightPlan

describe("InstantiateConfirmDialog", () => {
  it("stays shut when there is nothing to confirm", () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <InstantiateConfirmDialog plan={undefined} onOpenChange={jest.fn()} onConfirm={jest.fn()} />
      </NextIntlClientProvider>
    )
    expect(screen.queryByTestId("template-instantiate-dialog")).toBeNull()
  })

  /**
   * The button used to pass `confirmed: true` unconditionally, so the one gate
   * the plan asks for was answered on the user's behalf and the sensitive
   * bindings were never named.
   */
  it("names the sensitive bindings and only those", () => {
    const onConfirm = jest.fn()
    render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <InstantiateConfirmDialog plan={PLAN} onOpenChange={jest.fn()} onConfirm={onConfirm} />
      </NextIntlClientProvider>
    )
    const list = screen.getByTestId("template-instantiate-bindings")
    expect(list).toHaveTextContent("apiKey")
    expect(list).toHaveTextContent("twin")
    expect(list).not.toHaveTextContent("name")

    fireEvent.click(screen.getByTestId("template-instantiate-confirm"))
    expect(onConfirm).toHaveBeenCalledWith(PLAN)
  })
})
