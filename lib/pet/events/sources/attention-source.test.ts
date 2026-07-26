import { createAttentionSource } from "./attention-source"
import type { AttentionItem } from "@/lib/attention/types"

function attentionItem(id: string, stale = false): AttentionItem {
  return {
    id,
    source: "team",
    kind: "hitl-gate",
    title: "Review",
    openedAt: 1,
    stale,
  }
}

describe("createAttentionSource", () => {
  it("emits only when actionable attention appears or fully clears", () => {
    let items: readonly AttentionItem[] = []
    let onChange: () => void = () => {
      throw new Error("Subscriber was not wired")
    }
    const emit = jest.fn()
    const dispose = jest.fn()
    const wire = createAttentionSource({
      subscribe: (listener) => {
        onChange = listener
        return dispose
      },
      getSnapshot: () => items,
    })

    const stop = wire(emit)
    expect(emit).not.toHaveBeenCalled()

    items = [attentionItem("team:1")]
    onChange()
    expect(emit).toHaveBeenLastCalledWith({
      source: "attention",
      kind: "waiting",
      xp: 0,
      meta: { pendingCount: 1 },
    })

    items = [attentionItem("team:1"), attentionItem("team:2")]
    onChange()
    expect(emit).toHaveBeenCalledTimes(1)

    items = [attentionItem("team:1", true)]
    onChange()
    expect(emit).toHaveBeenLastCalledWith({
      source: "attention",
      kind: "review",
      xp: 0,
      meta: { pendingCount: 0 },
    })
    expect(emit).toHaveBeenCalledTimes(2)

    stop()
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it("surfaces actionable attention that already exists when wiring starts", () => {
    const emit = jest.fn()
    const wire = createAttentionSource({
      subscribe: () => () => {},
      getSnapshot: () => [attentionItem("team:existing"), attentionItem("team:stale", true)],
    })

    wire(emit)

    expect(emit).toHaveBeenCalledWith({
      source: "attention",
      kind: "waiting",
      xp: 0,
      meta: { pendingCount: 1 },
    })
  })
})
