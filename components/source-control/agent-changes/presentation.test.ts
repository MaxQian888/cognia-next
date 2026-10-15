import {
  changesetActions,
  integrationReasonKey,
  reviewReasonKey,
  REVIEW_REASON_KEYS,
  INTEGRATION_REASON_KEYS,
} from "./presentation"
import type { ChangesetState } from "@/lib/scm/types"

it("maps known review reasons and policy codes, with a safe fallback", () => {
  for (const [code, key] of Object.entries(REVIEW_REASON_KEYS))
    expect(reviewReasonKey(code)).toBe(key)
  expect(reviewReasonKey("reviewPolicyInvalid")).toBe("reasons.reviewPolicyInvalid")
  expect(reviewReasonKey("reviewPolicyInvalid:badProfile")).toBe("reasons.reviewPolicyInvalid")
  expect(reviewReasonKey("futureReason")).toBe("reasons.unknown")
  expect(reviewReasonKey("toString")).toBe("reasons.unknown")
})

it("translates every integration refusal and unknown codes", () => {
  for (const [code, key] of Object.entries(INTEGRATION_REASON_KEYS))
    expect(integrationReasonKey(code)).toBe(key)
  expect(integrationReasonKey("future")).toBe("integrationReasons.unknown")
})

it.each<ChangesetState>([
  "draft",
  "ready",
  "approved",
  "changesRequested",
  "queued",
  "integrating",
  "merged",
  "conflicted",
  "failed",
  "rolledBack",
  "abandoned",
])("mirrors host action states for %s", (state) => {
  const allowed = changesetActions(state)
  expect(allowed.select).toBe(["approved", "queued"].includes(state))
  expect(allowed.review).toBe(["draft", "ready", "approved", "changesRequested"].includes(state))
  expect(allowed.approve).toBe(["ready", "approved", "changesRequested"].includes(state))
  expect(allowed.requestChanges).toBe(allowed.approve)
  expect(allowed.abandon).toBe(
    !["integrating", "merged", "rolledBack", "abandoned"].includes(state)
  )
})
