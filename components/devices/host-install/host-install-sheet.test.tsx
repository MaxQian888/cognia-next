/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { SshHostProfile } from "@/lib/terminal/ssh-profiles"
import { useSettingsStore } from "@/stores/settings"

import {
  HostInstallSheet,
  SshHostInstallEntry,
  hostInstallerUnavailable,
} from "./host-install-sheet"

jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string, values?: Record<string, unknown>) =>
    values ? `${ns}.${key}:${JSON.stringify(values)}` : `${ns}.${key}`,
}))
jest.mock("@/hooks/ui/use-mobile", () => ({ useIsMobile: () => false }))
// The flow has its own suite; here only which profile reaches it matters.
jest.mock("./host-install-flow", () => ({
  HostInstallFlow: ({
    profile,
    profiles,
    onClose,
  }: {
    profile: SshHostProfile
    profiles: readonly SshHostProfile[]
    onClose: () => void
  }) => (
    <div data-testid="flow" data-profile={profile.id} data-count={profiles.length}>
      <button type="button" onClick={onClose}>
        close-flow
      </button>
    </div>
  ),
}))

const box: SshHostProfile = {
  id: "ssh-1",
  name: "Build box",
  host: "box.example.com",
  port: 22,
  username: "max",
  authMethod: "agent",
  jumpHostId: "ssh-2",
}
const bastion: SshHostProfile = { ...box, id: "ssh-2", name: "Bastion", jumpHostId: undefined }

const initial = useSettingsStore.getState()

function seedProfiles(sshHosts: SshHostProfile[]) {
  useSettingsStore.setState({
    settings: { ...(initial.settings ?? {}), terminal: { sshHosts } } as never,
  })
}

beforeEach(() => seedProfiles([box, bastion]))
afterAll(() => useSettingsStore.setState(initial, true))

describe("hostInstallerUnavailable", () => {
  it("names the build flag first, then the shell", () => {
    expect(hostInstallerUnavailable(false, true)).toBe("notInBuild")
    expect(hostInstallerUnavailable(false, false)).toBe("notInBuild")
    expect(hostInstallerUnavailable(true, false)).toBe("desktopOnly")
    expect(hostInstallerUnavailable(true, true)).toBeNull()
  })
})

describe("SshHostInstallEntry", () => {
  /** The dormant build says so in place of the action (ADR-0235 P5 flag). */
  it("says the installer is not in this build when the flag is off", () => {
    render(<SshHostInstallEntry profileId="ssh-1" unavailable="notInBuild" />)
    const note = screen.getByTestId("host-install-unavailable")
    expect(note).toHaveTextContent("devices.hostInstall.entry.notInBuild")
    expect(screen.queryByTestId("host-install-open")).toBeNull()
  })

  it("says why it is desktop-only off the desktop", () => {
    render(<SshHostInstallEntry profileId="ssh-1" unavailable="desktopOnly" />)
    expect(screen.getByTestId("host-install-unavailable")).toHaveTextContent("entry.desktopOnly")
  })

  it("opens the sheet with the profile and its whole saved set", async () => {
    render(<SshHostInstallEntry profileId="ssh-1" unavailable={null} />)
    expect(screen.queryByTestId("flow")).toBeNull()
    await userEvent.click(screen.getByTestId("host-install-open"))
    const flow = await screen.findByTestId("flow")
    expect(flow.dataset.profile).toBe("ssh-1")
    expect(flow.dataset.count).toBe("2")
    expect(
      screen.getByText('devices.hostInstall.description:{"name":"Build box"}')
    ).toBeInTheDocument()

    // Closing unmounts the flow, which is what closes the native session.
    await userEvent.click(screen.getByText("close-flow"))
    expect(screen.queryByTestId("flow")).toBeNull()
  })
})

describe("HostInstallSheet", () => {
  it("says the profile is gone instead of dialling anything", () => {
    seedProfiles([bastion])
    render(<HostInstallSheet open onOpenChange={() => undefined} profileId="ssh-1" />)
    expect(screen.getByTestId("host-install-profile-missing")).toBeInTheDocument()
    expect(screen.queryByTestId("flow")).toBeNull()
  })
})
