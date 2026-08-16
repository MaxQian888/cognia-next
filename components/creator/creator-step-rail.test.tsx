/** @jest-environment jsdom */
import { render, screen, within } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

import { CreatorStepRail, stepStatus } from "./creator-step-rail"
import creatorMessages from "@/i18n/messages/en/creator.json"
import { CREATOR_STEP_IDS } from "@/lib/creator/steps"
import type { CreatorStepId } from "@/types/creator"

const before = (step: CreatorStepId): CreatorStepId[] =>
  CREATOR_STEP_IDS.slice(0, CREATOR_STEP_IDS.indexOf(step))

function renderRail(props: React.ComponentProps<typeof CreatorStepRail>) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ creator: creatorMessages }}>
      <CreatorStepRail {...props} />
    </NextIntlClientProvider>
  )
}

function rowFor(step: CreatorStepId): HTMLElement {
  return screen.getByText(creatorMessages.steps[step]).closest("li") as HTMLElement
}

describe("stepStatus", () => {
  const empty = { completed: [], approvals: [] }

  it("reports a completed step", () => {
    expect(
      stepStatus("collect-requirements", {
        state: { completed: ["collect-requirements"], approvals: [] },
      })
    ).toBe("completed")
  })

  it("reports the active step", () => {
    expect(stepStatus("survey-existing", { state: empty, activeStep: "survey-existing" })).toBe(
      "active"
    )
  })

  it("reports a failed step, which outranks completed", () => {
    expect(
      stepStatus("verify", {
        state: { completed: ["verify"], approvals: [] },
        failed: ["verify"],
      })
    ).toBe("failed")
  })

  it("reports awaiting-approval for a gated step whose predecessors are done", () => {
    expect(
      stepStatus("approve-permissions", {
        state: { completed: before("approve-permissions"), approvals: [] },
      })
    ).toBe("awaiting-approval")
  })

  it("reports pending for a step blocked by an earlier one", () => {
    expect(stepStatus("apply-changes", { state: empty })).toBe("pending")
  })
})

describe("CreatorStepRail", () => {
  it("renders all nine steps in order", () => {
    renderRail({ state: { completed: [], approvals: [] } })
    const items = screen.getAllByRole("listitem")
    expect(items).toHaveLength(9)
    expect(items[0]).toHaveTextContent(creatorMessages.steps["collect-requirements"])
    expect(items[8]).toHaveTextContent(creatorMessages.steps["approve-delivery"])
  })

  it("marks the active step for assistive tech", () => {
    renderRail({ state: { completed: [], approvals: [] }, activeStep: "collect-requirements" })
    expect(rowFor("collect-requirements")).toHaveAttribute("aria-current", "step")
  })

  it("names the step that blocks a later one", () => {
    renderRail({ state: { completed: ["collect-requirements"], approvals: [] } })
    expect(
      within(rowFor("plan-scaffold")).getByText(/Check for an existing implementation/)
    ).toBeInTheDocument()
  })

  it("shows the awaiting-approval status on the permission gate", () => {
    renderRail({ state: { completed: before("approve-permissions"), approvals: [] } })
    expect(rowFor("approve-permissions")).toHaveTextContent(
      creatorMessages.status["awaiting-approval"]
    )
  })

  it("shows the gate as pending once the approval is granted", () => {
    renderRail({
      state: { completed: before("approve-permissions"), approvals: ["permission-widening"] },
    })
    expect(rowFor("approve-permissions")).toHaveTextContent(creatorMessages.status.pending)
  })

  it("shows a failed step", () => {
    renderRail({
      state: { completed: before("verify"), approvals: ["permission-widening"] },
      failed: ["verify"],
    })
    expect(rowFor("verify")).toHaveTextContent(creatorMessages.status.failed)
  })
})
