import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { en } from "@web/content/en"
import { ThemeToggle } from "./theme-toggle"

const setTheme = jest.fn()
let currentTheme: string | undefined = "system"

jest.mock("next-themes", () => ({
  useTheme: () => ({ theme: currentTheme, setTheme }),
}))

describe("ThemeToggle", () => {
  beforeEach(() => {
    currentTheme = "system"
  })

  it("exposes the three modes as a labelled radio group", () => {
    render(<ThemeToggle copy={en.nav} />)
    expect(screen.getByRole("radiogroup", { name: en.nav.themeToggle })).toBeInTheDocument()
    expect(screen.getAllByRole("radio")).toHaveLength(3)
  })

  it("marks the active mode as checked", () => {
    render(<ThemeToggle copy={en.nav} />)
    expect(screen.getByRole("radio", { name: en.nav.themeSystem })).toBeChecked()
    expect(screen.getByRole("radio", { name: en.nav.themeLight })).not.toBeChecked()
  })

  it("keeps 'system' as a reachable choice rather than collapsing to a binary switch", () => {
    currentTheme = "dark"
    render(<ThemeToggle copy={en.nav} />)
    expect(screen.getByRole("radio", { name: en.nav.themeSystem })).toBeInTheDocument()
    expect(screen.getByRole("radio", { name: en.nav.themeDark })).toBeChecked()
  })

  it("sets the chosen mode", () => {
    render(<ThemeToggle copy={en.nav} />)
    fireEvent.click(screen.getByRole("radio", { name: en.nav.themeDark }))
    expect(setTheme).toHaveBeenCalledWith("dark")
  })

  it("treats an unset theme as system rather than leaving nothing selected", () => {
    currentTheme = undefined
    render(<ThemeToggle copy={en.nav} />)
    expect(screen.getByRole("radio", { name: en.nav.themeSystem })).toBeChecked()
  })

  it("is one tab stop that lands on the active mode", async () => {
    // The reason this control is a Radix ToggleGroup rather than three buttons:
    // the hand-rolled version made every mode its own tab stop and handled no
    // arrow keys at all. Roving focus makes the group a single stop, and Tab
    // enters it on whichever mode is currently selected.
    const user = userEvent.setup()
    currentTheme = "light"
    render(<ThemeToggle copy={en.nav} />)

    await user.tab()
    expect(screen.getByRole("radio", { name: en.nav.themeLight })).toHaveFocus()

    await user.tab()
    for (const radio of screen.getAllByRole("radio")) {
      expect(radio).not.toHaveFocus()
    }
  })

  it("moves focus with the arrow keys and commits on Space", async () => {
    // Focus-then-activate, not select-on-arrow. Radix's keyboard model for a
    // toggle group is that arrows move focus and Space/Enter commits, and that
    // is the behaviour worth having here: select-on-arrow would strobe the
    // whole page through every theme as the user walks the group.
    const user = userEvent.setup()
    currentTheme = "light"
    render(<ThemeToggle copy={en.nav} />)

    await user.tab()
    await user.keyboard("{ArrowRight}")
    expect(screen.getByRole("radio", { name: en.nav.themeDark })).toHaveFocus()
    expect(setTheme).not.toHaveBeenCalled()

    await user.keyboard(" ")
    expect(setTheme).toHaveBeenCalledWith("dark")
  })

  it("ignores a deselect so the control never lands in a themeless state", () => {
    // Radix reports "" when the pressed item is pressed again. A visitor who
    // taps the active mode twice must not end up with no theme selected.
    currentTheme = "dark"
    render(<ThemeToggle copy={en.nav} />)
    fireEvent.click(screen.getByRole("radio", { name: en.nav.themeDark }))
    expect(setTheme).not.toHaveBeenCalled()
  })
})

// The site is a static export: the first paint has no way to know the reader's
// theme, and swapping a control in on hydration would shift the nav. It
// reserves the exact footprint instead.
describe("ThemeToggle before mount", () => {
  it("reserves the control's footprint without announcing anything", () => {
    jest.isolateModules(() => {
      jest.doMock("@web/hooks/use-has-mounted", () => ({ useHasMounted: () => false }))
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { ThemeToggle: Subject } = require("./theme-toggle")
      const { container } = render(<Subject copy={en.nav} />)
      expect(screen.queryByRole("radiogroup")).toBeNull()
      const placeholder = container.firstElementChild as HTMLElement
      expect(placeholder).toHaveAttribute("aria-hidden", "true")
      expect(placeholder.className).toContain("h-8")
    })
    jest.dontMock("@web/hooks/use-has-mounted")
  })
})
