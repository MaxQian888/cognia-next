/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, cleanup, act } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const mockIsTauri = jest.fn(() => false)
const mockSyncTerminalHostProfiles = jest.fn(async (..._args: unknown[]) => undefined)
jest.mock("@/lib/tauri", () => ({ isTauri: () => mockIsTauri() }))
jest.mock("@/lib/terminal/host-profiles", () => ({
  syncTerminalHostProfiles: (...args: unknown[]) => mockSyncTerminalHostProfiles(...args),
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
  mockIsTauri.mockReturnValue(false)
  mockSyncTerminalHostProfiles.mockClear()
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

  it("synchronizes complete profile identifiers and policies to the desktop host", async () => {
    jest.useFakeTimers()
    mockIsTauri.mockReturnValue(true)
    settingsState = {
      terminal: {
        profiles: [{ id: "profile-1", name: "PS", shell: "pwsh.exe" }],
        sandboxed: true,
      },
    }
    render(<TerminalProfiles />)
    fireEvent.change(screen.getByTestId("terminal-profile-shell-profile-1"), {
      target: { value: "pwsh" },
    })
    await act(async () => jest.advanceTimersByTime(200))
    expect(mockSyncTerminalHostProfiles).toHaveBeenCalledWith(
      [expect.objectContaining({ id: "profile-1", shell: "pwsh" })],
      expect.objectContaining({ sandboxed: true })
    )
    jest.useRealTimers()
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

  it("edits args as one-per-line text and persists the parsed array", async () => {
    settingsState = { terminal: { profiles: [{ id: "profile-1", name: "PS", shell: "pwsh.exe" }] } }
    render(<TerminalProfiles />)
    const args = screen.getByTestId("terminal-profile-args-profile-1") as HTMLTextAreaElement
    await act(async () => {
      fireEvent.change(args, { target: { value: "-NoLogo\n-NoProfile" } })
    })
    expect(settingsSave).toHaveBeenLastCalledWith({
      terminal: expect.objectContaining({
        profiles: [expect.objectContaining({ args: ["-NoLogo", "-NoProfile"] })],
      }),
    })
    // Clearing the textarea drops the field entirely (no empty array stored).
    await act(async () => {
      fireEvent.change(args, { target: { value: "" } })
    })
    expect(settingsSave).toHaveBeenLastCalledWith({
      terminal: expect.objectContaining({
        profiles: [expect.objectContaining({ args: undefined })],
      }),
    })
  })

  it("edits env as KEY=VALUE lines, keeping the half-typed draft text visible", async () => {
    settingsState = { terminal: { profiles: [{ id: "profile-1", name: "PS", shell: "pwsh.exe" }] } }
    render(<TerminalProfiles />)
    const env = screen.getByTestId("terminal-profile-env-profile-1") as HTMLTextAreaElement
    // A half-typed line parses to nothing but must stay visible while typing.
    await act(async () => {
      fireEvent.change(env, { target: { value: "NODE_ENV" } })
    })
    expect(env.value).toBe("NODE_ENV")
    expect(settingsSave).toHaveBeenLastCalledWith({
      terminal: expect.objectContaining({
        profiles: [expect.objectContaining({ env: undefined })],
      }),
    })
    await act(async () => {
      fireEvent.change(env, { target: { value: "NODE_ENV=development\nFOO=1" } })
    })
    expect(settingsSave).toHaveBeenLastCalledWith({
      terminal: expect.objectContaining({
        profiles: [expect.objectContaining({ env: { NODE_ENV: "development", FOO: "1" } })],
      }),
    })
    // Blur clears the draft; the textarea then reflects the persisted record.
    await act(async () => {
      fireEvent.blur(env)
    })
    expect(env.value).toBe("NODE_ENV=development\nFOO=1")
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
