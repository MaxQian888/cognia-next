/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react"
import { VscodeImportForm } from "./vscode-import-form"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("@/lib/appearance", () => ({
  importVscodeThemeJson: jest.fn(),
  readVsix: jest.fn(),
}))
jest.mock("@/lib/appearance/derive-variant", () => ({ deriveOppositeVariant: jest.fn() }))
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      createCustomTheme: jest.fn(),
      updateCustomTheme: jest.fn(),
      setActiveCustomTheme: jest.fn(),
      addImportedTheme: jest.fn(),
      settings: { importedVscodeThemes: [] },
    }),
}))

it("opens the shadcn file input from the browse action", () => {
  const { container } = render(<VscodeImportForm />)
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')
  expect(input).toHaveAttribute("data-slot", "input")

  const click = jest.spyOn(input!, "click")
  fireEvent.click(screen.getByRole("button", { name: "browse" }))
  expect(click).toHaveBeenCalledTimes(1)
})
