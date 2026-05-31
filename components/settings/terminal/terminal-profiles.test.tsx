/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, cleanup, act } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const settingsSave = jest.fn(async (..._args: unknown[]) => undefined)
let settingsState: { terminal?: Record<string, unknown> } = {}

jest.mock("@/stores/settings", () => ({
  useSettingsStore: Object.assign(
    (selector: (s: unknown) => unknown) =>
      selector({
        settings: settingsState,
        save: (patch: { terminal?: Record<string, unknown> }) => {
          settingsState = { ...settingsState, ...patch }
          return settingsSave(patch)
        },
      }),
    { getState: () => ({ settings: settingsState, save: settingsSave }) }
  ),
}))

import { TerminalProfiles } from "./terminal-profiles"

beforeEach(() => {
  cleanup()
  settingsSave.mockClear()
  settingsState = {}
})

describe("TerminalProfiles", () => {
  it("shows the empty state and an add button when there are no profiles", () => {
    render(<TerminalProfiles />)
    expect(screen.getByText("settings.terminal.profiles.empty")).toBeInTheDocument()
    expect(screen.getByTestId("terminal-profiles-add")).toBeInTheDocument()
  })

  it("adds a profile with a generated id", async () => {
    render(<TerminalProfiles />)
    await act(async () => {
      fireEvent.click(screen.getByTestId("terminal-profiles-add"))
    })
    expect(settingsSave).toHaveBeenLastCalledWith({
      terminal: expect.objectContaining({
        profiles: [expect.objectContaining({ id: "profile-1", shell: "" })],
      }),
    })
  })

  it("edits a profile's shell field", async () => {
    settingsState = { terminal: { profiles: [{ id: "profile-1", name: "PS", shell: "" }] } }
    render(<TerminalProfiles />)
    const shell = screen.getByTestId("terminal-profile-shell-profile-1") as HTMLInputElement
    await act(async () => {
      fireEvent.change(shell, { target: { value: "pwsh.exe" } })
    })
    expect(settingsSave).toHaveBeenLastCalledWith({
      terminal: expect.objectContaining({
        profiles: [expect.objectContaining({ id: "profile-1", shell: "pwsh.exe" })],
      }),
    })
  })

  it("sets and toggles the default profile", async () => {
    settingsState = { terminal: { profiles: [{ id: "profile-1", name: "PS", shell: "pwsh.exe" }] } }
    render(<TerminalProfiles />)
    await act(async () => {
      fireEvent.click(screen.getByTestId("terminal-profile-default-profile-1"))
    })
    expect(settingsSave).toHaveBeenLastCalledWith({
      terminal: expect.objectContaining({ defaultProfileId: "profile-1" }),
    })
  })

  it("removes a profile and clears the default pointer if it matched", async () => {
    settingsState = {
      terminal: {
        profiles: [{ id: "profile-1", name: "PS", shell: "pwsh.exe" }],
        defaultProfileId: "profile-1",
      },
    }
    render(<TerminalProfiles />)
    await act(async () => {
      fireEvent.click(screen.getByTestId("terminal-profile-remove-profile-1"))
    })
    expect(settingsSave).toHaveBeenLastCalledWith({
      terminal: expect.objectContaining({ profiles: [], defaultProfileId: undefined }),
    })
  })
})
