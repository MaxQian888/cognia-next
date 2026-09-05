/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: (ns?: string) => (key: string, values?: Record<string, unknown>) =>
    values ? `${ns}.${key}:${JSON.stringify(values)}` : `${ns}.${key}`,
}))

import { SquadReviewForm, isRenderableSquadReview } from "./squad-review-form"
import type { SquadReviewKind } from "@/types/execution/run"

function interrupt(reviewKind: SquadReviewKind, subject?: Record<string, unknown>) {
  return { id: "int-1", reviewKind, expiresAt: 1, ...(subject ? { subject } : {}) }
}

describe("SquadReviewForm", () => {
  it("renders nothing for an interrupt that is not a Squad review", () => {
    expect(isRenderableSquadReview({ reviewKind: undefined })).toBe(false)
    const { container } = render(
      <SquadReviewForm
        interrupt={{ id: "x", reviewKind: undefined, expiresAt: 1 }}
        onDecide={() => {}}
      />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it("plan: approves with redactable feedback and denies with the same text", async () => {
    const onDecide = jest.fn()
    render(<SquadReviewForm interrupt={interrupt("plan")} onDecide={onDecide} />)
    const user = userEvent.setup()
    await user.type(screen.getByLabelText("agentRuns.review.plan.feedbackLabel"), "tighter")
    await user.click(screen.getByRole("button", { name: "agentRuns.review.kinds.plan.approve" }))
    expect(onDecide).toHaveBeenLastCalledWith("approve", { kind: "plan", feedback: "tighter" })
    await user.click(screen.getByRole("button", { name: "agentRuns.review.kinds.plan.deny" }))
    expect(onDecide).toHaveBeenLastCalledWith("deny", { kind: "plan", feedback: "tighter" })
  })

  it("capability audit: lists the stale ids and approves with no payload fields", async () => {
    const onDecide = jest.fn()
    render(
      <SquadReviewForm
        interrupt={interrupt("capability_audit", { missingCapabilities: ["cap.a", "cap.b"] })}
        onDecide={onDecide}
      />
    )
    expect(screen.getByText("cap.a")).toBeInTheDocument()
    await userEvent
      .setup()
      .click(
        screen.getByRole("button", { name: "agentRuns.review.kinds.capability_audit.approve" })
      )
    expect(onDecide).toHaveBeenCalledWith("approve", { kind: "capability_audit" })
  })

  it("budget: submits the integer amount and refuses a non-positive one", async () => {
    const onDecide = jest.fn()
    render(<SquadReviewForm interrupt={interrupt("budget_extension")} onDecide={onDecide} />)
    const user = userEvent.setup()
    const input = screen.getByLabelText("agentRuns.review.budget.extraTokensLabel")
    await user.clear(input)
    await user.type(input, "0")
    expect(
      screen.getByRole("button", { name: "agentRuns.review.kinds.budget_extension.approve" })
    ).toBeDisabled()
    await user.clear(input)
    await user.type(input, "120000")
    await user.click(
      screen.getByRole("button", { name: "agentRuns.review.kinds.budget_extension.approve" })
    )
    expect(onDecide).toHaveBeenCalledWith("approve", {
      kind: "budget_extension",
      extraTokens: 120000,
    })
  })

  it("deadlock: needs a teammate or reset-all before it can approve", async () => {
    const onDecide = jest.fn()
    render(
      <SquadReviewForm
        interrupt={interrupt("deadlock", { teammateIds: ["m1", "m2"] })}
        onDecide={onDecide}
      />
    )
    const user = userEvent.setup()
    const approve = screen.getByRole("button", { name: "agentRuns.review.kinds.deadlock.approve" })
    expect(approve).toBeDisabled()
    await user.click(screen.getByLabelText("m2"))
    await user.click(approve)
    expect(onDecide).toHaveBeenLastCalledWith("approve", { kind: "deadlock", teammateIds: ["m2"] })
    await user.click(screen.getByLabelText("agentRuns.review.deadlock.resetAll"))
    await user.click(approve)
    expect(onDecide).toHaveBeenLastCalledWith("approve", { kind: "deadlock", resetAll: true })
  })

  it("teammate repair: defaults to rejoin and can switch to skip", async () => {
    const onDecide = jest.fn()
    render(<SquadReviewForm interrupt={interrupt("teammate_repair")} onDecide={onDecide} />)
    const user = userEvent.setup()
    const approve = screen.getByRole("button", {
      name: "agentRuns.review.kinds.teammate_repair.approve",
    })
    await user.click(approve)
    expect(onDecide).toHaveBeenLastCalledWith("approve", {
      kind: "teammate_repair",
      action: "rejoin",
    })
    await user.click(screen.getByLabelText("agentRuns.review.teammateRepair.skip"))
    await user.click(approve)
    expect(onDecide).toHaveBeenLastCalledWith("approve", {
      kind: "teammate_repair",
      action: "skip",
    })
  })

  it("recovery: offers only the choices the interrupt carries and needs a host for retry_host", async () => {
    const onDecide = jest.fn()
    render(
      <SquadReviewForm
        interrupt={interrupt("team_recovery", {
          reason: "legacy_run_not_resumable",
          choices: ["restart_run", "terminate"],
          uncertainChildIds: [],
        })}
        onDecide={onDecide}
      />
    )
    expect(
      screen.queryByLabelText("agentRuns.review.recovery.choices.retry_same_host")
    ).not.toBeInTheDocument()
    expect(
      screen.getByText(
        'agentRuns.review.recovery.reason:{"reason":"agentRuns.review.recovery.reasons.legacy_run_not_resumable"}'
      )
    ).toBeInTheDocument()
    const user = userEvent.setup()
    const approve = screen.getByRole("button", {
      name: "agentRuns.review.kinds.team_recovery.approve",
    })
    expect(approve).toBeDisabled()
    await user.click(screen.getByLabelText("agentRuns.review.recovery.choices.restart_run"))
    await user.click(approve)
    expect(onDecide).toHaveBeenCalledWith("approve", {
      kind: "team_recovery",
      choice: "restart_run",
    })
  })

  it("recovery: retry_host stays disabled until a host is named", async () => {
    const onDecide = jest.fn()
    render(
      <SquadReviewForm
        interrupt={interrupt("team_recovery", { uncertainChildIds: ["c1"] })}
        onDecide={onDecide}
      />
    )
    const user = userEvent.setup()
    await user.click(screen.getByLabelText("agentRuns.review.recovery.choices.retry_host"))
    const approve = screen.getByRole("button", {
      name: "agentRuns.review.kinds.team_recovery.approve",
    })
    expect(approve).toBeDisabled()
    await user.type(screen.getByLabelText("agentRuns.review.recovery.hostRefPlaceholder"), "host-b")
    await user.click(approve)
    expect(onDecide).toHaveBeenCalledWith("approve", {
      kind: "team_recovery",
      choice: "retry_host",
      hostRef: "host-b",
    })
  })

  it("disables both buttons while a command is in flight", () => {
    render(<SquadReviewForm interrupt={interrupt("replan")} busy onDecide={() => {}} />)
    expect(
      screen.getByRole("button", { name: "agentRuns.review.kinds.replan.approve" })
    ).toBeDisabled()
    expect(
      screen.getByRole("button", { name: "agentRuns.review.kinds.replan.deny" })
    ).toBeDisabled()
  })
})
