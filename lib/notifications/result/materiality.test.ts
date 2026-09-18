// Coverage for materiality (V2): deterministic stable hashing, order-
// independent fact hashing, and the suppress-if-unchanged judgment — only an
// ACCEPTED prior send is a baseline; a failed/unknown attempt delivered
// nothing and can never make fresh facts immaterial. Pure — no Dexie.

import { stableStringify, stableHash, materialHashOfFacts, judgeMateriality } from "./materiality"
import type { RunResultFact } from "@/types/notifications/result"
import type { NotificationDeliveryIntent } from "@/types/notifications/delivery"

function fact(over: Partial<RunResultFact> = {}): RunResultFact {
  return {
    kind: over.kind ?? "outcome",
    text: over.text ?? "done",
    classification: over.classification ?? "public",
    ...(over.artifactRef ? { artifactRef: over.artifactRef } : {}),
    ...(over.redacted !== undefined ? { redacted: over.redacted } : {}),
  }
}

function intent(over: Partial<NotificationDeliveryIntent> = {}): NotificationDeliveryIntent {
  return {
    id: over.id ?? "i1",
    scopeKey: "s",
    scope: { namespaceId: "n", accountId: "a", authorityHostId: "h" },
    operationKey: over.operationKey ?? "op",
    targetId: "t",
    targetAddress: { kind: "feishu-webhook", endpointSecretRef: "x", region: "feishu" },
    targetVersion: 1,
    purpose: "result-summary",
    category: "run.result",
    status: over.status ?? "accepted",
    payload: {
      title: "t",
      body: "b",
      level: "info",
      disclosureLevel: "public",
      clippedFactCount: 0,
      contentHash: over.payload?.contentHash ?? "hash",
    },
    attemptCount: 0,
    maxAttempts: 3,
    createdAt: 0,
    updatedAt: 0,
    ...(over.slotKey ? { slotKey: over.slotKey } : {}),
  }
}

describe("stableStringify", () => {
  it("sorts object keys deterministically", () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }))
  })

  it("preserves array order", () => {
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]))
  })

  it("drops undefined fields", () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }))
  })
})

describe("stableHash", () => {
  it("is deterministic for the same value", () => {
    expect(stableHash({ x: [1, { y: "z" }] })).toBe(stableHash({ x: [1, { y: "z" }] }))
  })

  it("differs for different values", () => {
    expect(stableHash({ a: 1 })).not.toBe(stableHash({ a: 2 }))
  })

  it("produces a 32-char hex digest", () => {
    expect(stableHash({ a: 1 })).toMatch(/^[0-9a-f]{32}$/)
  })
})

describe("materialHashOfFacts", () => {
  it("is order-independent — a re-order of the same facts hashes identically", () => {
    const a = [fact({ kind: "outcome", text: "x" }), fact({ kind: "metric", text: "1/2" })]
    const b = [fact({ kind: "metric", text: "1/2" }), fact({ kind: "outcome", text: "x" })]
    expect(materialHashOfFacts(a)).toBe(materialHashOfFacts(b))
  })

  it("changes when a fact's text changes", () => {
    const a = [fact({ text: "old" })]
    const b = [fact({ text: "new" })]
    expect(materialHashOfFacts(a)).not.toBe(materialHashOfFacts(b))
  })

  it("changes when a fact is added or removed", () => {
    const a = [fact({ text: "x" })]
    const b = [fact({ text: "x" }), fact({ text: "y" })]
    expect(materialHashOfFacts(a)).not.toBe(materialHashOfFacts(b))
  })
})

describe("judgeMateriality", () => {
  const facts = [fact({ kind: "outcome", text: "done" })]
  const hash = materialHashOfFacts(facts)

  it("is material with no baselines", () => {
    const v = judgeMateriality({ candidateFacts: facts, baselines: [] })
    expect(v.material).toBe(true)
    expect(v.baselineKind).toBe("none")
  })

  it("is immaterial when an accepted prior intent carried the same content hash", () => {
    const prior = intent({
      status: "accepted",
      payload: { ...intent().payload, contentHash: hash },
      slotKey: "s1",
    })
    const v = judgeMateriality({ candidateFacts: facts, baselines: [prior] })
    expect(v.material).toBe(false)
    expect(v.reason).toBe("unchanged")
    expect(v.baselineKind).toBe("same-slot")
  })

  it("is material when the accepted prior intent carried DIFFERENT content", () => {
    const prior = intent({
      status: "accepted",
      payload: { ...intent().payload, contentHash: "other" },
    })
    const v = judgeMateriality({ candidateFacts: facts, baselines: [prior] })
    expect(v.material).toBe(true)
  })

  it("never treats a FAILED prior send as a baseline — nothing was delivered", () => {
    const prior = intent({ status: "failed", payload: { ...intent().payload, contentHash: hash } })
    const v = judgeMateriality({ candidateFacts: facts, baselines: [prior] })
    // Same hash but the prior send failed → still material (must re-deliver).
    expect(v.material).toBe(true)
  })

  it("never treats a delivery-unknown prior send as a baseline", () => {
    const prior = intent({
      status: "delivery-unknown",
      payload: { ...intent().payload, contentHash: hash },
    })
    const v = judgeMateriality({ candidateFacts: facts, baselines: [prior] })
    expect(v.material).toBe(true)
  })
})
