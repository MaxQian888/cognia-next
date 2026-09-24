import { resolveFunctionalToastFactory } from "./registry"
import { scheduledDueToastSpec } from "./scheduled-due"
import type { NotificationRecord } from "@/types/notifications"

function rec(overrides: Partial<NotificationRecord>): NotificationRecord {
  return {
    id: "n1",
    source: "system",
    level: "info",
    title: "x",
    createdAt: 0,
    updatedAt: 0,
    readState: "unseen",
    count: 1,
    directed: false,
    deliveredVia: [],
    ...overrides,
  }
}

describe("resolveFunctionalToastFactory", () => {
  it("claims the pet scheduled-due signature", () => {
    const factory = resolveFunctionalToastFactory(
      rec({ groupKey: "pet-scheduled-due", sourceRef: { kind: "task", id: "t1" } })
    )
    expect(factory).toBe(scheduledDueToastSpec)
  })

  it("rejects records missing either half of the signature", () => {
    // Right groupKey, wrong sourceRef kind.
    expect(
      resolveFunctionalToastFactory(
        rec({ groupKey: "pet-scheduled-due", sourceRef: { kind: "site", id: "s1" } })
      )
    ).toBeNull()
    // Right sourceRef kind, wrong groupKey.
    expect(
      resolveFunctionalToastFactory(
        rec({ groupKey: "other", sourceRef: { kind: "task", id: "t1" } })
      )
    ).toBeNull()
    // Neither.
    expect(resolveFunctionalToastFactory(rec({}))).toBeNull()
  })
})
