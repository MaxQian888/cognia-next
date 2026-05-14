/**
 * @jest-environment jsdom
 */
import React from "react"
import { act, render, screen, fireEvent } from "@testing-library/react"
import type { UIMessage } from "ai"
import { BranchNavigator } from "./branch-navigator"
import { useChatStore } from "@/stores/chat/chat-store"

const branchMsg = (id: string, branchGroupId: string, branchIndex: number): UIMessage =>
  ({
    id,
    role: "assistant",
    parts: [{ type: "text", text: id }],
    metadata: { branchGroupId, branchIndex },
  }) as unknown as UIMessage

describe("BranchNavigator", () => {
  beforeEach(() => {
    useChatStore.getState().clear()
  })

  it("renders nothing when the message has no branchGroupId", () => {
    const { container } = render(
      <BranchNavigator
        message={{ id: "m1", role: "assistant", parts: [] } as unknown as UIMessage}
      />
    )
    expect(container.firstChild).toBeNull()
  })

  it("renders nothing when there is only one branch in the group", () => {
    const m = branchMsg("m1", "g1", 0)
    act(() => useChatStore.getState().replaceMessages([m]))
    const { container } = render(<BranchNavigator message={m} />)
    expect(container.firstChild).toBeNull()
  })

  it("renders counter as currentIndex+1 / total with active branch", () => {
    const a = branchMsg("a", "g1", 0)
    const b = branchMsg("b", "g1", 1)
    const c = branchMsg("c", "g1", 2)
    act(() => {
      useChatStore.getState().replaceMessages([a, b, c])
      useChatStore.getState().setActiveBranch("g1", "b")
    })
    render(<BranchNavigator message={b} />)
    expect(screen.getByTestId("branch-navigator-counter")).toHaveTextContent("2 / 3")
  })

  it("falls back to the highest index when no active branch is recorded", () => {
    const a = branchMsg("a", "g1", 0)
    const b = branchMsg("b", "g1", 1)
    act(() => useChatStore.getState().replaceMessages([a, b]))
    render(<BranchNavigator message={b} />)
    expect(screen.getByTestId("branch-navigator-counter")).toHaveTextContent("2 / 2")
  })

  it("clicking Next advances the active branch (with wrap-around)", () => {
    const a = branchMsg("a", "g1", 0)
    const b = branchMsg("b", "g1", 1)
    act(() => {
      useChatStore.getState().replaceMessages([a, b])
      useChatStore.getState().setActiveBranch("g1", "b")
    })
    render(<BranchNavigator message={b} />)
    fireEvent.click(screen.getByTestId("branch-navigator-next"))
    expect(useChatStore.getState().activeBranchByGroup.g1).toBe("a")
  })

  it("clicking Prev moves to the previous branch", () => {
    const a = branchMsg("a", "g1", 0)
    const b = branchMsg("b", "g1", 1)
    act(() => {
      useChatStore.getState().replaceMessages([a, b])
      useChatStore.getState().setActiveBranch("g1", "b")
    })
    render(<BranchNavigator message={b} />)
    fireEvent.click(screen.getByTestId("branch-navigator-prev"))
    expect(useChatStore.getState().activeBranchByGroup.g1).toBe("a")
  })

  it("wraps Prev from the first branch to the last", () => {
    const a = branchMsg("a", "g1", 0)
    const b = branchMsg("b", "g1", 1)
    const c = branchMsg("c", "g1", 2)
    act(() => {
      useChatStore.getState().replaceMessages([a, b, c])
      useChatStore.getState().setActiveBranch("g1", "a")
    })
    render(<BranchNavigator message={a} />)
    fireEvent.click(screen.getByTestId("branch-navigator-prev"))
    expect(useChatStore.getState().activeBranchByGroup.g1).toBe("c")
  })
})
