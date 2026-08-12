/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import {
  ACTION_REVIEW_CONTRACT_VERSION,
  type ActionReviewReceipt,
} from "@cognia/agent-config-types/action-review"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDecisionContext } from "@/lib/db/governance-ledger"
import { recordActionReviewEffectGovernance, recordActionReviewGovernance } from "./action-review"

const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)

function receipt(
  channel: ActionReviewReceipt["request"]["origin"]["channel"],
  authority: ActionReviewReceipt["decision"]["authority"]
): ActionReviewReceipt {
  return {
    contractVersion: ACTION_REVIEW_CONTRACT_VERSION,
    id: `review-${channel}`,
    request: {
      contractVersion: ACTION_REVIEW_CONTRACT_VERSION,
      requestId: `request-${channel}`,
      origin: {
        channel,
        scope: channel === "workflow" ? "workflow" : "chat",
        id: "origin-1",
        sessionId: "session-1",
        runId: "run-1",
        workflowId: "workflow-1",
        projectId: "project-1",
      },
      subject: { kind: "tool-call", ref: "Bash" },
      verdict: "ask",
      verdictExplicit: true,
      tier: "high",
      surfaces: [{ id: "native-command", evidence: "shell" }],
      recommendation: { suggests: "deny", confidence: 0.9, source: "policy" },
      requestedAt: 90,
    },
    decision: {
      contractVersion: ACTION_REVIEW_CONTRACT_VERSION,
      requestId: `request-${channel}`,
      outcome: authority === "human" ? "allow" : "deny",
      authority,
      actor:
        authority === "human"
          ? { kind: "local-user", id: "user-1", label: "Current user" }
          : undefined,
      reason: authority === "human" ? "Reviewed locally" : undefined,
      decidedAt: 100,
    },
    expiresAt: 1_000,
  }
}

it.each([
  ["chat-tool", "human", "tool-authorization"],
  ["workflow", "policy", "human-approval"],
] as const)(
  "projects %s review decisions and redacted policy evidence",
  async (channel, authority, kind) => {
    const value = receipt(channel, authority)
    await recordActionReviewGovernance(value)

    const context = await getDecisionContext(`action-review:${value.id}`)
    expect(context?.decision).toMatchObject({
      kind,
      resolution: { outcome: value.decision.outcome },
      correlation: { sessionId: "session-1", runId: "run-1", workflowId: "workflow-1" },
    })
    expect(context?.evidence).toHaveLength(1)
    expect(context?.lineage).toHaveLength(1)
    expect(context?.provenance).toHaveLength(1)
    expect(JSON.stringify(context)).not.toContain("shell command body")
  }
)

it("redacts a review reason before persisting the decision", async () => {
  const value = receipt("chat-tool", "human")
  value.decision.reason = "Approved by alice@example.com"

  await recordActionReviewGovernance(value)

  const context = await getDecisionContext(`action-review:${value.id}`)
  expect(context?.decision.resolution?.reasonCode).toBe("human")
  expect(context?.decision.resolution?.rationale).toBeDefined()
  expect(JSON.stringify(context)).not.toContain("alice@example.com")
})

it.each([
  ["executed", "executed"],
  ["failed", "failed"],
] as const)("attaches a %s action effect to the decision lineage", async (status, state) => {
  const value = receipt("chat-tool", "human")
  await recordActionReviewGovernance(value)
  await recordActionReviewEffectGovernance(value.id, { status, completedAt: 120 })

  const context = await getDecisionContext(`action-review:${value.id}`)
  expect(context?.decision.lifecycle.state).toBe(state)
  expect(context?.events.at(-1)?.type).toBe(state)
  expect(context?.lineage).toEqual(
    expect.arrayContaining([expect.objectContaining({ relation: "resulted-in" })])
  )
})
