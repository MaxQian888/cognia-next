/**
 * @jest-environment jsdom
 */

import type { ReactNode } from "react"
import { render, screen, fireEvent, cleanup } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// Render the dropdown content inline (Radix pointer events are unreliable in
// jsdom) so the shell items are queryable + clickable. `onSelect` maps to the
// row's click — the same approach as `mode-selector.test.tsx`.
jest.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => null,
  DropdownMenuItem: ({
    children,
    onSelect,
    "data-testid": testId,
  }: {
    children: ReactNode
    onSelect?: () => void
    "data-testid"?: string
  }) => (
    <div data-testid={testId ?? "shell-menu-item"} role="button" tabIndex={0} onClick={onSelect}>
      {children}
    </div>
  ),
}))

import { TerminalShellPicker } from "./terminal-shell-picker"

beforeEach(() => {
  cleanup()
})

/** Click the menu row whose text content includes `text`. */
function clickShellItem(text: string) {
  const row = screen
    .getAllByTestId("shell-menu-item")
    .find((el) => el.textContent?.includes(text)) as HTMLElement
  fireEvent.click(row)
}

describe("TerminalShellPicker", () => {
  it("spawns the default shell when the main button is clicked", () => {
    const onNew = jest.fn()
    render(<TerminalShellPicker onNew={onNew} />)
    fireEvent.click(screen.getByTestId("terminal-dock-new"))
    // Default-resolution path → no explicit shell argument.
    expect(onNew).toHaveBeenCalledTimes(1)
    expect(onNew.mock.calls[0][0]).toBeUndefined()
  })

  it("launches a specific shell from the dropdown", () => {
    const onNew = jest.fn()
    render(<TerminalShellPicker onNew={onNew} />)
    clickShellItem("terminal.shellPicker.cmd")
    expect(onNew).toHaveBeenCalledWith("cmd.exe")
  })

  it("launches PowerShell 7 from the dropdown", () => {
    const onNew = jest.fn()
    render(<TerminalShellPicker onNew={onNew} />)
    clickShellItem("terminal.shellPicker.pwsh")
    expect(onNew).toHaveBeenCalledWith("pwsh.exe")
  })

  it("offers an auto/default entry that resolves the default shell", () => {
    const onNew = jest.fn()
    render(<TerminalShellPicker onNew={onNew} />)
    clickShellItem("terminal.shellPicker.auto")
    expect(onNew).toHaveBeenCalledWith(undefined)
  })

  it("renders a shell-picker trigger with an accessible label", () => {
    render(<TerminalShellPicker onNew={jest.fn()} />)
    expect(screen.getByTestId("terminal-dock-shell-picker")).toHaveAttribute(
      "aria-label",
      "terminal.shellPicker.label"
    )
  })

  it("lists saved profiles and launches them via onNewProfile", () => {
    const onNewProfile = jest.fn()
    render(
      <TerminalShellPicker
        onNew={jest.fn()}
        onNewProfile={onNewProfile}
        profiles={[
          { id: "profile-1", name: "Repo bash", shell: "/bin/bash" },
          { id: "profile-2", name: "Blank", shell: "  " },
        ]}
      />
    )
    // The blank-shell profile is filtered out.
    expect(screen.queryByText("Blank")).toBeNull()
    fireEvent.click(screen.getByTestId("terminal-shell-picker-profile-profile-1"))
    expect(onNewProfile).toHaveBeenCalledWith("profile-1")
  })
})
