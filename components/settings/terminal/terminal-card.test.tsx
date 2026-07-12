/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, cleanup, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

// Radix Select needs these pointer/scroll APIs jsdom doesn't ship.
beforeAll(() => {
  Element.prototype.scrollIntoView = jest.fn()
  Element.prototype.hasPointerCapture = jest.fn(() => false)
  Element.prototype.setPointerCapture = jest.fn()
  Element.prototype.releasePointerCapture = jest.fn()
})

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

  it("mounts the detected-fonts picker alongside the custom font input", () => {
    render(<TerminalCard />)
    // The picker's label (resolved via the mocked translator to the key)
    // proves the FontFamilyPicker is wired with the terminal namespace…
    expect(screen.getByText("pickerLabel")).toBeInTheDocument()
    // …and the free-text input for custom stacks is still present.
    expect(screen.getByPlaceholderText('"JetBrains Mono", monospace')).toBeInTheDocument()
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

  it("applies the recommended Nerd Font stack", async () => {
    render(<TerminalCard />)
    const button = screen.getByTestId("terminal-card-use-nerd-font")
    await act(async () => {
      fireEvent.click(button)
    })
    expect(settingsSave).toHaveBeenLastCalledWith({
      terminal: expect.objectContaining({
        fontFamily: expect.stringContaining("Nerd Font"),
      }),
    })
  })

  it("toggles font ligatures", async () => {
    render(<TerminalCard />)
    const toggle = screen.getByTestId("terminal-card-ligatures")
    await act(async () => {
      fireEvent.click(toggle)
    })
    expect(settingsSave).toHaveBeenLastCalledWith({
      terminal: expect.objectContaining({ fontLigatures: true }),
    })
  })

  it("turns force-UTF-8 off (defaults on)", async () => {
    render(<TerminalCard />)
    const toggle = screen.getByTestId("terminal-card-force-utf8")
    // Defaults to checked → clicking turns it off.
    await act(async () => {
      fireEvent.click(toggle)
    })
    expect(settingsSave).toHaveBeenLastCalledWith({
      terminal: expect.objectContaining({ forceUtf8: false }),
    })
  })

  it("turns the sandboxed terminal on (defaults off, ADR-0028 P4.1)", async () => {
    render(<TerminalCard />)
    const toggle = screen.getByTestId("terminal-card-sandboxed")
    // Defaults to unchecked → clicking turns it on.
    await act(async () => {
      fireEvent.click(toggle)
    })
    expect(settingsSave).toHaveBeenLastCalledWith({
      terminal: expect.objectContaining({ sandboxed: true }),
    })
  })

  it("toggles cursor blink off (defaults on)", async () => {
    render(<TerminalCard />)
    const toggle = screen.getByTestId("terminal-card-cursor-blink")
    await act(async () => {
      fireEvent.click(toggle)
    })
    expect(settingsSave).toHaveBeenLastCalledWith({
      terminal: expect.objectContaining({ cursorBlink: false }),
    })
  })

  it.each([
    ["terminal-card-quick-fixes", "quickFixes"],
    ["terminal-card-command-actions", "commandActions"],
    ["terminal-card-sticky-scroll", "stickyScroll"],
  ] as const)("turns %s off (VS Code parity feature, defaults on)", async (testId, key) => {
    render(<TerminalCard />)
    const toggle = screen.getByTestId(testId)
    await act(async () => {
      fireEvent.click(toggle)
    })
    expect(settingsSave).toHaveBeenLastCalledWith({
      terminal: expect.objectContaining({ [key]: false }),
    })
  })

  it("renders the color-scheme and renderer selectors", () => {
    render(<TerminalCard />)
    expect(screen.getByTestId("terminal-card-color-scheme")).toBeInTheDocument()
    expect(screen.getByTestId("terminal-card-renderer")).toBeInTheDocument()
  })

  it("renders the font-weight, bold-weight and minimum-contrast selectors", () => {
    render(<TerminalCard />)
    expect(screen.getByTestId("terminal-card-font-weight")).toBeInTheDocument()
    expect(screen.getByTestId("terminal-card-font-weight-bold")).toBeInTheDocument()
    expect(screen.getByTestId("terminal-card-min-contrast")).toBeInTheDocument()
  })

  it("clamps line height between 0.8 and 2", async () => {
    render(<TerminalCard />)
    const input = screen.getByTestId("terminal-card-line-height") as HTMLInputElement
    await act(async () => {
      fireEvent.change(input, { target: { value: "5" } })
    })
    expect(settingsSave).toHaveBeenLastCalledWith({
      terminal: expect.objectContaining({ lineHeight: 2 }),
    })
  })

  it("persists letter spacing updates", async () => {
    render(<TerminalCard />)
    const input = screen.getByTestId("terminal-card-letter-spacing") as HTMLInputElement
    await act(async () => {
      fireEvent.change(input, { target: { value: "1.5" } })
    })
    expect(settingsSave).toHaveBeenLastCalledWith({
      terminal: expect.objectContaining({ letterSpacing: 1.5 }),
    })
  })

  it("clamps scroll sensitivity between 1 and 10", async () => {
    render(<TerminalCard />)
    const input = screen.getByTestId("terminal-card-scroll-sensitivity") as HTMLInputElement
    await act(async () => {
      fireEvent.change(input, { target: { value: "99" } })
    })
    expect(settingsSave).toHaveBeenLastCalledWith({
      terminal: expect.objectContaining({ scrollSensitivity: 10 }),
    })
  })

  it("turns confirm-on-close off (defaults on)", async () => {
    render(<TerminalCard />)
    const toggle = screen.getByTestId("terminal-card-confirm-on-close")
    await act(async () => {
      fireEvent.click(toggle)
    })
    expect(settingsSave).toHaveBeenLastCalledWith({
      terminal: expect.objectContaining({ confirmOnClose: false }),
    })
  })

  it("renders the bell selector and persists a picked style", async () => {
    const user = userEvent.setup()
    render(<TerminalCard />)
    const trigger = screen.getByTestId("terminal-card-bell")
    await user.click(trigger)
    await user.click(await screen.findByText("settings.terminal.bell.visual"))
    expect(settingsSave).toHaveBeenLastCalledWith({
      terminal: expect.objectContaining({ bell: "visual" }),
    })
  })

  it("groups color schemes by appearance with palette swatches", async () => {
    const user = userEvent.setup()
    render(<TerminalCard />)
    await user.click(screen.getByTestId("terminal-card-color-scheme"))
    // Group labels for dark/light palettes…
    expect(await screen.findByText("settings.terminal.colorScheme.darkGroup")).toBeInTheDocument()
    expect(screen.getByText("settings.terminal.colorScheme.lightGroup")).toBeInTheDocument()
    // …and each named scheme carries its inline palette preview.
    expect(screen.getByTestId("terminal-scheme-swatch-dracula")).toBeInTheDocument()
    expect(screen.getByTestId("terminal-scheme-swatch-solarized-light")).toBeInTheDocument()
    // Picking a scheme persists its id.
    await user.click(screen.getByText("Dracula"))
    expect(settingsSave).toHaveBeenLastCalledWith({
      terminal: expect.objectContaining({ colorScheme: "dracula" }),
    })
  })

  it("groups controls under section headers", () => {
    render(<TerminalCard />)
    expect(screen.getByText("settings.terminal.groups.appearance")).toBeInTheDocument()
    expect(screen.getByText("settings.terminal.groups.behavior")).toBeInTheDocument()
  })

  it("mounts the launch-profiles manager", () => {
    render(<TerminalCard />)
    expect(screen.getByTestId("terminal-profiles")).toBeInTheDocument()
    expect(screen.getByTestId("terminal-profiles-add")).toBeInTheDocument()
  })

  describe("AI autocomplete", () => {
    it("enables AI autocomplete via the switch (default off)", async () => {
      render(<TerminalCard />)
      const toggle = screen.getByTestId("terminal-card-autocomplete-enabled")
      await act(async () => {
        fireEvent.click(toggle)
      })
      expect(settingsSave).toHaveBeenLastCalledWith({
        terminal: expect.objectContaining({
          autocomplete: expect.objectContaining({ enabled: true }),
        }),
      })
    })

    it("hides source + debounce controls until enabled", () => {
      render(<TerminalCard />)
      expect(screen.queryByTestId("terminal-card-autocomplete-source")).toBeNull()
      expect(screen.queryByTestId("terminal-card-autocomplete-debounce")).toBeNull()
    })

    it("shows + clamps the debounce control when enabled", async () => {
      settingsState = {
        terminal: { autocomplete: { enabled: true, source: "both", debounceMs: 350 } },
      }
      render(<TerminalCard />)
      const debounce = screen.getByTestId("terminal-card-autocomplete-debounce") as HTMLInputElement
      await act(async () => {
        fireEvent.change(debounce, { target: { value: "9000" } })
      })
      expect(settingsSave).toHaveBeenLastCalledWith({
        terminal: expect.objectContaining({
          autocomplete: expect.objectContaining({ debounceMs: 2000 }),
        }),
      })
    })

    it.each(["path", "exe", "spec"] as const)(
      "toggles the %s provider off (defaults on)",
      async (key) => {
        settingsState = { terminal: { autocomplete: { enabled: true } } }
        render(<TerminalCard />)
        const toggle = screen.getByTestId(`terminal-card-autocomplete-${key}`)
        await act(async () => {
          fireEvent.click(toggle)
        })
        expect(settingsSave).toHaveBeenLastCalledWith({
          terminal: expect.objectContaining({
            autocomplete: expect.objectContaining({ [key]: false }),
          }),
        })
      }
    )

    it("toggles the candidate popup off (defaults on)", async () => {
      settingsState = { terminal: { autocomplete: { enabled: true } } }
      render(<TerminalCard />)
      const toggle = screen.getByTestId("terminal-card-autocomplete-popup")
      await act(async () => {
        fireEvent.click(toggle)
      })
      expect(settingsSave).toHaveBeenLastCalledWith({
        terminal: expect.objectContaining({
          autocomplete: expect.objectContaining({ popup: false }),
        }),
      })
    })

    it("toggles history persistence off (defaults on)", async () => {
      settingsState = { terminal: { autocomplete: { enabled: true } } }
      render(<TerminalCard />)
      const toggle = screen.getByTestId("terminal-card-autocomplete-persist-history")
      await act(async () => {
        fireEvent.click(toggle)
      })
      expect(settingsSave).toHaveBeenLastCalledWith({
        terminal: expect.objectContaining({
          autocomplete: expect.objectContaining({ persistHistory: false }),
        }),
      })
    })

    it("hides the provider toggles until autocomplete is enabled", () => {
      render(<TerminalCard />)
      expect(screen.queryByTestId("terminal-card-autocomplete-path")).toBeNull()
      expect(screen.queryByTestId("terminal-card-autocomplete-popup")).toBeNull()
    })
  })

  describe("unattended execution", () => {
    it("enables the master switch (default off)", async () => {
      render(<TerminalCard />)
      const toggle = screen.getByTestId("terminal-card-unattended")
      await act(async () => {
        fireEvent.click(toggle)
      })
      expect(settingsSave).toHaveBeenLastCalledWith({
        terminal: expect.objectContaining({ allowUnattendedExecution: true }),
      })
    })

    it("hides the ask-policy select until enabled", () => {
      render(<TerminalCard />)
      expect(screen.queryByTestId("terminal-card-unattended-policy")).toBeNull()
    })

    it("shows the ask-policy select when enabled", () => {
      settingsState = { terminal: { allowUnattendedExecution: true } }
      render(<TerminalCard />)
      expect(screen.getByTestId("terminal-card-unattended-policy")).toBeInTheDocument()
    })
  })
})
