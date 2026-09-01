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
  // The submenu is flattened: the trigger renders inline and the content is
  // always visible, so a test clicks a baud row directly instead of driving
  // Radix's hover/keyboard open. What is under test is which callback fires
  // with which arguments, not Radix's own menu behaviour.
  DropdownMenuSub: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSubTrigger: ({
    children,
    onClick,
    "data-testid": testId,
  }: {
    children: ReactNode
    onClick?: () => void
    "data-testid"?: string
  }) => (
    <div data-testid={testId} role="button" tabIndex={0} onClick={onClick}>
      {children}
    </div>
  ),
  DropdownMenuSubContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
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

let mockIsTauri = false
jest.mock("@/lib/tauri", () => ({ isTauri: () => mockIsTauri }))

const mockInvoke = jest.fn(async (..._args: unknown[]): Promise<unknown> => [])
jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

let mockHost: {
  platform: string
  defaultShell: string
  availableShells: { path: string; kind: string }[]
} | null = null
jest.mock("@/hooks/terminal/use-host-capabilities", () => ({
  useHostCapabilities: () => mockHost,
}))

import { TerminalShellPicker, type DetectShells } from "./terminal-shell-picker"

beforeEach(() => {
  cleanup()
  mockIsTauri = false
  mockHost = null
  mockInvoke.mockClear()
  mockInvoke.mockResolvedValue([])
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

  it("lists saved SSH hosts and connects the chosen one", async () => {
    const onNewSshHost = jest.fn()
    await renderPicker(
      <TerminalShellPicker
        onNew={jest.fn()}
        platform="macos"
        detectShells={noDetect}
        onNewSshHost={onNewSshHost}
        sshHosts={[
          {
            id: "ssh-1",
            name: "Production",
            host: "prod.example.com",
            port: 22,
            username: "deploy",
            authMethod: "password",
          },
          // Half-filled draft rows from the settings editor never reach the
          // menu — connecting would only surface a validation error.
          {
            id: "ssh-2",
            name: "Draft",
            host: "",
            port: 22,
            username: "deploy",
            authMethod: "password",
          },
        ]}
      />
    )
    expect(screen.queryByText("Draft")).toBeNull()
    fireEvent.click(screen.getByTestId("terminal-shell-picker-ssh-ssh-1"))
    expect(onNewSshHost).toHaveBeenCalledWith("ssh-1")
  })

  it("lists serial ports and opens the clicked one at the default baud", async () => {
    const onNewSerialPort = jest.fn()
    await renderPicker(
      <TerminalShellPicker
        onNew={jest.fn()}
        platform="macos"
        detectShells={noDetect}
        onNewSerialPort={onNewSerialPort}
        listSerialPorts={async () => [
          { path: "/dev/cu.usbserial-1420", product: "CH340" },
          { path: "/dev/cu.Bluetooth-Incoming-Port", product: null },
        ]}
      />
    )
    // Product name and path together: a machine with two identical adapters
    // has two identical product names, and the path is what tells them apart.
    expect(screen.getByText("CH340 — /dev/cu.usbserial-1420")).toBeTruthy()
    expect(screen.getByText("/dev/cu.Bluetooth-Incoming-Port")).toBeTruthy()
    fireEvent.click(screen.getByTestId("terminal-shell-picker-serial-/dev/cu.usbserial-1420"))
    expect(onNewSerialPort).toHaveBeenCalledWith("/dev/cu.usbserial-1420", 115200)
  })

  /**
   * A device at the wrong baud produces garbage rather than an error, which
   * reads as a broken adapter. The rate has to be choosable.
   */
  it("offers every baud rate for a port", async () => {
    const onNewSerialPort = jest.fn()
    await renderPicker(
      <TerminalShellPicker
        onNew={jest.fn()}
        platform="macos"
        detectShells={noDetect}
        onNewSerialPort={onNewSerialPort}
        listSerialPorts={async () => [{ path: "/dev/ttyUSB0", product: null }]}
      />
    )
    for (const baud of [9600, 115200, 921600]) {
      expect(screen.getByTestId(`terminal-shell-picker-serial-/dev/ttyUSB0-${baud}`)).toBeTruthy()
    }
    fireEvent.click(screen.getByTestId("terminal-shell-picker-serial-/dev/ttyUSB0-9600"))
    expect(onNewSerialPort).toHaveBeenCalledWith("/dev/ttyUSB0", 9600)
  })

  it("lists tmux sessions and attaches the chosen one", async () => {
    const onAttachTmuxSession = jest.fn()
    await renderPicker(
      <TerminalShellPicker
        onNew={jest.fn()}
        platform="macos"
        detectShells={noDetect}
        onAttachTmuxSession={onAttachTmuxSession}
        listTmuxSessions={async () => [{ name: "work", windowCount: 3 }]}
      />
    )
    fireEvent.click(screen.getByTestId("terminal-shell-picker-tmux-work"))
    expect(onAttachTmuxSession).toHaveBeenCalledWith("work")
  })

  /**
   * No handler means this shell cannot do it, so the scan must not even run.
   * A dropdown that enumerates the OS device tree on a phone is pure cost.
   */
  it("skips both scans when no handler is wired", async () => {
    const listSerialPorts = jest.fn().mockResolvedValue([])
    const listTmuxSessions = jest.fn().mockResolvedValue([])
    await renderPicker(
      <TerminalShellPicker
        onNew={jest.fn()}
        platform="macos"
        detectShells={noDetect}
        listSerialPorts={listSerialPorts}
        listTmuxSessions={listTmuxSessions}
      />
    )
    expect(listSerialPorts).not.toHaveBeenCalled()
    expect(listTmuxSessions).not.toHaveBeenCalled()
    expect(screen.queryByText("terminal.shellPicker.serialLabel")).toBeNull()
    expect(screen.queryByText("terminal.shellPicker.tmuxLabel")).toBeNull()
  })

  /**
   * A host with no tmux server and no serial adapter is the common case. It
   * must render no section rather than an error row.
   */
  it("shows no section when a scan throws", async () => {
    await renderPicker(
      <TerminalShellPicker
        onNew={jest.fn()}
        platform="macos"
        detectShells={noDetect}
        onNewSerialPort={jest.fn()}
        onAttachTmuxSession={jest.fn()}
        listSerialPorts={async () => {
          throw new Error("no permission to enumerate")
        }}
        listTmuxSessions={async () => {
          throw new Error("no server running")
        }}
      />
    )
    expect(screen.queryByText("terminal.shellPicker.serialLabel")).toBeNull()
    expect(screen.queryByText("terminal.shellPicker.tmuxLabel")).toBeNull()
  })

  it("omits the SSH group when no hosts are supplied", async () => {
    await renderPicker(
      <TerminalShellPicker onNew={jest.fn()} platform="macos" detectShells={noDetect} />
    )
    expect(screen.queryByText("terminal.shellPicker.sshLabel")).toBeNull()
  })

  describe("default PATH detection", () => {
    it("returns nothing off-desktop so the full platform list survives", async () => {
      // No `detectShells` prop — exercises the module's own default.
      await renderPicker(<TerminalShellPicker onNew={jest.fn()} platform="macos" />)
      expect(mockInvoke).not.toHaveBeenCalled()
      expect(screen.getByTestId("terminal-shell-picker-shell-zsh")).toBeInTheDocument()
      expect(screen.getByTestId("terminal-shell-picker-shell-nu")).toBeInTheDocument()
    })

    it("narrows to the binaries the Rust PATH scan resolves", async () => {
      mockIsTauri = true
      mockInvoke.mockImplementation(async (_cmd, args) => {
        const prefix = (args as { prefix: string }).prefix
        // Only zsh and bash are installed; `.exe` stems are matched loosely so
        // `cmd.exe` would satisfy a `cmd` probe on Windows.
        return prefix === "zsh" ? ["zsh"] : prefix === "bash" ? ["BASH.exe"] : []
      })
      await renderPicker(<TerminalShellPicker onNew={jest.fn()} platform="macos" />)

      expect(mockInvoke).toHaveBeenCalledWith("terminal_list_path_executables", {
        prefix: "zsh",
        limit: 8,
      })
      expect(screen.getByTestId("terminal-shell-picker-shell-zsh")).toBeInTheDocument()
      expect(screen.getByTestId("terminal-shell-picker-shell-bash")).toBeInTheDocument()
      expect(screen.queryByTestId("terminal-shell-picker-shell-nu")).toBeNull()
    })

    it("leaves a shell undetected when its probe throws", async () => {
      mockIsTauri = true
      mockInvoke.mockImplementation(async (_cmd, args) => {
        const prefix = (args as { prefix: string }).prefix
        if (prefix === "zsh") return ["zsh"]
        throw new Error("scan unavailable")
      })
      await renderPicker(<TerminalShellPicker onNew={jest.fn()} platform="macos" />)

      expect(screen.getByTestId("terminal-shell-picker-shell-zsh")).toBeInTheDocument()
      expect(screen.queryByTestId("terminal-shell-picker-shell-nu")).toBeNull()
    })
  })

  it("omits the SSH group when hosts exist but no connect handler is wired", async () => {
    // The dock withholds `onNewSshHost` nowhere today, but a caller that
    // supplies hosts without a handler must not render dead menu rows.
    await renderPicker(
      <TerminalShellPicker
        onNew={jest.fn()}
        platform="macos"
        detectShells={noDetect}
        sshHosts={[
          {
            id: "ssh-1",
            name: "Production",
            host: "prod.example.com",
            port: 22,
            username: "deploy",
            authMethod: "agent",
          },
        ]}
      />
    )
    expect(screen.queryByTestId("terminal-shell-picker-ssh-ssh-1")).toBeNull()
  })
})

/**
 * Against a remote host the platform sniff and the PATH scan both describe the
 * WRONG machine — the scan is a Tauri command running on the client. The host
 * reports what it actually has instead, already filtered.
 */
describe("against a remote host", () => {
  it("offers the host's shells rather than the client platform's", async () => {
    mockHost = {
      platform: "linux",
      defaultShell: "/bin/ash",
      availableShells: [
        { path: "/bin/ash", kind: "sh" },
        { path: "/bin/bash", kind: "bash" },
      ],
    }
    const onNew = jest.fn()
    await renderPicker(<TerminalShellPicker onNew={onNew} detectShells={noDetect} />)

    expect(screen.getByTestId("terminal-shell-picker-shell-sh")).toBeInTheDocument()
    expect(screen.getByTestId("terminal-shell-picker-shell-bash")).toBeInTheDocument()
    expect(screen.queryByTestId("terminal-shell-picker-shell-zsh")).not.toBeInTheDocument()
  })

  it("spawns the host's own path, not a client-shaped one", async () => {
    mockHost = {
      platform: "linux",
      defaultShell: "/bin/ash",
      availableShells: [{ path: "/bin/ash", kind: "sh" }],
    }
    const onNew = jest.fn()
    await renderPicker(<TerminalShellPicker onNew={onNew} detectShells={noDetect} />)
    fireEvent.click(screen.getByTestId("terminal-shell-picker-shell-sh"))
    expect(onNew).toHaveBeenCalledWith("/bin/ash")
  })

  it("does not run the PATH scan, which would probe the client", async () => {
    mockHost = {
      platform: "linux",
      defaultShell: "/bin/bash",
      availableShells: [{ path: "/bin/bash", kind: "bash" }],
    }
    const detect = jest.fn(async () => new Set<string>())
    await renderPicker(<TerminalShellPicker onNew={jest.fn()} detectShells={detect} />)
    expect(detect).not.toHaveBeenCalled()
  })

  // A hand-built shell or a Nix store path has no translated name; hiding it
  // would drop a shell the host actually has.
  it("still offers a shell it cannot name, labelled by path", async () => {
    mockHost = {
      platform: "linux",
      defaultShell: "/nix/store/abc/bin/xonsh",
      availableShells: [{ path: "/nix/store/abc/bin/xonsh", kind: "unknown" }],
    }
    const onNew = jest.fn()
    await renderPicker(<TerminalShellPicker onNew={onNew} detectShells={noDetect} />)
    const row = screen.getByTestId("terminal-shell-picker-shell-/nix/store/abc/bin/xonsh")
    expect(row).toHaveTextContent("/nix/store/abc/bin/xonsh")
    fireEvent.click(row)
    expect(onNew).toHaveBeenCalledWith("/nix/store/abc/bin/xonsh")
  })
})
