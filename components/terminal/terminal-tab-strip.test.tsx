/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { TerminalTabStrip } from "./terminal-tab-strip"
import type { TerminalSessionRow } from "@/stores/terminal/terminal-store"
import { useSettingsStore } from "@/stores/settings/settings-store"

function row(overrides: Partial<TerminalSessionRow> = {}): TerminalSessionRow {
  return {
    id: "s-1",
    projectId: "proj-a",
    extensionId: null,
    title: "bash",
    customTitle: null,
    shell: "/bin/bash",
    origin: "local",
    status: "idle",
    exitCode: null,
    cwd: null,
    createdAt: 0,
    agentTrusted: false,
    agentSpawner: null,
    promptBoundaries: [],
    lastCommands: [],
    historyOpen: false,
    ...overrides,
    hostId: overrides.hostId ?? null,
    controllerId: overrides.controllerId ?? null,
  }
}

describe("TerminalTabStrip", () => {
  it("renders one TerminalTab per row in order", () => {
    render(
      <TerminalTabStrip
        tabs={[
          row({ id: "a", title: "alpha", createdAt: 1 }),
          row({ id: "b", title: "beta", createdAt: 2 }),
        ]}
        activeId="b"
        onSelect={jest.fn()}
        onClose={jest.fn()}
      />
    )
    const tabs = screen.getAllByTestId("terminal-tab")
    expect(tabs).toHaveLength(2)
    expect(tabs[0].getAttribute("data-id")).toBe("a")
    expect(tabs[1].getAttribute("data-id")).toBe("b")
    expect(tabs[1].getAttribute("data-active")).toBe("true")
  })

  it("renders the trailing slot when provided", () => {
    render(
      <TerminalTabStrip
        tabs={[]}
        activeId={null}
        onSelect={jest.fn()}
        onClose={jest.fn()}
        trailing={<button data-testid="trailing-btn">trailing</button>}
      />
    )
    expect(screen.getByTestId("trailing-btn")).toBeInTheDocument()
  })

  it("omits the trailing container when no slot supplied", () => {
    const { container } = render(
      <TerminalTabStrip tabs={[]} activeId={null} onSelect={jest.fn()} onClose={jest.fn()} />
    )
    expect(container.querySelector(".ml-auto")).toBeNull()
  })

  it("forwards onSelect from a tab click", () => {
    const onSelect = jest.fn()
    render(
      <TerminalTabStrip
        tabs={[row({ id: "a" })]}
        activeId="a"
        onSelect={onSelect}
        onClose={jest.fn()}
      />
    )
    fireEvent.click(screen.getByTestId("terminal-tab"))
    expect(onSelect).toHaveBeenCalledWith("a")
  })

  it("forwards onContextMenu with the corresponding row", () => {
    const onContextMenu = jest.fn()
    const target = row({ id: "ctx" })
    render(
      <TerminalTabStrip
        tabs={[target]}
        activeId={null}
        onSelect={jest.fn()}
        onClose={jest.fn()}
        onContextMenu={onContextMenu}
      />
    )
    fireEvent.contextMenu(screen.getByTestId("terminal-tab"))
    expect(onContextMenu).toHaveBeenCalledTimes(1)
    expect(onContextMenu.mock.calls[0][0]).toEqual(target)
  })

  it("still renders every tab when motion is reduced (animation collapses to instant)", () => {
    useSettingsStore.setState({ settings: { motion: { reduce: true, speed: 1 } } as never })
    const { unmount } = render(
      <TerminalTabStrip
        tabs={[row({ id: "a" }), row({ id: "b" })]}
        activeId="a"
        onSelect={jest.fn()}
        onClose={jest.fn()}
      />
    )
    expect(screen.getAllByTestId("terminal-tab").map((t) => t.getAttribute("data-id"))).toEqual([
      "a",
      "b",
    ])
    // Unmount before restoring the store so the reset doesn't re-render a live
    // subscriber outside act().
    unmount()
    useSettingsStore.setState({ settings: {} as never })
  })

  it("honors custom testId override", () => {
    render(
      <TerminalTabStrip
        tabs={[]}
        activeId={null}
        onSelect={jest.fn()}
        onClose={jest.fn()}
        testId="mobile-terminal-tabs"
      />
    )
    expect(screen.getByTestId("mobile-terminal-tabs")).toBeInTheDocument()
  })
})
