import { act, renderHook } from "@testing-library/react"

import type { ChatSession } from "@cognia/agent-config-types"

import type { ConversationSection } from "@/lib/chat/conversation-list-model"
import { useConversationOrderFreeze } from "./use-conversation-order-freeze"

// One object per id, like the structurally shared rows `useSessions` hands
// out: a row that did not change keeps its identity across emissions.
const rows = new Map<string, ChatSession>()
function row(id: string): ChatSession {
  let existing = rows.get(id)
  if (!existing) {
    existing = { id, title: id, createdAt: 0, updatedAt: 0 } as ChatSession
    rows.set(id, existing)
  }
  return existing
}

function bucket(b: "today" | "yesterday", ids: string[]): ConversationSection {
  return { kind: "date", bucket: b, sessions: ids.map(row) }
}

function idsOf(sections: readonly ConversationSection[]) {
  return sections.flatMap((section) => section.sessions.map((s) => s.id))
}

type Props = {
  sections: ConversationSection[]
  disabled?: boolean
  preserveEmptyGroups?: boolean
  orderKey?: string
}

function setup(initial: Props) {
  let renders = 0
  const hook = renderHook(
    (props: Props) => {
      renders += 1
      return useConversationOrderFreeze(props)
    },
    { initialProps: initial }
  )
  const enter = () => act(() => hook.result.current.onPointerEnter())
  const leave = () => act(() => hook.result.current.onPointerLeave())
  return { ...hook, enter, leave, renders: () => renders }
}

describe("useConversationOrderFreeze", () => {
  it("passes the live order through while the pointer is elsewhere", () => {
    const { result, rerender } = setup({ sections: [bucket("today", ["a", "b"])] })
    rerender({ sections: [bucket("today", ["b", "a"])] })
    expect(idsOf(result.current.sections)).toEqual(["b", "a"])
  })

  it("holds the order the reader was shown once the pointer arrives", () => {
    const { result, rerender, enter } = setup({ sections: [bucket("today", ["a", "b", "c"])] })
    enter()
    rerender({ sections: [bucket("today", ["c", "a", "b"])] })
    expect(idsOf(result.current.sections)).toEqual(["a", "b", "c"])
  })

  it("settles the instant the pointer leaves — the hold is self-limiting", () => {
    // No escape hatch exists because none is needed: hovering is the only
    // signal, so the hold can never outlive the reason for it.
    const { result, rerender, enter, leave } = setup({ sections: [bucket("today", ["a", "b"])] })
    enter()
    rerender({ sections: [bucket("today", ["b", "a"])] })
    expect(idsOf(result.current.sections)).toEqual(["a", "b"])
    leave()
    expect(idsOf(result.current.sections)).toEqual(["b", "a"])
  })

  it("captures afresh on the next hover, not the order from the last one", () => {
    const { result, rerender, enter, leave } = setup({ sections: [bucket("today", ["a", "b"])] })
    enter()
    leave()
    rerender({ sections: [bucket("today", ["b", "a"])] })
    enter()
    rerender({ sections: [bucket("today", ["a", "b"])] })
    expect(idsOf(result.current.sections)).toEqual(["b", "a"])
  })

  it("keeps a row in its bucket when activity would move it", () => {
    const { result, rerender, enter } = setup({
      sections: [bucket("today", ["a"]), bucket("yesterday", ["b"])],
    })
    enter()
    rerender({ sections: [bucket("today", ["b", "a"])] })
    expect(result.current.sections.map((s) => s.sessions.map((r) => r.id))).toEqual([["a"], ["b"]])
  })

  it("lets a new conversation through", () => {
    // The reveal ladder has to be able to show a chat the user just created.
    const { result, rerender, enter } = setup({ sections: [bucket("today", ["a"])] })
    enter()
    rerender({ sections: [bucket("today", ["new", "a"])] })
    expect(idsOf(result.current.sections)).toEqual(["new", "a"])
  })

  it("drops a deleted row immediately", () => {
    const { result, rerender, enter } = setup({ sections: [bucket("today", ["a", "b"])] })
    enter()
    rerender({ sections: [bucket("today", ["b"])] })
    expect(idsOf(result.current.sections)).toEqual(["b"])
  })

  it("does nothing at all while disabled", () => {
    const { result, rerender, enter } = setup({
      sections: [bucket("today", ["a", "b"])],
      disabled: true,
    })
    enter()
    rerender({ sections: [bucket("today", ["b", "a"])], disabled: true })
    expect(idsOf(result.current.sections)).toEqual(["b", "a"])
  })

  it("drops the hold when a search or drag starts under the pointer, and re-captures after", () => {
    const { result, rerender, enter } = setup({ sections: [bucket("today", ["a", "b"])] })
    enter()
    // A search takes over ordering: the live order shows at once.
    rerender({ sections: [bucket("today", ["b", "a"])], disabled: true })
    expect(idsOf(result.current.sections)).toEqual(["b", "a"])
    // It ends with the pointer still inside: the order on screen now is held.
    rerender({ sections: [bucket("today", ["b", "a"])], disabled: false })
    rerender({ sections: [bucket("today", ["a", "b"])], disabled: false })
    expect(idsOf(result.current.sections)).toEqual(["b", "a"])
  })

  it("follows a sort the reader picks while the pointer is inside the list", () => {
    // The merged rail's "Filter and sort" menu lives inside the hovered list,
    // so choosing a sort always happens under a hold. It is the reader's own
    // re-arrangement: the new order shows at once and is what gets held next.
    const { result, rerender, enter } = setup({
      sections: [bucket("today", ["a", "b", "c"])],
      orderKey: "none:title",
    })
    enter()
    rerender({ sections: [bucket("today", ["c", "b", "a"])], orderKey: "none:recent" })
    expect(idsOf(result.current.sections)).toEqual(["c", "b", "a"])
    // Background activity after the switch is held against the new order.
    rerender({ sections: [bucket("today", ["a", "c", "b"])], orderKey: "none:recent" })
    expect(idsOf(result.current.sections)).toEqual(["c", "b", "a"])
  })

  it("captures a hover under the sort already on screen", () => {
    // A sort chosen while the pointer was elsewhere is simply the live order
    // at the next hover — the key change must not cost that hover its hold.
    const { result, rerender, enter } = setup({
      sections: [bucket("today", ["a", "b"])],
      orderKey: "none:title",
    })
    rerender({ sections: [bucket("today", ["b", "a"])], orderKey: "none:recent" })
    enter()
    rerender({ sections: [bucket("today", ["a", "b"])], orderKey: "none:recent" })
    expect(idsOf(result.current.sections)).toEqual(["b", "a"])
  })

  it("keeps an emptied group section when preserveEmptyGroups is on", () => {
    // The scope tree's squad headers are chrome, not content: while the
    // pointer is inside the list an emptied squad must not flicker out —
    // its header is where folding, the menu and "new conversation" live.
    const team = (ids: string[]): ConversationSection => ({
      kind: "group",
      axis: "team",
      group: { id: "t1", name: "Squad" },
      sessions: ids.map(row),
      collapsed: false,
    })
    const { result, rerender, enter } = setup({
      sections: [team(["a"])],
      preserveEmptyGroups: true,
    })
    enter()
    rerender({ sections: [team([])], preserveEmptyGroups: true })
    expect(result.current.sections).toHaveLength(1)
    expect(result.current.sections[0]!.sessions).toEqual([])
  })

  it("hands back the live sections themselves while nothing has moved", () => {
    // What keeps the list below from re-rendering at all when the pointer
    // crosses into it: same array in, same array out.
    const live = [bucket("today", ["a", "b"]), bucket("yesterday", ["c"])]
    const { result, rerender, enter, leave } = setup({ sections: live })
    enter()
    expect(result.current.sections).toBe(live)
    // A fresh emission with the same rows in the same places is still "nothing
    // moved": the projection resolves to the live array again.
    const reEmitted = [bucket("today", ["a", "b"]), bucket("yesterday", ["c"])]
    rerender({ sections: reEmitted })
    expect(result.current.sections).toBe(reEmitted)
    leave()
    expect(result.current.sections).toBe(reEmitted)
  })

  it("costs one render per pointer crossing, and keeps its handlers stable", () => {
    const { result, enter, leave, renders } = setup({ sections: [bucket("today", ["a"])] })
    const { onPointerEnter, onPointerLeave } = result.current
    const before = renders()
    enter()
    expect(renders() - before).toBe(1)
    leave()
    expect(renders() - before).toBe(2)
    expect(result.current.onPointerEnter).toBe(onPointerEnter)
    expect(result.current.onPointerLeave).toBe(onPointerLeave)
  })
})
