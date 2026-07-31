/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (k: string) => k,
}))

jest.mock("../tabs/theme-pack-tab", () => ({
  ThemePackTab: () => <div data-testid="theme-pack-tab" />,
}))
jest.mock("../tabs/vscode-import-tab", () => ({
  VscodeImportTab: () => <div data-testid="vscode-import-tab" />,
}))

import { AppearanceLibraryPanel } from "./library-panel"

describe("AppearanceLibraryPanel", () => {
  it("hosts both ways of acquiring a theme under one panel", () => {
    render(<AppearanceLibraryPanel />)
    expect(screen.getByTestId("theme-pack-tab")).toBeInTheDocument()
    expect(screen.getByTestId("vscode-import-tab")).toBeInTheDocument()
  })

  it("labels each section so the merge stays scannable", () => {
    render(<AppearanceLibraryPanel />)
    expect(screen.getByRole("heading", { name: "packsTitle" })).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "importTitle" })).toBeInTheDocument()
  })
})
