import { fireEvent, render, screen } from "@testing-library/react"

import { TerminalSection } from "./terminal-section"

const replace = jest.fn()
let params = new URLSearchParams()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => params,
}))
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vals?: Record<string, unknown>) =>
    vals ? `${key}:${JSON.stringify(vals)}` : key,
}))
let sshHosts: unknown[] | undefined
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) =>
    selector({ settings: { terminal: { sshHosts } } }),
}))
jest.mock("@/components/settings/common/settings-master-detail", () => ({
  SETTINGS_DETAIL_PANE_CLASS: "",
  SettingsMasterDetail: ({
    nav,
    children,
  }: {
    nav: (slot: "rail" | "sheet") => React.ReactNode
    children: React.ReactNode
  }) => (
    <div>
      {nav("rail")}
      {children}
    </div>
  ),
}))
jest.mock("@/components/settings/common/panel-transition", () => ({
  PanelTransition: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
jest.mock("./components/terminal-nav", () => ({
  TerminalNav: ({
    onSelect,
    badges,
  }: {
    onSelect: (id: string) => void
    badges?: Record<string, { text: string; ariaLabel: string }>
  }) => (
    <div>
      <button type="button" onClick={() => onSelect("host")}>
        nav-host
      </button>
      <span data-testid="ssh-badge">{badges?.ssh ? badges.ssh.ariaLabel : "none"}</span>
    </div>
  ),
}))
jest.mock("./terminal-card", () => ({
  TerminalCard: ({ panel }: { panel?: string }) => (
    <div data-testid="terminal-card" data-panel={panel ?? "all"} />
  ),
}))
jest.mock("./terminal-profiles", () => ({
  TerminalProfiles: () => <div data-testid="terminal-profiles" />,
}))
jest.mock("./ssh-hosts", () => ({ SshHosts: () => <div data-testid="ssh-hosts" /> }))
jest.mock("./terminal-project-override", () => ({
  TerminalProjectOverride: () => <div data-testid="terminal-project-override" />,
}))

describe("TerminalSection", () => {
  beforeEach(() => {
    replace.mockReset()
    params = new URLSearchParams()
    sshHosts = undefined
  })

  it("opens on Appearance, one group of the card at a time", () => {
    render(<TerminalSection />)
    expect(screen.getByTestId("terminal-card")).toHaveAttribute("data-panel", "appearance")
    expect(screen.getByTestId("terminal-panel-body")).toHaveAttribute("data-panel", "appearance")
  })

  it("lands a deep link on the SSH hosts editor itself", () => {
    params = new URLSearchParams("section=terminal&terminalPanel=ssh&sshHost=ssh-2")
    render(<TerminalSection />)
    expect(screen.getByTestId("ssh-hosts")).toBeInTheDocument()
    expect(screen.queryByTestId("terminal-card")).toBeNull()
  })

  it.each([
    ["profiles", "terminal-profiles"],
    ["project", "terminal-project-override"],
  ])("gives the %s editor its own panel", (panel, testId) => {
    params = new URLSearchParams(`terminalPanel=${panel}`)
    render(<TerminalSection />)
    expect(screen.getByTestId(testId)).toBeInTheDocument()
  })

  it("falls back to Appearance for an unknown panel", () => {
    params = new URLSearchParams("terminalPanel=fonts")
    render(<TerminalSection />)
    expect(screen.getByTestId("terminal-card")).toHaveAttribute("data-panel", "appearance")
  })

  it("writes the chosen panel to the URL and drops a host that belongs to SSH", () => {
    params = new URLSearchParams("section=terminal&terminalPanel=ssh&sshHost=ssh-2")
    render(<TerminalSection />)
    fireEvent.click(screen.getByText("nav-host"))
    expect(replace).toHaveBeenCalledWith("?section=terminal&terminalPanel=host", {
      scroll: false,
    })
  })

  it("counts saved SSH hosts on the rail", () => {
    sshHosts = [{ id: "a" }, { id: "b" }]
    render(<TerminalSection />)
    expect(screen.getByTestId("ssh-badge")).toHaveTextContent('nav.sshCountAria:{"count":2}')
  })

  it("shows no badge when nothing is saved", () => {
    render(<TerminalSection />)
    expect(screen.getByTestId("ssh-badge")).toHaveTextContent("none")
  })
})
