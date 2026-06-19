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
jest.mock("./tabs/auto-mode-tab", () => ({ AutoModeTab: () => <div data-testid="tab-auto" /> }))
jest.mock("./tabs/theme-pack-tab", () => ({
  ThemePackTab: () => <div data-testid="tab-themePack" />,
}))
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
jest.mock("./tabs/components-tab", () => ({
  ComponentsTab: () => <div data-testid="tab-components" />,
}))
jest.mock("./tabs/a11y-tab", () => ({ A11yTab: () => <div data-testid="tab-a11y" /> }))
jest.mock("./tabs/advanced-tab", () => ({ AdvancedTab: () => <div data-testid="tab-advanced" /> }))
jest.mock("../personalization-card", () => ({
  PersonalizationCard: () => <div data-testid="personalization-card-stub" />,
}))
jest.mock("@/components/plugins/plugin-extension-slot", () => ({
  PluginExtensionSlot: () => null,
}))

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

  it("renders the personalization card below the tabs", () => {
    render(<AppearanceSection />)
    expect(screen.getByTestId("personalization-card-stub")).toBeInTheDocument()
  })

  it("respects the appearanceTab URL param", () => {
    searchString = "?appearanceTab=wallpaper"
    render(<AppearanceSection />)
    expect(screen.getByTestId("tab-wallpaper")).toBeInTheDocument()
  })

  it("renders the new auto tab when selected", () => {
    searchString = "?appearanceTab=auto"
    render(<AppearanceSection />)
    expect(screen.getByTestId("tab-auto")).toBeInTheDocument()
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

  it("exposes every tab as a tab control (wrapping strip stays fully visible)", () => {
    render(<AppearanceSection />)
    // All 10 tabs are rendered as tab triggers — none hidden behind a scroll.
    expect(screen.getAllByRole("tab")).toHaveLength(10)
  })

  it("does not render an inline reset button (the shell owns section reset)", () => {
    render(<AppearanceSection />)
    expect(screen.queryByRole("button", { name: "reset.button" })).not.toBeInTheDocument()
  })
})
