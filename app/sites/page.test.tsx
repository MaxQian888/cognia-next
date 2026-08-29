import { render } from "@testing-library/react"

jest.mock("@/components/sites/sites-console", () => ({
  SitesConsole: () => <div data-testid="sites-console" />,
}))

import SitesPage from "./page"

it("hosts the console in a full-height wrapper", () => {
  const { container, getByTestId } = render(<SitesPage />)
  expect(getByTestId("sites-console")).toBeInTheDocument()
  // The console's `h-full` chain needs a definite parent height; every other
  // full-height console route uses exactly this wrapper. The wallpaper scope
  // marker is deliberately NOT asserted here — `708de3299` moved
  // `data-bg-target` into `FeaturePageShell`, which this suite mocks away.
  // `components/feature-shell/background-target-coverage.test.ts` owns that
  // contract for every route, including this one.
  expect(container.firstElementChild).toHaveClass("h-full", "min-h-0", "flex-1")
})
