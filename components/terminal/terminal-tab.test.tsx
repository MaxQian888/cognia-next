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
    promptBoundaries: [],
    lastCommands: [],
    historyOpen: false,
    ...overrides,
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
})
