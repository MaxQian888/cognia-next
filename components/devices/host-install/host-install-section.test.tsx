/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { DeviceRow } from "@/lib/devices/types"
import type { SshHostProfile } from "@/lib/terminal/ssh-profiles"
import { useSettingsStore } from "@/stores/settings"

import { HostInstallSection } from "./host-install-section"

jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
  useFormatter: () => ({ dateTime: (value: number) => `date:${value}` }),
}))
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}))
jest.mock("./host-install-sheet", () => ({
  hostInstallerUnavailable: () => null,
  HostInstallSheet: ({ open, profileId }: { open: boolean; profileId: string }) =>
    open ? <div data-testid="sheet" data-profile={profileId} /> : null,
}))

const box: SshHostProfile = {
  id: "ssh-1",
  name: "Build box",
  host: "box.example.com",
  port: 22,
  username: "max",
  authMethod: "agent",
}

const row = {
  ref: "host:host-1",
  kind: "remote-host",
  label: "Build box",
  hostId: "host-1",
  installBinding: { kind: "ssh", profileId: "ssh-1", installedAt: 1_700_000_000_000 },
} as unknown as DeviceRow

const initial = useSettingsStore.getState()
function seedProfiles(sshHosts: SshHostProfile[]) {
  useSettingsStore.setState({
    settings: { ...(initial.settings ?? {}), terminal: { sshHosts } } as never,
  })
}

beforeEach(() => seedProfiles([box]))
afterAll(() => useSettingsStore.setState(initial, true))

describe("HostInstallSection", () => {
  it("says which profile and when, and opens the installer for that machine", async () => {
    render(<HostInstallSection row={row} unavailable={null} />)
    const section = screen.getByTestId("host-install-section")
    expect(section).toHaveTextContent("Build box")
    expect(section).toHaveTextContent("date:1700000000000")
    await userEvent.click(screen.getByTestId("host-install-manage"))
    expect(screen.getByTestId("sheet").dataset.profile).toBe("ssh-1")
  })

  it("points at SSH settings when the profile was removed", () => {
    seedProfiles([])
    render(<HostInstallSection row={row} unavailable={null} />)
    expect(screen.getByTestId("host-install-section")).toHaveTextContent("section.profileGone")
    expect(screen.getByTestId("host-install-section-profile-missing")).toBeInTheDocument()
    expect(screen.queryByTestId("host-install-manage")).toBeNull()
  })

  it("labels the dormant installer instead of hiding the section", () => {
    render(<HostInstallSection row={row} unavailable="notInBuild" />)
    expect(screen.getByTestId("host-install-unavailable")).toHaveTextContent("entry.notInBuild")
    expect(screen.queryByTestId("host-install-manage")).toBeNull()
  })

  it("renders nothing for a Host this desktop did not install", () => {
    const { container } = render(
      <HostInstallSection row={{ ...row, installBinding: undefined }} unavailable={null} />
    )
    expect(container).toBeEmptyDOMElement()
  })
})
