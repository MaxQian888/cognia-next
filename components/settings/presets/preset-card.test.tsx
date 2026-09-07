/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"
import type { SystemPromptPreset } from "@cognia/agent-config-types"
import { PresetCard } from "./preset-card"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

const preset = {
  id: "preset-1",
  name: "Focused",
  content: "Stay focused",
  createdAt: 1,
  updatedAt: 1,
} satisfies SystemPromptPreset

it("uses a flat row and the shared Button primitive for dragging", () => {
  const { container } = render(
    <PresetCard
      preset={preset}
      reorderable
      onEdit={jest.fn()}
      onDuplicate={jest.fn()}
      onDelete={jest.fn()}
      onToggleDefault={jest.fn()}
      onToggleFavorite={jest.fn()}
    />
  )

  expect(container.querySelector('[data-slot="card"]')).not.toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Drag to reorder" })).toHaveAttribute(
    "data-slot",
    "button"
  )
})

it("lets the actions wrap so the description keeps the row", () => {
  // The text column sat between a 40px avatar and five `shrink-0` action
  // buttons, so a 375px phone left it about 137px and a one-line description
  // became six lines beside two thirds of an empty row.
  render(
    <PresetCard
      preset={{ ...preset, description: "Balanced general-purpose helper." }}
      onEdit={jest.fn()}
      onDuplicate={jest.fn()}
      onDelete={jest.fn()}
      onToggleDefault={jest.fn()}
      onToggleFavorite={jest.fn()}
    />
  )

  const text = screen.getByText("Focused").closest("div")?.parentElement
  expect(text).toHaveClass("min-w-0", "grow", "basis-64")
  // Not `flex-1`: that pins the basis to 0, so the column reports as
  // zero-wide, never forces the line break, and starves exactly as before.
  expect(text).not.toHaveClass("flex-1")
  expect(text?.parentElement).toHaveClass("flex-wrap")
})
