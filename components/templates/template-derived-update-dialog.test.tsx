/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

import { TemplateDerivedUpdateDialog } from "./template-derived-update-dialog"
import type { TemplateDerivedUpdatePlan } from "@/lib/templates/service"

const messages = {
  templateStudio: {
    origin: {
      dialogTitle: "Take the upstream update",
      dialogDescription: "From {from} to {to}.",
      changes: "{count, plural, =1 {1 change} other {# changes}}",
      cancel: "Cancel",
      apply: "Merge",
    },
    updateDialog: {
      conflicts: "{count, plural, =1 {1 conflict} other {# conflicts}} with your local edits",
      keepLocal: "Keep mine",
      takeUpstream: "Take theirs",
      resolutionLabel: "Resolve {path}",
      unresolved:
        "{count, plural, =1 {1 conflict still needs an answer} other {# conflicts still need an answer}}",
    },
  },
}

function makePlan(over: Partial<TemplateDerivedUpdatePlan> = {}): TemplateDerivedUpdatePlan {
  return {
    id: "plan_1",
    definitionId: "user.skill.mine",
    derivation: { definitionId: "builtin.skill.notes", version: "1.0.0" },
    next: { version: "1.2.0" },
    diff: { changes: [{ path: "$/tone" }], conflicts: [] },
    ...over,
  } as unknown as TemplateDerivedUpdatePlan
}

function renderDialog(plan: TemplateDerivedUpdatePlan | undefined) {
  const onConfirm = jest.fn()
  render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <TemplateDerivedUpdateDialog plan={plan} onOpenChange={jest.fn()} onConfirm={onConfirm} />
    </NextIntlClientProvider>
  )
  return { onConfirm }
}

describe("TemplateDerivedUpdateDialog", () => {
  it("stays shut until a plan is computed", () => {
    renderDialog(undefined)
    expect(screen.queryByTestId("template-derived-update-dialog")).toBeNull()
  })

  it("lists the upstream paths the fork will take", () => {
    renderDialog(makePlan())
    expect(screen.getByTestId("template-derived-changes")).toHaveTextContent("$/tone")
  })

  it("merges straight away when nothing clashes", () => {
    const plan = makePlan()
    const { onConfirm } = renderDialog(plan)
    fireEvent.click(screen.getByTestId("template-derived-confirm"))
    expect(onConfirm).toHaveBeenCalledWith(plan, {})
  })

  /**
   * `applyDerivedUpdate` throws on an unanswered conflict, so an enabled
   * button here would only turn into an error toast.
   */
  it("holds Merge until every conflict is answered", () => {
    renderDialog(makePlan({ diff: { changes: [], conflicts: [{ path: "$/content" }] } } as never))
    expect(screen.getByTestId("template-derived-confirm")).toBeDisabled()
    fireEvent.click(screen.getByTestId("template-update-take-$/content"))
    expect(screen.getByTestId("template-derived-confirm")).toBeEnabled()
  })

  it("passes each answer through so a kept local edit survives the merge", () => {
    const plan = makePlan({
      diff: { changes: [], conflicts: [{ path: "$/content" }] },
    } as never)
    const { onConfirm } = renderDialog(plan)
    fireEvent.click(screen.getByTestId("template-update-keep-$/content"))
    fireEvent.click(screen.getByTestId("template-derived-confirm"))
    expect(onConfirm).toHaveBeenCalledWith(plan, { "$/content": "local" })
  })
})
