import { orderListItems } from "./list-order"
import type { AttentionSignal } from "./attention"
import type { UnifiedScheduledItem } from "@/types/scheduler/unified"

function item(name: string, nextRunAt?: number): UnifiedScheduledItem {
  return {
    unifiedId: `app:${name}`,
    kind: "app",
    sourceId: name,
    name,
    status: "active",
    triggerSummary: { type: "cron" },
    nextRunAt,
    origin: { deepLinkHref: "/scheduler" },
    capabilities: { runNow: true, pause: true, edit: true, delete: true },
  }
}

function signal(id: string, severity: AttentionSignal["severity"]): AttentionSignal {
  return { id, kind: "running", severity, itemUnifiedId: `app:${id}` }
}

describe("orderListItems", () => {
  const now = 1_000

  it("puts attention first, then running, then soonest next run, then name", () => {
    const items = [
      item("zeta", 5_000),
      item("alpha", 2_000),
      item("failing", 9_000),
      item("running", 1_500),
      item("never"),
      item("beta", 2_000),
    ]
    const signalByItem = new Map<string, AttentionSignal | null>([
      ["app:failing", signal("failing", "critical")],
      ["app:running", signal("running", "info")],
    ])
    expect(orderListItems(items, { signalByItem, now }).map((i) => i.name)).toEqual([
      "failing",
      "running",
      "alpha",
      "beta",
      "zeta",
      "never",
    ])
  })

  it("treats an overdue next run as firing now, ahead of the future", () => {
    const items = [item("future", 3_000), item("overdue", 200)]
    const ordered = orderListItems(items, { signalByItem: new Map(), now })
    expect(ordered.map((i) => i.name)).toEqual(["overdue", "future"])
  })

  it("does not mutate the input", () => {
    const items = [item("b", 2), item("a", 1)]
    orderListItems(items, { signalByItem: new Map(), now })
    expect(items.map((i) => i.name)).toEqual(["b", "a"])
  })
})
