/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const replace = jest.fn()
let searchString = ""

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => new URLSearchParams(searchString),
}))
jest.mock("next-intl", () => ({
  useTranslations: () => (k: string) => k,
}))

// Stub out every tab — we only need to assert the right one is rendered.
jest.mock("./tabs/theme-tab", () => ({ ThemeTab: () => <div data-testid="tab-theme" /> }))
jest.mock("./tabs/typography-tab", () => ({
  TypographyTab: () => <div data-testid="tab-typography" />,
}))
jest.mock("./tabs/wallpaper-tab", () => ({
  WallpaperTab: () => <div data-testid="tab-wallpaper" />,
}))
jest.mock("./tabs/custom-theme-tab", () => ({
  CustomThemeTab: () => <div data-testid="tab-custom" />,
}))
jest.mock("./tabs/vscode-import-tab", () => ({
  VscodeImportTab: () => <div data-testid="tab-import" />,
}))
jest.mock("./tabs/advanced-tab", () => ({ AdvancedTab: () => <div data-testid="tab-advanced" /> }))

import { AppearanceSection } from "./appearance-section"

beforeEach(() => {
  replace.mockClear()
  searchString = ""
})

describe("AppearanceSection", () => {
  it("defaults to the theme tab when the URL has no appearanceTab", () => {
    render(<AppearanceSection />)
    expect(screen.getByTestId("tab-theme")).toBeInTheDocument()
  })

  it("respects the appearanceTab URL param", () => {
    searchString = "?appearanceTab=wallpaper"
    render(<AppearanceSection />)
    expect(screen.getByTestId("tab-wallpaper")).toBeInTheDocument()
  })

  it("falls back to theme tab on an unknown id", () => {
    searchString = "?appearanceTab=garbage"
    render(<AppearanceSection />)
    expect(screen.getByTestId("tab-theme")).toBeInTheDocument()
  })

  it("updates the URL when a tab is clicked", async () => {
    const user = userEvent.setup()
    render(<AppearanceSection />)
    await user.click(screen.getByRole("tab", { name: "tabs.import" }))
    expect(replace).toHaveBeenCalledWith("?appearanceTab=import", { scroll: false })
  })
})
