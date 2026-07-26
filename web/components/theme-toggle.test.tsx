import { fireEvent, render, screen } from "@testing-library/react"
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
})
