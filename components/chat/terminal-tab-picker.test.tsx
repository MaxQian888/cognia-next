/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { TerminalTabPicker } from "./terminal-tab-picker"
import { useTerminalStore } from "@/stores/terminal/terminal-store"
import { useProjectStore } from "@/stores/project/project-store"
import type { SessionInfo } from "@/lib/terminal/types"

function info(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "s-1",
    projectId: "proj-a",
    extensionId: null,
    origin: "local",
    shell: "/bin/bash",
    ...overrides,
  }
}

beforeEach(() => {
  useTerminalStore.getState().reset()
  useProjectStore.setState({ projects: [], activeProjectId: "proj-a" })
})

describe("TerminalTabPicker", () => {
  it("offers a New tab item even when no tabs exist", () => {
    render(
      <TerminalTabPicker onPick={jest.fn()} open>
        <button>trigger</button>
      </TerminalTabPicker>
    )
    expect(screen.getByTestId("terminal-tab-picker-new")).toBeInTheDocument()
  })

  it("lists project's existing tabs", () => {
    useTerminalStore.getState().registerSession(info({ id: "a" }))
    useTerminalStore.getState().registerSession(info({ id: "b" }))
    useTerminalStore.getState().registerSession(info({ id: "c", projectId: "other" }))
    render(
      <TerminalTabPicker onPick={jest.fn()} open>
        <button>trigger</button>
      </TerminalTabPicker>
    )
    const items = screen.getAllByTestId("terminal-tab-picker-existing")
    expect(items).toHaveLength(2)
  })

  it("selecting an existing tab fires onPick with kind=existing", () => {
    useTerminalStore.getState().registerSession(info({ id: "a" }))
    const onPick = jest.fn()
    render(
      <TerminalTabPicker onPick={onPick} open>
        <button>trigger</button>
      </TerminalTabPicker>
    )
    fireEvent.click(screen.getByTestId("terminal-tab-picker-existing"))
    expect(onPick).toHaveBeenCalledWith({
      kind: "existing",
      row: expect.objectContaining({ id: "a" }),
    })
  })

  it("selecting New fires onPick with kind=new", () => {
    const onPick = jest.fn()
    render(
      <TerminalTabPicker onPick={onPick} open>
        <button>trigger</button>
      </TerminalTabPicker>
    )
    fireEvent.click(screen.getByTestId("terminal-tab-picker-new"))
    expect(onPick).toHaveBeenCalledWith({ kind: "new" })
  })

  it("shows trusted badge for trusted tabs", () => {
    useTerminalStore.getState().registerSession(info({ id: "a" }))
    useTerminalStore.getState().setAgentTrusted("a", true)
    render(
      <TerminalTabPicker onPick={jest.fn()} open>
        <button>trigger</button>
      </TerminalTabPicker>
    )
    expect(screen.getByText("trustedBadge")).toBeInTheDocument()
  })
})
