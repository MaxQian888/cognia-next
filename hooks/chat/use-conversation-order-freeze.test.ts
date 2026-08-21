import { act, renderHook } from "@testing-library/react"

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
  scrolled: boolean
  disabled?: boolean
}

const setup = (initial: Props) =>
  renderHook((props: Props) => useConversationOrderFreeze(props), { initialProps: initial })

describe("useConversationOrderFreeze", () => {
  it("passes the live order through while neither signal is on", () => {
    const { result, rerender } = setup({
      sections: [bucket("today", ["a", "b"])],
      hovering: false,
      scrolled: false,
    })
    expect(result.current.frozen).toBe(false)
    rerender({ sections: [bucket("today", ["b", "a"])], hovering: false, scrolled: false })
    expect(idsOf(result.current.sections)).toEqual(["b", "a"])
    expect(result.current.pending).toBe(0)
  })

  it("holds the order the reader was shown once the pointer arrives", () => {
    const { result, rerender } = setup({
      sections: [bucket("today", ["a", "b", "c"])],
      hovering: true,
      scrolled: false,
    })
    rerender({ sections: [bucket("today", ["c", "a", "b"])], hovering: true, scrolled: false })
    expect(idsOf(result.current.sections)).toEqual(["a", "b", "c"])
    expect(result.current.frozen).toBe(true)
    expect(result.current.pending).toBe(1)
  })

  it("freezes on scroll alone — touch has no pointer to offer", () => {
    const { result, rerender } = setup({
      sections: [bucket("today", ["a", "b"])],
      hovering: false,
      scrolled: true,
    })
    rerender({ sections: [bucket("today", ["b", "a"])], hovering: false, scrolled: true })
    expect(idsOf(result.current.sections)).toEqual(["a", "b"])
  })

  it("keeps holding while either signal is still on", () => {
    // Release is the conjunction: pointer gone AND back at the top.
    const { result, rerender } = setup({
      sections: [bucket("today", ["a", "b"])],
      hovering: true,
      scrolled: true,
    })
    rerender({ sections: [bucket("today", ["b", "a"])], hovering: false, scrolled: true })
    expect(idsOf(result.current.sections)).toEqual(["a", "b"])
    rerender({ sections: [bucket("today", ["b", "a"])], hovering: false, scrolled: false })
    expect(idsOf(result.current.sections)).toEqual(["b", "a"])
    expect(result.current.frozen).toBe(false)
  })

  it("applies everything at once on release, and starts holding again from there", () => {
    const { result, rerender } = setup({
      sections: [bucket("today", ["a", "b", "c"])],
      hovering: true,
      scrolled: false,
    })
    rerender({ sections: [bucket("today", ["c", "a", "b"])], hovering: true, scrolled: false })
    expect(result.current.pending).toBe(1)
    act(() => result.current.release())
    expect(idsOf(result.current.sections)).toEqual(["c", "a", "b"])
    expect(result.current.pending).toBe(0)
    // Still hovering, so the new arrangement is what is now held.
    rerender({ sections: [bucket("today", ["b", "c", "a"])], hovering: true, scrolled: false })
    expect(idsOf(result.current.sections)).toEqual(["c", "a", "b"])
  })

  it("keeps a row in its bucket when activity would move it", () => {
    const { result, rerender } = setup({
      sections: [bucket("today", ["a"]), bucket("yesterday", ["b"])],
      hovering: true,
      scrolled: false,
    })
    rerender({ sections: [bucket("today", ["b", "a"])], hovering: true, scrolled: false })
    expect(result.current.sections.map((s) => s.sessions.map((r) => r.id))).toEqual([["a"], ["b"]])
    expect(result.current.pending).toBeGreaterThan(0)
  })

  it("lets a new conversation through without counting it as pending", () => {
    // The reveal ladder has to be able to show a chat the user just created.
    const { result, rerender } = setup({
      sections: [bucket("today", ["a"])],
      hovering: true,
      scrolled: false,
    })
    rerender({ sections: [bucket("today", ["new", "a"])], hovering: true, scrolled: false })
    expect(idsOf(result.current.sections)).toEqual(["new", "a"])
    expect(result.current.pending).toBe(0)
  })

  it("drops a deleted row immediately", () => {
    const { result, rerender } = setup({
      sections: [bucket("today", ["a", "b"])],
      hovering: true,
      scrolled: false,
    })
    rerender({ sections: [bucket("today", ["b"])], hovering: true, scrolled: false })
    expect(idsOf(result.current.sections)).toEqual(["b"])
  })

  it("does nothing at all while disabled", () => {
    const { result, rerender } = setup({
      sections: [bucket("today", ["a", "b"])],
      hovering: true,
      scrolled: true,
      disabled: true,
    })
    rerender({
      sections: [bucket("today", ["b", "a"])],
      hovering: true,
      scrolled: true,
      disabled: true,
    })
    expect(idsOf(result.current.sections)).toEqual(["b", "a"])
    expect(result.current.frozen).toBe(false)
  })
})
