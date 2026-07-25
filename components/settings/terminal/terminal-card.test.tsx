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
// Subscribers of the fake store. The real `useSettingsStore` is a live Zustand
// store: a `save()` re-renders every subscriber, which is exactly what makes a
// settings input *controlled* by persisted state. Modelling that here is not
// gold-plating — a non-reactive mock silently turns every controlled input into
// an uncontrolled one, which is how the "typing a font size is eaten by the
// clamp" bug survived the original suite.
const settingsListeners = new Set<() => void>()

function saveSettingsPatch(patch: { terminal?: Record<string, unknown> }) {
  settingsState = { ...settingsState, ...patch }
  const result = settingsSave(patch)
  settingsListeners.forEach((listener) => listener())
  return result
}

jest.mock("@/stores/settings", () => {
  // Required lazily: the factory is hoisted above the imports, so `react` has
  // to be resolved inside the hook body, not at factory-evaluation time.
  const useSettingsStore = Object.assign(
    (selector: (s: unknown) => unknown) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { useSyncExternalStore } = require("react") as typeof import("react")
      // The snapshot must be referentially stable while nothing changed;
      // `settingsState` / `saveSettingsPatch` identities satisfy that.
      const read = () => selector({ settings: settingsState, save: saveSettingsPatch })
      return useSyncExternalStore(
        (onChange: () => void) => {
          settingsListeners.add(onChange)
          return () => settingsListeners.delete(onChange)
        },
        read,
        read
      )
    },
    {
      getState: () => ({ settings: settingsState, save: saveSettingsPatch }),
    }
  )
  return { useSettingsStore }
})

// The font specimen probes availability by measuring text on a 2D canvas,
// which jsdom doesn't implement (it logs a "not implemented" error). The probe
// itself is covered in lib/appearance/font-availability.test.ts; here it only
// has to stay quiet and inconclusive.
jest.mock("@/lib/appearance/font-availability", () => {
  const actual = jest.requireActual("@/lib/appearance/font-availability")
  return { ...actual, isFontFamilyAvailable: () => null }
})

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
  settingsListeners.clear()
})

/** Last `terminal` blob handed to `save()`, or `{}` when nothing was saved. */
function lastSavedTerminal(): Record<string, unknown> {
  const calls = settingsSave.mock.calls
  const last = calls[calls.length - 1]?.[0] as { terminal?: Record<string, unknown> } | undefined
  return last?.terminal ?? {}
}

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

  it("clamps fontSize between 8 and 32 on commit", async () => {
    render(<TerminalCard />)
    const fontInput = screen.getByTestId("terminal-card-font-size") as HTMLInputElement
    await act(async () => {
      fireEvent.change(fontInput, { target: { value: "200" } })
      fireEvent.blur(fontInput)
    })
    expect(lastSavedTerminal()).toMatchObject({ fontSize: 32 })
  })

  // Regression: typing a two-digit size used to be swallowed by the
  // clamp-on-every-keystroke. "2" clamped up to the 8 floor, so the field
  // could never reach 20 — the user's font size "didn't take effect".
  it("lets a multi-digit font size be typed one keystroke at a time", async () => {
    const user = userEvent.setup()
    render(<TerminalCard />)
    const fontInput = screen.getByTestId("terminal-card-font-size") as HTMLInputElement
    await user.clear(fontInput)
    await user.type(fontInput, "20")
    await user.tab()
    expect(fontInput.value).toBe("20")
    expect(lastSavedTerminal()).toMatchObject({ fontSize: 20 })
  })

  it("clamps scrollback between 1000 and 100000 on commit", async () => {
    render(<TerminalCard />)
    const scrollback = screen.getByTestId("terminal-card-scrollback") as HTMLInputElement
    await act(async () => {
      fireEvent.change(scrollback, { target: { value: "10" } })
      fireEvent.blur(scrollback)
    })
    expect(lastSavedTerminal()).toMatchObject({ scrollback: 1000 })
  })

  // Same regression class as the font size, with a much wider floor: every
  // prefix of "20000" shorter than four digits is below the 1000 minimum.
  it("lets a five-digit scrollback be typed one keystroke at a time", async () => {
    const user = userEvent.setup()
    render(<TerminalCard />)
    const scrollback = screen.getByTestId("terminal-card-scrollback") as HTMLInputElement
    await user.clear(scrollback)
    await user.type(scrollback, "20000")
    await user.tab()
    expect(lastSavedTerminal()).toMatchObject({ scrollback: 20000 })
  })

  it("restores the committed value when the field is left empty", async () => {
    const user = userEvent.setup()
    render(<TerminalCard />)
    const fontInput = screen.getByTestId("terminal-card-font-size") as HTMLInputElement
    await user.clear(fontInput)
    await user.tab()
    // Blanking the field is not "set me to the minimum" — it reverts.
    expect(fontInput.value).toBe("13")
    expect(settingsSave).not.toHaveBeenCalled()
  })

  it("persists fontFamily updates", async () => {
    render(<TerminalCard />)
    const fontFamilyInput = screen.getByPlaceholderText('"JetBrains Mono", monospace')
    await act(async () => {
      fireEvent.change(fontFamilyInput, { target: { value: "Cascadia Code, monospace" } })
      fireEvent.blur(fontFamilyInput)
    })
    expect(lastSavedTerminal()).toMatchObject({ fontFamily: "Cascadia Code, monospace" })
  })

  // Regression: the font-family box wrote straight through to the store on
  // every keystroke, so a quoted stack was persisted (and pushed into the live
  // xterm) in broken intermediate states like `"` or `"JetBrains Mo`.
  it("does not persist half-typed font stacks", async () => {
    const user = userEvent.setup()
    render(<TerminalCard />)
    const fontFamilyInput = screen.getByPlaceholderText(
      '"JetBrains Mono", monospace'
    ) as HTMLInputElement
    await user.click(fontFamilyInput)
    await user.type(fontFamilyInput, '"Fira Code", monospace')
    const midTypingSaves = settingsSave.mock.calls.length
    await user.tab()
    expect(lastSavedTerminal()).toMatchObject({ fontFamily: '"Fira Code", monospace' })
    // One commit on blur — not one per character.
    expect(settingsSave.mock.calls.length).toBeLessThanOrEqual(midTypingSaves + 1)
    expect(settingsSave.mock.calls.length).toBeLessThan(5)
  })

  it("renders a live specimen of the configured typography", async () => {
    settingsState = { terminal: { fontFamily: '"Fira Code", monospace', fontSize: 18 } }
    render(<TerminalCard />)
    expect(screen.getByTestId("terminal-font-preview-sample")).toHaveStyle({
      fontFamily: '"Fira Code", monospace',
      fontSize: "18px",
    })
  })

  it("hides the font reset while the font is untouched", () => {
    render(<TerminalCard />)
    expect(screen.queryByTestId("terminal-card-reset-font")).toBeNull()
  })

  it("resets family, size and weight back to the defaults", async () => {
    settingsState = { terminal: { fontFamily: "Menlo", fontSize: 22, fontWeight: "700" } }
    render(<TerminalCard />)
    await act(async () => {
      fireEvent.click(screen.getByTestId("terminal-card-reset-font"))
    })
    expect(lastSavedTerminal()).toMatchObject({
      fontFamily: "",
      fontSize: 13,
      fontWeight: "normal",
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
        // Leads with the app-bundled Nerd Font so the icons render without the
        // user installing anything, and still carries a Nerd-Font fallback.
        fontFamily: expect.stringMatching(/^"MesloLGS NF".*Nerd Font/),
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

  it("turns custom glyph rendering off (defaults on)", async () => {
    render(<TerminalCard />)
    const toggle = screen.getByTestId("terminal-card-custom-glyphs")
    await act(async () => {
      fireEvent.click(toggle)
    })
    expect(settingsSave).toHaveBeenLastCalledWith({
      terminal: expect.objectContaining({ customGlyphs: false }),
    })
  })

  it("turns overlapping glyph rescaling off (defaults on)", async () => {
    render(<TerminalCard />)
    const toggle = screen.getByTestId("terminal-card-rescale-overlapping-glyphs")
    await act(async () => {
      fireEvent.click(toggle)
    })
    expect(settingsSave).toHaveBeenLastCalledWith({
      terminal: expect.objectContaining({ rescaleOverlappingGlyphs: false }),
    })
  })

  it("turns bright ANSI colors for bold text off (defaults on)", async () => {
    render(<TerminalCard />)
    const toggle = screen.getByTestId("terminal-card-bold-bright-colors")
    await act(async () => {
      fireEvent.click(toggle)
    })
    expect(settingsSave).toHaveBeenLastCalledWith({
      terminal: expect.objectContaining({ drawBoldTextInBrightColors: false }),
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

  it("clamps the bar cursor width between 1 and 10 pixels", async () => {
    render(<TerminalCard />)
    const input = screen.getByTestId("terminal-card-cursor-width") as HTMLInputElement
    await act(async () => {
      fireEvent.change(input, { target: { value: "99" } })
      fireEvent.blur(input)
    })
    expect(lastSavedTerminal()).toMatchObject({ cursorWidth: 10 })
  })

  it("persists the inactive cursor style", async () => {
    const user = userEvent.setup()
    render(<TerminalCard />)
    await user.click(screen.getByTestId("terminal-card-cursor-inactive-style"))
    await user.click(await screen.findByText("settings.terminal.cursor.inactiveNone"))
    expect(settingsSave).toHaveBeenLastCalledWith({
      terminal: expect.objectContaining({ cursorInactiveStyle: "none" }),
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
      fireEvent.blur(input)
    })
    expect(lastSavedTerminal()).toMatchObject({ lineHeight: 2 })
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
      fireEvent.blur(input)
    })
    expect(lastSavedTerminal()).toMatchObject({ scrollSensitivity: 10 })
  })

  it("turns smooth scrolling on (defaults off)", async () => {
    render(<TerminalCard />)
    const toggle = screen.getByTestId("terminal-card-smooth-scrolling")
    await act(async () => {
      fireEvent.click(toggle)
    })
    expect(settingsSave).toHaveBeenLastCalledWith({
      terminal: expect.objectContaining({ smoothScrolling: true }),
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
        fireEvent.blur(debounce)
      })
      expect(lastSavedTerminal()).toMatchObject({
        autocomplete: expect.objectContaining({ debounceMs: 2000 }),
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
