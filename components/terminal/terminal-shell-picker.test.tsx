/**
 * @jest-environment jsdom
 */

import type { ReactNode } from "react"
import { act, render, screen, fireEvent, cleanup } from "@testing-library/react"

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

import { TerminalShellPicker, type DetectShells } from "./terminal-shell-picker"

beforeEach(() => {
  cleanup()
})

/** No detection — exercises the platform list unchanged. */
const noDetect: DetectShells = () => Promise.resolve(new Set())

/** Render and flush the (async) detection effect so state settles. */
async function renderPicker(ui: React.ReactElement) {
  await act(async () => {
    render(ui)
    await Promise.resolve()
  })
}

/** Click the menu row whose text content includes `text`. */
function clickShellItem(text: string) {
  const row = screen
    .getAllByTestId("shell-menu-item")
    .find((el) => el.textContent?.includes(text)) as HTMLElement
  fireEvent.click(row)
}

describe("TerminalShellPicker", () => {
  it("spawns the default shell when the main button is clicked", async () => {
    const onNew = jest.fn()
    await renderPicker(
      <TerminalShellPicker onNew={onNew} platform="macos" detectShells={noDetect} />
    )
    fireEvent.click(screen.getByTestId("terminal-dock-new"))
    // Default-resolution path → no explicit shell argument.
    expect(onNew).toHaveBeenCalledTimes(1)
    expect(onNew.mock.calls[0][0]).toBeUndefined()
  })

  it("offers an auto/default entry that resolves the default shell", async () => {
    const onNew = jest.fn()
    await renderPicker(
      <TerminalShellPicker onNew={onNew} platform="macos" detectShells={noDetect} />
    )
    clickShellItem("terminal.shellPicker.auto")
    expect(onNew).toHaveBeenCalledWith(undefined)
  })

  it("shows Windows shells on Windows and launches them", async () => {
    const onNew = jest.fn()
    await renderPicker(
      <TerminalShellPicker onNew={onNew} platform="windows" detectShells={noDetect} />
    )
    expect(screen.getByTestId("terminal-shell-picker-shell-cmd")).toBeInTheDocument()
    expect(screen.getByTestId("terminal-shell-picker-shell-pwsh")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("terminal-shell-picker-shell-pwsh"))
    expect(onNew).toHaveBeenCalledWith("pwsh.exe")
  })

  it("never shows Windows shells on macOS (the reported bug)", async () => {
    await renderPicker(
      <TerminalShellPicker onNew={jest.fn()} platform="macos" detectShells={noDetect} />
    )
    expect(screen.queryByTestId("terminal-shell-picker-shell-pwsh")).toBeNull()
    expect(screen.queryByTestId("terminal-shell-picker-shell-powershell")).toBeNull()
    expect(screen.queryByTestId("terminal-shell-picker-shell-cmd")).toBeNull()
    // POSIX shells are present instead.
    expect(screen.getByTestId("terminal-shell-picker-shell-zsh")).toBeInTheDocument()
    expect(screen.getByTestId("terminal-shell-picker-shell-bash")).toBeInTheDocument()
  })

  it("launches a POSIX shell with its absolute path", async () => {
    const onNew = jest.fn()
    await renderPicker(
      <TerminalShellPicker onNew={onNew} platform="macos" detectShells={noDetect} />
    )
    fireEvent.click(screen.getByTestId("terminal-shell-picker-shell-zsh"))
    expect(onNew).toHaveBeenCalledWith("/bin/zsh")
  })

  it("narrows the list to the shells detected on PATH", async () => {
    const detect: DetectShells = () => Promise.resolve(new Set(["zsh"]))
    await renderPicker(
      <TerminalShellPicker onNew={jest.fn()} platform="macos" detectShells={detect} />
    )
    // Only zsh survived detection; the others are hidden…
    expect(screen.getByTestId("terminal-shell-picker-shell-zsh")).toBeInTheDocument()
    expect(screen.queryByTestId("terminal-shell-picker-shell-bash")).toBeNull()
    expect(screen.queryByTestId("terminal-shell-picker-shell-fish")).toBeNull()
    // …but the always-available default entry remains.
    const rows = screen.getAllByTestId("shell-menu-item")
    expect(rows.some((r) => r.textContent?.includes("terminal.shellPicker.auto"))).toBe(true)
  })

  it("keeps the full list when detection finds nothing (menu never empties)", async () => {
    const detect: DetectShells = () => Promise.resolve(new Set(["nonexistent"]))
    await renderPicker(
      <TerminalShellPicker onNew={jest.fn()} platform="macos" detectShells={detect} />
    )
    expect(screen.getByTestId("terminal-shell-picker-shell-zsh")).toBeInTheDocument()
    expect(screen.getByTestId("terminal-shell-picker-shell-bash")).toBeInTheDocument()
  })

  it("renders a shell-picker trigger with an accessible label", async () => {
    await renderPicker(
      <TerminalShellPicker onNew={jest.fn()} platform="macos" detectShells={noDetect} />
    )
    expect(screen.getByTestId("terminal-dock-shell-picker")).toHaveAttribute(
      "aria-label",
      "terminal.shellPicker.label"
    )
  })

  it("lists saved profiles and launches them via onNewProfile", async () => {
    const onNewProfile = jest.fn()
    await renderPicker(
      <TerminalShellPicker
        onNew={jest.fn()}
        platform="macos"
        detectShells={noDetect}
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
