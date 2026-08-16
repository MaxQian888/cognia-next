/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { TerminalTab } from "./terminal-tab"
import type { TerminalSessionRow } from "@/stores/terminal/terminal-store"

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
    tabColor: "none",
    tabIcon: "none",
    promptBoundaries: [],
    lastCommands: [],
    historyOpen: false,
    ...overrides,
    hostId: overrides.hostId ?? null,
    controllerId: overrides.controllerId ?? null,
  }
}

describe("TerminalTab", () => {
  it("renders the title", () => {
    const onSelect = jest.fn()
    const onClose = jest.fn()
    render(
      <TerminalTab
        row={row({ title: "build · cargo run" })}
        active={false}
        onSelect={onSelect}
        onClose={onClose}
      />
    )
    expect(screen.getByText("build · cargo run")).toBeInTheDocument()
  })

  it("marks itself as active when `active` prop is true", () => {
    render(<TerminalTab row={row()} active={true} onSelect={jest.fn()} onClose={jest.fn()} />)
    const tab = screen.getByTestId("terminal-tab")
    expect(tab.getAttribute("data-active")).toBe("true")
    expect(tab.getAttribute("aria-selected")).toBe("true")
  })

  it("calls onSelect when clicked", () => {
    const onSelect = jest.fn()
    render(<TerminalTab row={row()} active={false} onSelect={onSelect} onClose={jest.fn()} />)
    fireEvent.click(screen.getByTestId("terminal-tab"))
    expect(onSelect).toHaveBeenCalledWith("s-1")
  })

  it("calls onClose when the × button is clicked, without firing select", () => {
    const onSelect = jest.fn()
    const onClose = jest.fn()
    render(<TerminalTab row={row()} active={false} onSelect={onSelect} onClose={onClose} />)
    fireEvent.click(screen.getByLabelText("close"))
    expect(onClose).toHaveBeenCalledWith("s-1")
    expect(onSelect).not.toHaveBeenCalled()
  })

  it("uses red status dot for non-zero exit code", () => {
    const { container } = render(
      <TerminalTab
        row={row({ status: "exited", exitCode: 1 })}
        active={false}
        onSelect={jest.fn()}
        onClose={jest.fn()}
      />
    )
    expect(container.querySelector(".bg-red-500")).toBeTruthy()
  })

  it("uses green status dot for zero exit code", () => {
    const { container } = render(
      <TerminalTab
        row={row({ status: "exited", exitCode: 0 })}
        active={false}
        onSelect={jest.fn()}
        onClose={jest.fn()}
      />
    )
    expect(container.querySelector(".bg-emerald-500")).toBeTruthy()
  })

  it("uses blue status dot while running", () => {
    const { container } = render(
      <TerminalTab
        row={row({ status: "running" })}
        active={false}
        onSelect={jest.fn()}
        onClose={jest.fn()}
      />
    )
    expect(container.querySelector(".bg-blue-500")).toBeTruthy()
  })

  it("supports keyboard activation via Enter/Space", () => {
    const onSelect = jest.fn()
    render(<TerminalTab row={row()} active={false} onSelect={onSelect} onClose={jest.fn()} />)
    fireEvent.keyDown(screen.getByTestId("terminal-tab"), { key: "Enter" })
    expect(onSelect).toHaveBeenCalledWith("s-1")
    fireEvent.keyDown(screen.getByTestId("terminal-tab"), { key: " " })
    expect(onSelect).toHaveBeenCalledTimes(2)
  })

  it("displays the user-supplied customTitle when set", () => {
    render(
      <TerminalTab
        row={row({ title: "zsh", customTitle: "Build server" })}
        active={false}
        onSelect={jest.fn()}
        onClose={jest.fn()}
      />
    )
    expect(screen.getByText("Build server")).toBeInTheDocument()
    expect(screen.queryByText("zsh")).toBeNull()
  })

  it("falls back to title when customTitle is null", () => {
    render(
      <TerminalTab
        row={row({ title: "zsh", customTitle: null })}
        active={false}
        onSelect={jest.fn()}
        onClose={jest.fn()}
      />
    )
    expect(screen.getByText("zsh")).toBeInTheDocument()
  })

  it("exposes data-agent-trusted attribute when row is trusted", () => {
    render(
      <TerminalTab
        row={row({ agentTrusted: true })}
        active={false}
        onSelect={jest.fn()}
        onClose={jest.fn()}
      />
    )
    expect(screen.getByTestId("terminal-tab").getAttribute("data-agent-trusted")).toBe("true")
  })

  it("keeps the status dot accessibly labelled after the animated swap wrapper", () => {
    render(
      <TerminalTab
        row={row({ status: "running" })}
        active={false}
        onSelect={jest.fn()}
        onClose={jest.fn()}
      />
    )
    // The dot is wrapped by MotionStatusSwap for a crossfade on status change;
    // its aria-label must survive so screen-reader users still hear the status.
    expect(screen.getByLabelText("status.running")).toBeInTheDocument()
  })

  it("reveals the close button on keyboard focus, not only on hover (a11y)", () => {
    render(<TerminalTab row={row()} active={false} onSelect={jest.fn()} onClose={jest.fn()} />)
    const closeBtn = screen.getByLabelText("close")
    // Hover-only reveal left the × keyboard-unreachable; focus-visible +
    // group-focus-within bring it back for keyboard/touch users.
    expect(closeBtn.className).toContain("focus-visible:opacity-100")
    expect(closeBtn.className).toContain("group-focus-within:opacity-100")
  })

  it("calls onContextMenu when right-clicked", () => {
    const onContextMenu = jest.fn()
    render(
      <TerminalTab
        row={row()}
        active={false}
        onSelect={jest.fn()}
        onClose={jest.fn()}
        onContextMenu={onContextMenu}
      />
    )
    fireEvent.contextMenu(screen.getByTestId("terminal-tab"))
    expect(onContextMenu).toHaveBeenCalledTimes(1)
  })

  it("marks a throttled background tab so it is legible without switching to it", () => {
    render(
      <TerminalTab row={row()} active={false} onSelect={jest.fn()} onClose={jest.fn()} throttled />
    )
    const tab = screen.getByTestId("terminal-tab")
    expect(tab.getAttribute("data-throttled")).toBe("true")
    expect(tab.className).toContain("ring-orange-500/50")
  })

  it("draws the accent border only when a tab colour is chosen", () => {
    const { rerender } = render(
      <TerminalTab
        row={row({ tabColor: "none" })}
        active
        onSelect={jest.fn()}
        onClose={jest.fn()}
      />
    )
    expect(screen.getByTestId("terminal-tab").className).not.toContain("border-l-2")

    rerender(
      <TerminalTab
        row={row({ tabColor: "blue" })}
        active
        onSelect={jest.fn()}
        onClose={jest.fn()}
      />
    )
    expect(screen.getByTestId("terminal-tab").className).toContain("border-l-2")
  })

  it("shows the activity dot only on an inactive tab", () => {
    const { rerender } = render(
      <TerminalTab
        row={row()}
        active={false}
        onSelect={jest.fn()}
        onClose={jest.fn()}
        hasActivity
      />
    )
    expect(screen.getByLabelText("status.newOutput")).toBeInTheDocument()

    // Switching to the tab is what acknowledges the output, so the badge goes.
    rerender(
      <TerminalTab row={row()} active onSelect={jest.fn()} onClose={jest.fn()} hasActivity />
    )
    expect(screen.queryByLabelText("status.newOutput")).toBeNull()
  })

  describe("SSH tabs", () => {
    function renderTab(overrides: Partial<TerminalSessionRow>) {
      render(
        <TerminalTab row={row(overrides)} active={false} onSelect={jest.fn()} onClose={jest.fn()} />
      )
      return screen.getByTestId("terminal-tab")
    }

    it("marks the transport kind on the element", () => {
      expect(renderTab({ kind: "ssh" }).getAttribute("data-kind")).toBe("ssh")
    })

    it("treats a row saved before the field existed as a local shell", () => {
      expect(renderTab({}).getAttribute("data-kind")).toBe("localPty")
    })

    it("gives an SSH tab a default glyph so it is not mistaken for a local shell", () => {
      const { container } = render(
        <TerminalTab
          row={row({ kind: "ssh", tabIcon: "none" })}
          active={false}
          onSelect={jest.fn()}
          onClose={jest.fn()}
        />
      )
      expect(container.querySelector("svg.lucide-server")).not.toBeNull()
    })

    it("lets a deliberately chosen icon override the SSH default", () => {
      const { container } = render(
        <TerminalTab
          row={row({ kind: "ssh", tabIcon: "rocket" })}
          active={false}
          onSelect={jest.fn()}
          onClose={jest.fn()}
        />
      )
      expect(container.querySelector("svg.lucide-rocket")).not.toBeNull()
      expect(container.querySelector("svg.lucide-server")).toBeNull()
    })

    it("leaves a local tab without a glyph", () => {
      const { container } = render(
        <TerminalTab row={row()} active={false} onSelect={jest.fn()} onClose={jest.fn()} />
      )
      expect(container.querySelector("svg.lucide-server")).toBeNull()
    })
  })
})
