import { render } from "@testing-library/react"

jest.mock("@/components/sites/sites-console", () => ({
  SitesConsole: () => <div data-testid="sites-console" />,
}))

import SitesPage from "./page"

it("hosts the console in the shell's full-height wallpaper wrapper", () => {
  const { container } = render(<SitesPage />)
  const wrapper = container.querySelector("[data-bg-target='chat']")
  expect(wrapper).not.toBeNull()
  // The console's `h-full` chain needs a definite parent height; every other
  // full-height console route uses exactly this wrapper.
  expect(wrapper).toHaveClass("h-full", "min-h-0", "flex-1")
})
