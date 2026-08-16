/** @jest-environment jsdom */

import { act, render } from "@testing-library/react"
import { useShellColumnsStore } from "@/stores/ui/shell-columns-store"
import { useSidebarNavHost } from "./use-sidebar-nav-host"

function Host({ active }: { active: boolean }) {
  useSidebarNavHost(active)
  return null
}

const hosts = () => useShellColumnsStore.getState().sidebarHostsNav

beforeEach(() => {
  act(() => useShellColumnsStore.setState({ sidebarHostsNav: false }))
})

describe("useSidebarNavHost", () => {
  it("registers while active and clears on unmount", () => {
    const { unmount } = render(<Host active />)
    expect(hosts()).toBe(true)
    unmount()
    expect(hosts()).toBe(false)
  })

  it("does nothing while inactive, and follows the condition as it changes", () => {
    const { rerender } = render(<Host active={false} />)
    expect(hosts()).toBe(false)
    rerender(<Host active />)
    expect(hosts()).toBe(true)
    // Collapsed / switched to a plugin view: the rows are gone, so is the claim.
    rerender(<Host active={false} />)
    expect(hosts()).toBe(false)
  })

  it("keeps the claim while two hosts overlap (outgoing cleanup after incoming mount)", () => {
    const outgoing = render(<Host active />)
    const incoming = render(<Host active />)
    expect(hosts()).toBe(true)
    // The old sidebar leaves after the new one has registered — the icon
    // column must not flash back in between.
    outgoing.unmount()
    expect(hosts()).toBe(true)
    incoming.unmount()
    expect(hosts()).toBe(false)
  })
})
