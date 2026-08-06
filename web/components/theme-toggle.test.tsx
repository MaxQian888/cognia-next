import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { en } from "@web/content/en"
import { ThemeToggle } from "./theme-toggle"

const setTheme = jest.fn()
let currentTheme: string | undefined = "system"
let resolvedTheme: string | undefined = "light"
let mounted = true
let reduced = false

jest.mock("next-themes", () => ({
  useTheme: () => ({ theme: currentTheme, resolvedTheme, setTheme }),
}))

jest.mock("motion/react", () => ({ useReducedMotion: () => reduced }))

// A mutable module mock rather than `jest.isolateModules` + `require`: the
// isolated registry hands the component a *second* React copy, and the moment
// this component started calling a real hook of its own (`useDismissable`),
// that second copy made `useState` null. See the repo's jest-gotchas notes.
jest.mock("@web/hooks/use-has-mounted", () => ({ useHasMounted: () => mounted }))

function openMenu() {
  fireEvent.click(screen.getByRole("button", { name: en.nav.themeToggle }))
}

describe("ThemeToggle", () => {
  beforeEach(() => {
    currentTheme = "system"
    resolvedTheme = "light"
    reduced = false
    mounted = true
    setTheme.mockClear()
    Object.assign(document, { startViewTransition: undefined })
  })

  it("collapses to a single trigger rather than three always-visible options", () => {
    // The segmented version measured 168px, and with the language switcher the
    // pair took 291px of a 1480px bar. Everything below verifies that the
    // compaction did not cost what the segmented control was protecting.
    render(<ThemeToggle copy={en.nav} />)
    expect(screen.getAllByRole("button")).toHaveLength(1)
    expect(screen.queryByRole("menu")).toBeNull()
  })

  it("names the trigger, which is otherwise only a glyph", () => {
    render(<ThemeToggle copy={en.nav} />)
    const trigger = screen.getByRole("button", { name: en.nav.themeToggle })
    expect(trigger).toHaveAttribute("aria-haspopup", "menu")
    expect(trigger).toHaveAttribute("aria-expanded", "false")
  })

  it("opens the three modes as a labelled menu", () => {
    render(<ThemeToggle copy={en.nav} />)
    openMenu()
    expect(screen.getByRole("menu", { name: en.nav.themeToggle })).toBeInTheDocument()
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(3)
  })

  it("keeps every mode labelled in words, not icon-only", () => {
    render(<ThemeToggle copy={en.nav} />)
    openMenu()
    for (const label of [en.nav.themeLight, en.nav.themeDark, en.nav.themeSystem]) {
      expect(screen.getByRole("menuitemradio", { name: new RegExp(label) })).toBeInTheDocument()
    }
  })

  it("marks the active mode as checked", () => {
    render(<ThemeToggle copy={en.nav} />)
    openMenu()
    expect(
      screen.getByRole("menuitemradio", { name: new RegExp(en.nav.themeSystem) })
    ).toBeChecked()
    expect(
      screen.getByRole("menuitemradio", { name: new RegExp(en.nav.themeLight) })
    ).not.toBeChecked()
  })

  it("keeps 'system' reachable rather than collapsing to a binary switch", () => {
    // A visitor who has never touched this is on `system`; a two-state toggle
    // would spend that choice on the first click.
    currentTheme = "dark"
    render(<ThemeToggle copy={en.nav} />)
    openMenu()
    expect(
      screen.getByRole("menuitemradio", { name: new RegExp(en.nav.themeSystem) })
    ).toBeInTheDocument()
    expect(screen.getByRole("menuitemradio", { name: new RegExp(en.nav.themeDark) })).toBeChecked()
  })

  it("sets the chosen mode and closes", () => {
    render(<ThemeToggle copy={en.nav} />)
    openMenu()
    fireEvent.click(screen.getByRole("menuitemradio", { name: new RegExp(en.nav.themeDark) }))
    expect(setTheme).toHaveBeenCalledWith("dark")
    expect(screen.queryByRole("menu")).toBeNull()
  })

  it("uses the installed view transition when choosing a visual theme", () => {
    const startViewTransition = jest.fn((callback: () => void) => {
      callback()
      return { ready: Promise.resolve(), finished: Promise.resolve() }
    })
    Object.assign(document, { startViewTransition })
    Object.assign(document.documentElement, { animate: jest.fn() })

    render(<ThemeToggle copy={en.nav} />)
    openMenu()
    fireEvent.click(screen.getByRole("menuitemradio", { name: new RegExp(en.nav.themeDark) }))

    expect(startViewTransition).toHaveBeenCalledTimes(1)
    expect(setTheme).toHaveBeenCalledWith("dark")
  })

  it("switches immediately under reduced motion", () => {
    reduced = true
    const startViewTransition = jest.fn()
    Object.assign(document, { startViewTransition })

    render(<ThemeToggle copy={en.nav} />)
    openMenu()
    fireEvent.click(screen.getByRole("menuitemradio", { name: new RegExp(en.nav.themeDark) }))

    expect(startViewTransition).not.toHaveBeenCalled()
    expect(setTheme).toHaveBeenCalledWith("dark")
  })

  it("treats an unset theme as system rather than leaving nothing selected", () => {
    currentTheme = undefined
    render(<ThemeToggle copy={en.nav} />)
    openMenu()
    expect(
      screen.getByRole("menuitemradio", { name: new RegExp(en.nav.themeSystem) })
    ).toBeChecked()
  })

  it("closes on Escape and returns focus to the trigger", async () => {
    // Same dismissal model as the Product menu beside it — one behaviour in the
    // header, not two.
    const user = userEvent.setup()
    render(<ThemeToggle copy={en.nav} />)
    const trigger = screen.getByRole("button", { name: en.nav.themeToggle })
    openMenu()
    expect(screen.getByRole("menu")).toBeInTheDocument()

    await user.keyboard("{Escape}")
    expect(screen.queryByRole("menu")).toBeNull()
    expect(trigger).toHaveFocus()
  })

  it("is one tab stop while closed", async () => {
    const user = userEvent.setup()
    render(<ThemeToggle copy={en.nav} />)
    await user.tab()
    expect(screen.getByRole("button", { name: en.nav.themeToggle })).toHaveFocus()
  })
})

// The site is a static export: the first paint has no way to know the reader's
// theme, and swapping a control in on hydration would shift the nav. It
// reserves the exact footprint instead.
describe("ThemeToggle before mount", () => {
  it("reserves the control's footprint without announcing anything", () => {
    mounted = false
    const { container } = render(<ThemeToggle copy={en.nav} />)
    expect(screen.queryByRole("button")).toBeNull()
    const placeholder = container.firstElementChild as HTMLElement
    expect(placeholder).toHaveAttribute("aria-hidden", "true")
    expect(placeholder.className).toContain("size-8")
    mounted = true
  })
})
