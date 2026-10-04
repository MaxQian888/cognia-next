/** @jest-environment jsdom */

import { act, render } from "@testing-library/react"
import { useShellColumnsStore } from "@/stores/ui/shell-columns-store"
import { useSidebarCollapseHost } from "./use-sidebar-collapse-host"

function Host({ active }: { active: boolean }) {
  useSidebarCollapseHost(active)
  return null
}

const hosts = () => useShellColumnsStore.getState().sidebarHostsCollapse

beforeEach(() => {
  act(() =>
    useShellColumnsStore.setState({ sidebarHostsCollapse: false, sidebarCollapseHostCount: 0 })
  )
})

describe("useSidebarCollapseHost", () => {
  it("claims the collapse control while active and lets go on unmount", () => {
    const { unmount } = render(<Host active />)
    expect(hosts()).toBe(true)
    unmount()
    expect(hosts()).toBe(false)
  })

  it("follows the condition as it changes", () => {
    const { rerender } = render(<Host active={false} />)
    expect(hosts()).toBe(false)
    rerender(<Host active />)
    expect(hosts()).toBe(true)
    rerender(<Host active={false} />)
    expect(hosts()).toBe(false)
  })

  it("keeps the claim while an outgoing and an incoming footer overlap", () => {
    const outgoing = render(<Host active />)
    const incoming = render(<Host active />)
    outgoing.unmount()
    expect(hosts()).toBe(true)
    incoming.unmount()
    expect(hosts()).toBe(false)
  })

  it("releases once, however often the cleanup runs", () => {
    const release = useShellColumnsStore.getState().registerSidebarCollapseHost()
    const second = useShellColumnsStore.getState().registerSidebarCollapseHost()
    act(() => {
      release()
      release()
    })
    expect(hosts()).toBe(true)
    act(() => second())
    expect(hosts()).toBe(false)
  })
})
