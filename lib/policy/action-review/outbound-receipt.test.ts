import { ACTION_REVIEW_CONTRACT_VERSION } from "@cognia/agent-config-types/action-review"

import { jobAuthorizationOf, outboundReceipt, outboundReview } from "./outbound-receipt"
import { outboundFingerprint, toReviewTarget, type OutboundTarget } from "./outbound-targets"

const chat: OutboundTarget = {
  kind: "conversation",
  channel: "lark",
  recipient: "lark:oc_1",
}
const pr: OutboundTarget = {
  kind: "repository",
  channel: "github",
  recipient: "github:github.com/acme/app",
  thread: "7",
}

const base = {
  requestId: "delivery:1",
  origin: { channel: "connector-delivery" as const, scope: "connector", headless: true },
  subject: { kind: "connector-delivery" as const, ref: "bot", targets: [toReviewTarget(chat)] },
  plan: "allow" as const,
  enforced: true,
  outcome: "allow" as const,
  authority: "policy-rule" as const,
  reason: "listed",
  now: 42,
}

describe("outboundReceipt", () => {
  it("builds an outbound ask with the plan, its origin and the decision", () => {
    const receipt = outboundReceipt({
      ...base,
      origin: { ...base.origin, sessionId: "s1", rootSessionId: "root", instructionEpoch: "m9" },
      actor: { kind: "local-user" },
    })
    expect(receipt.request).toMatchObject({
      contractVersion: ACTION_REVIEW_CONTRACT_VERSION,
      requestId: "delivery:1",
      origin: {
        channel: "connector-delivery",
        scope: "connector",
        id: "delivery:1",
        sessionId: "s1",
        headless: true,
        rootSessionId: "root",
        instructionEpoch: "m9",
      },
      subject: base.subject,
      verdict: "ask",
      verdictExplicit: false,
      plan: { outcome: "allow", enforced: true },
      requestedAt: 42,
    })
    expect(receipt.request.tier).toBeDefined()
    expect(receipt.decision).toEqual({
      contractVersion: ACTION_REVIEW_CONTRACT_VERSION,
      requestId: "delivery:1",
      outcome: "allow",
      authority: "policy-rule",
      reason: "listed",
      actor: { kind: "local-user" },
      decidedAt: 42,
    })
  })

  it("leaves out the origin fields it was not given", () => {
    const receipt = outboundReceipt({
      ...base,
      origin: { channel: "browser-submission", scope: "browser" },
    })
    expect(receipt.request.origin).toEqual({
      channel: "browser-submission",
      scope: "browser",
      id: "delivery:1",
    })
  })

  it("keeps a grant only on a decision that permits", () => {
    const grant = { scope: "instruction" as const }
    expect(outboundReceipt({ ...base, grant }).decision.grant).toEqual(grant)
    expect(outboundReceipt({ ...base, outcome: "allow_always", grant }).decision.grant).toEqual(
      grant
    )
    expect(outboundReceipt({ ...base, outcome: "deny", grant }).decision.grant).toBeUndefined()
  })
})

describe("outboundReview", () => {
  it("shows every recipient with its thread, and the ones nothing authorized", () => {
    expect(outboundReview([chat, pr], [pr], false)).toEqual({
      targets: [
        { kind: "conversation", channel: "lark", recipient: "lark:oc_1" },
        {
          kind: "repository",
          channel: "github",
          recipient: "github:github.com/acme/app",
          thread: "7",
        },
      ],
      unauthorized: [
        {
          kind: "repository",
          channel: "github",
          recipient: "github:github.com/acme/app",
          thread: "7",
        },
      ],
      enforced: false,
    })
  })
})

describe("jobAuthorizationOf", () => {
  const call = {
    sessionId: "s1",
    requestId: "perm-1",
    toolUseId: "tu-1",
    toolName: "im_broadcast",
    fingerprints: [outboundFingerprint(chat)],
    authority: "human" as const,
    authorizedAt: 1,
  }

  it("names the call's receipt and authority", () => {
    expect(jobAuthorizationOf(call)).toEqual({ receiptId: "perm-1", authority: "human" })
  })

  it("carries the grant's scope and policy", () => {
    expect(
      jobAuthorizationOf({ ...call, grant: { scope: "instruction", policyRef: "list:1" } })
    ).toEqual({
      receiptId: "perm-1",
      authority: "human",
      grantScope: "instruction",
      policyRef: "list:1",
    })
  })
})
