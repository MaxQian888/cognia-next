/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, cleanup, act } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const settingsSave = jest.fn(async () => undefined)
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
    {
      getState: () => ({
        settings: settingsState,
        save: settingsSave,
      }),
    }
  ),
}))

jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: Object.assign(
    (selector: (s: unknown) => unknown) =>
      selector({
        projects: [],
        updateProject: jest.fn(),
      }),
    { getState: () => ({ projects: [], updateProject: jest.fn() }) }
  ),
}))

import { TerminalCard } from "./terminal-card"

beforeEach(() => {
  cleanup()
  settingsSave.mockClear()
  settingsState = {}
})

describe("TerminalCard", () => {
  it("renders the shell selector with auto as the default", () => {
    render(<TerminalCard />)
    expect(screen.getByText("settings.terminal.shell.label")).toBeInTheDocument()
  })

  it("calls save({ terminal: { ... }}) when font size changes", async () => {
    render(<TerminalCard />)
    const fontInput = screen.getByTestId("terminal-card-font-size") as HTMLInputElement
    await act(async () => {
      fireEvent.change(fontInput, { target: { value: "15" } })
    })
    expect(settingsSave).toHaveBeenCalledWith({
      terminal: expect.objectContaining({ fontSize: 15 }),
    })
  })

  it("clamps fontSize between 8 and 32", async () => {
    render(<TerminalCard />)
    const fontInput = screen.getByTestId("terminal-card-font-size") as HTMLInputElement
    await act(async () => {
      fireEvent.change(fontInput, { target: { value: "200" } })
    })
    expect(settingsSave).toHaveBeenLastCalledWith({
      terminal: expect.objectContaining({ fontSize: 32 }),
    })
  })

  it("clamps scrollback between 1000 and 100000", async () => {
    render(<TerminalCard />)
    const scrollback = screen.getByTestId("terminal-card-scrollback") as HTMLInputElement
    await act(async () => {
      fireEvent.change(scrollback, { target: { value: "10" } })
    })
    expect(settingsSave).toHaveBeenLastCalledWith({
      terminal: expect.objectContaining({ scrollback: 1000 }),
    })
  })

  it("persists fontFamily updates", async () => {
    render(<TerminalCard />)
    const fontFamilyInput = screen.getByPlaceholderText('"JetBrains Mono", monospace')
    await act(async () => {
      fireEvent.change(fontFamilyInput, { target: { value: "Cascadia Code, monospace" } })
    })
    expect(settingsSave).toHaveBeenLastCalledWith({
      terminal: expect.objectContaining({ fontFamily: "Cascadia Code, monospace" }),
    })
  })

  it("toggles enableShellIntegration via the switch", async () => {
    render(<TerminalCard />)
    const toggle = screen.getByRole("switch", {
      name: /settings.terminal.shellIntegration.label/i,
    })
    await act(async () => {
      fireEvent.click(toggle)
    })
    expect(settingsSave).toHaveBeenLastCalledWith({
      terminal: expect.objectContaining({ enableShellIntegration: false }),
    })
  })
})
