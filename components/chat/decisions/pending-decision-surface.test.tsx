/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { PendingDecisionSurface, type PendingDecisionStatus } from "./pending-decision-surface"
import type { PendingApproval } from "@cognia/agent-config-types"
import type { AcpElicitationRequest } from "@/types/agent/external-agent"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

const approval: PendingApproval = {
  sessionId: "s1",
  requestId: "r1",
  toolUseID: "tu1",
  toolName: "bash",
  input: { command: "rm -rf /tmp/x" },
}

const elicitation: AcpElicitationRequest = {
  id: "e1",
  mode: "form",
  message: "Which branch?",
  raw: {},
  requestedSchema: {
    type: "object",
    properties: { branch: { type: "string", title: "Branch" } },
    required: ["branch"],
  },
}

describe("<PendingDecisionSurface /> — tool approval", () => {
  it("offers all three answers while pending", async () => {
    const user = userEvent.setup()
    const onRespond = jest.fn()
    render(
      <PendingDecisionSurface
        decision={{ kind: "tool-approval", approval }}
        onApprovalRespond={onRespond}
      />
    )
    await user.click(screen.getByTestId("decision-allow"))
    await user.click(screen.getByTestId("decision-allow-always"))
    await user.click(screen.getByTestId("decision-deny"))
    expect(onRespond.mock.calls.map(([d]) => d)).toEqual(["allow", "allow_always", "deny"])
  })

  /**
   * The rule this surface exists to hold. `resolved`, `expired` and
   * `interrupted` all mean the runtime stopped waiting, so Allow and Deny would
   * be lies about something that can still happen.
   */
  it.each<PendingDecisionStatus>(["resolved", "expired", "interrupted"])(
    "offers only dismissal once the decision is %s",
    async (status) => {
      const onDismiss = jest.fn()
      render(
        <PendingDecisionSurface
          decision={{ kind: "tool-approval", approval }}
          status={status}
          onApprovalRespond={jest.fn()}
          onDismiss={onDismiss}
        />
      )
      expect(screen.queryByTestId("decision-allow")).not.toBeInTheDocument()
      expect(screen.queryByTestId("decision-deny")).not.toBeInTheDocument()
      await userEvent.setup().click(screen.getByRole("button"))
      expect(onDismiss).toHaveBeenCalled()
    }
  )

  it("locks the answers while a response is already in flight", () => {
    render(
      <PendingDecisionSurface
        decision={{ kind: "tool-approval", approval }}
        status="responding"
        onApprovalRespond={jest.fn()}
      />
    )
    expect(screen.getByTestId("decision-allow")).toBeDisabled()
    expect(screen.getByTestId("decision-deny")).toBeDisabled()
  })

  /**
   * Mobile puts a biometric prompt on the allow direction. Deny is deliberately
   * NOT wrapped: refusing is the safe answer, and making it the expensive one
   * inverts the incentive.
   */
  it("routes allow through the caller's gate and lets deny straight through", async () => {
    const user = userEvent.setup()
    const onRespond = jest.fn()
    const confirmAllow = jest.fn(async (run: () => Promise<void>) => {
      await run()
    })
    render(
      <PendingDecisionSurface
        decision={{ kind: "tool-approval", approval }}
        onApprovalRespond={onRespond}
        confirmAllow={confirmAllow}
      />
    )
    await user.click(screen.getByTestId("decision-allow"))
    expect(confirmAllow).toHaveBeenCalledTimes(1)
    expect(onRespond).toHaveBeenCalledWith("allow")

    await user.click(screen.getByTestId("decision-deny"))
    expect(confirmAllow).toHaveBeenCalledTimes(1)
    expect(onRespond).toHaveBeenCalledWith("deny")
  })

  it("does not answer when the gate refuses", async () => {
    const user = userEvent.setup()
    const onRespond = jest.fn()
    render(
      <PendingDecisionSurface
        decision={{ kind: "tool-approval", approval }}
        onApprovalRespond={onRespond}
        confirmAllow={jest.fn(async () => {})}
      />
    )
    await user.click(screen.getByTestId("decision-allow"))
    expect(onRespond).not.toHaveBeenCalled()
  })

  it("gives an observer the question with no arguments and nothing to press", () => {
    render(
      <PendingDecisionSurface
        decision={{ kind: "tool-approval", approval }}
        mode="observe"
        onApprovalRespond={jest.fn()}
      />
    )
    expect(screen.getByTestId("approval-observe-redacted")).toBeInTheDocument()
    expect(screen.queryByText(/rm -rf/)).not.toBeInTheDocument()
    expect(screen.queryByTestId("decision-allow")).not.toBeInTheDocument()
  })

  /**
   * `locked-computer-use` is in the HostState vocabulary but has no producer —
   * host computer-use consent runs through the automation ConsentBroker on a
   * different plane. It renders as what it is (a permission decision) so the
   * day something raises one, it is not a blank card.
   */
  it("renders a locked computer-use decision exactly like a tool approval", () => {
    render(
      <PendingDecisionSurface
        decision={{ kind: "locked-computer-use", approval }}
        onApprovalRespond={jest.fn()}
      />
    )
    expect(screen.getByTestId("tool-decision-content")).toBeInTheDocument()
    expect(screen.getByTestId("decision-allow")).toBeInTheDocument()
  })
})

describe("<PendingDecisionSurface /> — elicitation", () => {
  it("keeps submit disabled until every required field is answered", async () => {
    const user = userEvent.setup()
    const onRespond = jest.fn()
    render(
      <PendingDecisionSurface
        decision={{ kind: "elicitation", request: elicitation }}
        onElicitationRespond={onRespond}
      />
    )
    expect(screen.getByTestId("decision-submit")).toBeDisabled()
    await user.type(screen.getByLabelText("Branch"), "main")
    expect(screen.getByTestId("decision-submit")).toBeEnabled()

    await user.click(screen.getByTestId("decision-submit"))
    expect(onRespond).toHaveBeenCalledWith({
      requestId: "e1",
      action: "accept",
      content: { branch: "main" },
    })
  })

  /** Declining is a deliberate "no" and carries no content. */
  it("declines without content", async () => {
    const user = userEvent.setup()
    const onRespond = jest.fn()
    render(
      <PendingDecisionSurface
        decision={{ kind: "elicitation", request: elicitation }}
        onElicitationRespond={onRespond}
      />
    )
    await user.click(screen.getByText("decline"))
    expect(onRespond).toHaveBeenCalledWith({
      requestId: "e1",
      action: "decline",
      content: undefined,
    })
  })

  it("shows an observer the question read-only", () => {
    render(
      <PendingDecisionSurface
        decision={{ kind: "elicitation", request: elicitation }}
        mode="observe"
        onElicitationRespond={jest.fn()}
      />
    )
    expect(screen.getByLabelText("Branch")).toBeDisabled()
    expect(screen.queryByTestId("decision-submit")).not.toBeInTheDocument()
  })
})
