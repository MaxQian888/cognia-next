import { renderHook } from "@testing-library/react"

import { localiseItem, useLocalisedItems } from "./use-localised-items"
import type { UnifiedScheduledItem } from "@/types/scheduler/unified"

function item(overrides: Partial<UnifiedScheduledItem> = {}): UnifiedScheduledItem {
  return {
    unifiedId: "backup:default",
    kind: "backup",
    sourceId: "default",
    name: "Automatic backup",
    status: "active",
    triggerSummary: { type: "interval", intervalMs: 1 },
    origin: { deepLinkHref: "/settings" },
    capabilities: { runNow: true, pause: true, edit: true, delete: false },
    ...overrides,
  }
}

describe("useLocalisedItems", () => {
  it("returns the same object when nothing is keyed", () => {
    const plain = item()
    expect(localiseItem(plain, () => "x")).toBe(plain)
  })

  it("resolves the name and description keys with their values", () => {
    const { result } = renderHook(() =>
      useLocalisedItems([
        item({
          nameKey: "unifiedNames.outboundQueue",
          nameValues: { count: 3 },
          descriptionKey: "unifiedNames.outboundQueueDescription",
        }),
        item({ unifiedId: "app:a", kind: "app", name: "Mine" }),
      ])
    )
    expect(result.current[0].name).toBe("Outbound queue (3)")
    expect(result.current[0].description).toBe("Connector outbound delivery queue")
    expect(result.current[1].name).toBe("Mine")
  })
})
