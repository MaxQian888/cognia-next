import { fireEvent, render, screen } from "@testing-library/react"
import { CustomThemeEditor } from "./custom-theme-editor"

const mockName = "LongTheme".repeat(40)
jest.mock("@/stores/theme", () => ({
  useCustomThemeStore: (select: (state: unknown) => unknown) =>
    select({
      themes: [{ id: "saved", name: mockName, tokens: { bg: "#ffffff", accent: "#000000" } }],
      upsert: jest.fn(),
      remove: jest.fn(),
    }),
  seedTokens: () => ({ bg: "#ffffff", accent: "#000000" }),
}))

it("adapts token columns to its own width and keeps long saved themes selectable", () => {
  const onSelect = jest.fn()
  const { container } = render(
    <CustomThemeEditor selectedId="saved" builtInBase="arknights" onSelect={onSelect} />
  )
  expect(container.firstChild).toHaveClass("@container/theme-editor")
  expect(screen.getByLabelText("bg").parentElement?.parentElement).toHaveClass(
    "grid-cols-1",
    "@xl/theme-editor:grid-cols-2"
  )
  const chip = screen.getByRole("button", { name: mockName })
  expect(chip).toHaveClass("max-w-full")
  expect(screen.getByText(mockName)).toHaveClass("truncate")
  fireEvent.click(chip)
  expect(onSelect).toHaveBeenCalledWith("saved")
})
