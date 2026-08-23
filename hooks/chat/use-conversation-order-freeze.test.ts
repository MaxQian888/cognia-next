import { renderHook } from "@testing-library/react"

import type { ChatSession } from "@cognia/agent-config-types"

import type { ConversationSection } from "@/lib/chat/conversation-list-model"
import { useConversationOrderFreeze } from "./use-conversation-order-freeze"

function row(id: string): ChatSession {
  return { id, title: id, createdAt: 0, updatedAt: 0 } as ChatSession
}

function bucket(b: "today" | "yesterday", ids: string[]): ConversationSection {
  return { kind: "date", bucket: b, sessions: ids.map(row) }
}

function idsOf(sections: readonly ConversationSection[]) {
  return sections.flatMap((section) => section.sessions.map((s) => s.id))
}

type Props = {
  sections: ConversationSection[]
  hovering: boolean
  disabled?: boolean
}

const setup = (initial: Props) =>
  renderHook((props: Props) => useConversationOrderFreeze(props), { initialProps: initial })

describe("useConversationOrderFreeze", () => {
  it("passes the live order through while the pointer is elsewhere", () => {
    const { result, rerender } = setup({
      sections: [bucket("today", ["a", "b"])],
      hovering: false,
    })
    rerender({ sections: [bucket("today", ["b", "a"])], hovering: false })
    expect(idsOf(result.current)).toEqual(["b", "a"])
  })

  it("holds the order the reader was shown once the pointer arrives", () => {
    const { result, rerender } = setup({
      sections: [bucket("today", ["a", "b", "c"])],
      hovering: true,
    })
    rerender({ sections: [bucket("today", ["c", "a", "b"])], hovering: true })
    expect(idsOf(result.current)).toEqual(["a", "b", "c"])
  })

  it("settles the instant the pointer leaves — the hold is self-limiting", () => {
    // No escape hatch exists because none is needed: hovering is the only
    // signal, so the hold can never outlive the reason for it.
    const { result, rerender } = setup({
      sections: [bucket("today", ["a", "b"])],
      hovering: true,
    })
    rerender({ sections: [bucket("today", ["b", "a"])], hovering: true })
    expect(idsOf(result.current)).toEqual(["a", "b"])
    rerender({ sections: [bucket("today", ["b", "a"])], hovering: false })
    expect(idsOf(result.current)).toEqual(["b", "a"])
  })

  it("captures afresh on the next hover, not the order from the last one", () => {
    const { result, rerender } = setup({
      sections: [bucket("today", ["a", "b"])],
      hovering: true,
    })
    rerender({ sections: [bucket("today", ["b", "a"])], hovering: false })
    rerender({ sections: [bucket("today", ["b", "a"])], hovering: true })
    rerender({ sections: [bucket("today", ["a", "b"])], hovering: true })
    expect(idsOf(result.current)).toEqual(["b", "a"])
  })

  it("keeps a row in its bucket when activity would move it", () => {
    const { result, rerender } = setup({
      sections: [bucket("today", ["a"]), bucket("yesterday", ["b"])],
      hovering: true,
    })
    rerender({ sections: [bucket("today", ["b", "a"])], hovering: true })
    expect(result.current.map((s) => s.sessions.map((r) => r.id))).toEqual([["a"], ["b"]])
  })

  it("lets a new conversation through", () => {
    // The reveal ladder has to be able to show a chat the user just created.
    const { result, rerender } = setup({
      sections: [bucket("today", ["a"])],
      hovering: true,
    })
    rerender({ sections: [bucket("today", ["new", "a"])], hovering: true })
    expect(idsOf(result.current)).toEqual(["new", "a"])
  })

  it("drops a deleted row immediately", () => {
    const { result, rerender } = setup({
      sections: [bucket("today", ["a", "b"])],
      hovering: true,
    })
    rerender({ sections: [bucket("today", ["b"])], hovering: true })
    expect(idsOf(result.current)).toEqual(["b"])
  })

  it("does nothing at all while disabled", () => {
    const { result, rerender } = setup({
      sections: [bucket("today", ["a", "b"])],
      hovering: true,
      disabled: true,
    })
    rerender({ sections: [bucket("today", ["b", "a"])], hovering: true, disabled: true })
    expect(idsOf(result.current)).toEqual(["b", "a"])
  })
})
