import type { PendingOutboundReview } from "@cognia/agent-config-types"

import {
  MAX_PARKED_OUTBOUND,
  __resetRunApprovalOutboundForTesting,
  forgetRunApprovalOutbound,
  rememberRunApprovalOutbound,
  runApprovalOutbound,
} from "./run-approval-outbound"

const review: PendingOutboundReview = {
  enforced: true,
  targets: [{ kind: "conversation", channel: "bot-a", recipient: "conv:lark:bot-a:oc_1" }],
  unauthorized: [{ kind: "conversation", channel: "bot-a", recipient: "conv:lark:bot-a:oc_1" }],
}

beforeEach(() => __resetRunApprovalOutboundForTesting())

describe("run approval recipients", () => {
  it("holds a parked request's recipients until it is forgotten", () => {
    rememberRunApprovalOutbound("tool-interrupt:r:1", review)
    expect(runApprovalOutbound("tool-interrupt:r:1")).toBe(review)
    expect(runApprovalOutbound("tool-interrupt:r:2")).toBeUndefined()
    forgetRunApprovalOutbound("tool-interrupt:r:1")
    expect(runApprovalOutbound("tool-interrupt:r:1")).toBeUndefined()
  })

  it("drops the oldest request past the bound", () => {
    for (let i = 0; i <= MAX_PARKED_OUTBOUND; i++) rememberRunApprovalOutbound(`i${i}`, review)
    expect(runApprovalOutbound("i0")).toBeUndefined()
    expect(runApprovalOutbound("i1")).toBe(review)
    expect(runApprovalOutbound(`i${MAX_PARKED_OUTBOUND}`)).toBe(review)
  })

  it("keeps a re-remembered request as the newest", () => {
    rememberRunApprovalOutbound("first", review)
    for (let i = 0; i < MAX_PARKED_OUTBOUND - 1; i++) rememberRunApprovalOutbound(`i${i}`, review)
    rememberRunApprovalOutbound("first", review)
    rememberRunApprovalOutbound("one-more", review)
    expect(runApprovalOutbound("first")).toBe(review)
    expect(runApprovalOutbound("i0")).toBeUndefined()
  })
})
