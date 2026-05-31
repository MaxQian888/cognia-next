/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { TerminalTabContextMenu } from "./terminal-tab-context-menu"
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

function renderMenu(props: Partial<React.ComponentProps<typeof TerminalTabContextMenu>> = {}) {
  const handlers = {
    onRename: jest.fn(),
    onRestart: jest.fn(),
    onClose: jest.fn(),
    onCloseOthers: jest.fn(),
    onToggleAgentTrust: jest.fn(),
  }
  const r = row(props.row)
  render(
    <TerminalTabContextMenu row={r} {...handlers} {...props}>
      <button data-testid="trigger">tab</button>
    </TerminalTabContextMenu>
  )
  // Open the menu by simulating context menu on the trigger.
  fireEvent.contextMenu(screen.getByTestId("trigger"))
  return { ...handlers, row: r }
}

describe("TerminalTabContextMenu", () => {
  it("opens on right-click and exposes Rename / Restart / Close / Close Others / Trust", () => {
    renderMenu()
    expect(screen.getByTestId("terminal-tab-menu")).toBeInTheDocument()
    expect(screen.getByTestId("terminal-tab-menu-rename")).toBeInTheDocument()
    expect(screen.getByTestId("terminal-tab-menu-restart")).toBeInTheDocument()
    expect(screen.getByTestId("terminal-tab-menu-close")).toBeInTheDocument()
    expect(screen.getByTestId("terminal-tab-menu-close-others")).toBeInTheDocument()
    expect(screen.getByTestId("terminal-tab-menu-trust")).toBeInTheDocument()
  })

  it("Rename fires onRename with the row id", () => {
    const { onRename } = renderMenu()
    fireEvent.click(screen.getByTestId("terminal-tab-menu-rename"))
    expect(onRename).toHaveBeenCalledWith("s-1")
  })

  it("Restart fires onRestart with the row id", () => {
    const { onRestart } = renderMenu()
    fireEvent.click(screen.getByTestId("terminal-tab-menu-restart"))
    expect(onRestart).toHaveBeenCalledWith("s-1")
  })

  it("Close fires onClose with the row id", () => {
    const { onClose } = renderMenu()
    fireEvent.click(screen.getByTestId("terminal-tab-menu-close"))
    expect(onClose).toHaveBeenCalledWith("s-1")
  })

  it("Close Others fires onCloseOthers with the row id", () => {
    const { onCloseOthers } = renderMenu()
    fireEvent.click(screen.getByTestId("terminal-tab-menu-close-others"))
    expect(onCloseOthers).toHaveBeenCalledWith("s-1")
  })

  it("Trust Agent toggle flips the boolean", () => {
    const { onToggleAgentTrust } = renderMenu()
    fireEvent.click(screen.getByTestId("terminal-tab-menu-trust"))
    expect(onToggleAgentTrust).toHaveBeenCalledWith("s-1", true)
  })

  it("Trust Agent shows checked when row.agentTrusted is true", () => {
    renderMenu({ row: row({ agentTrusted: true }) })
    const item = screen.getByTestId("terminal-tab-menu-trust")
    expect(item.getAttribute("data-state")).toBe("checked")
  })

  it("hides Locate in conversation for user-spawned tabs", () => {
    renderMenu()
    expect(screen.queryByTestId("terminal-tab-menu-locate")).toBeNull()
  })

  it("shows Locate in conversation for agent tabs and fires onLocateInChat", () => {
    const onLocateInChat = jest.fn()
    renderMenu({ row: row({ agentSpawner: "chat-9" }), onLocateInChat })
    fireEvent.click(screen.getByTestId("terminal-tab-menu-locate"))
    expect(onLocateInChat).toHaveBeenCalledWith("chat-9")
  })

  it("omits the edit group when no clipboard handlers are passed", () => {
    renderMenu()
    expect(screen.queryByTestId("terminal-tab-menu-copy")).toBeNull()
    expect(screen.queryByTestId("terminal-tab-menu-find")).toBeNull()
  })

  it("renders the edit group and fires clipboard / find / clear / select-all", () => {
    const onCopy = jest.fn()
    const onPaste = jest.fn()
    const onSelectAll = jest.fn()
    const onClear = jest.fn()
    const onFind = jest.fn()
    renderMenu({ onCopy, onPaste, onSelectAll, onClear, onFind })
    fireEvent.click(screen.getByTestId("terminal-tab-menu-copy"))
    expect(onCopy).toHaveBeenCalledTimes(1)
    fireEvent.contextMenu(screen.getByTestId("trigger"))
    fireEvent.click(screen.getByTestId("terminal-tab-menu-paste"))
    expect(onPaste).toHaveBeenCalledTimes(1)
    fireEvent.contextMenu(screen.getByTestId("trigger"))
    fireEvent.click(screen.getByTestId("terminal-tab-menu-select-all"))
    expect(onSelectAll).toHaveBeenCalledTimes(1)
    fireEvent.contextMenu(screen.getByTestId("trigger"))
    fireEvent.click(screen.getByTestId("terminal-tab-menu-clear"))
    expect(onClear).toHaveBeenCalledTimes(1)
    fireEvent.contextMenu(screen.getByTestId("trigger"))
    fireEvent.click(screen.getByTestId("terminal-tab-menu-find"))
    expect(onFind).toHaveBeenCalledTimes(1)
  })
})
