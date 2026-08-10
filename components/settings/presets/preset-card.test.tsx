/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"
import type { SystemPromptPreset } from "@cognia/agent-config-types"
import { PresetCard } from "./preset-card"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

const preset = {
  id: "preset-1",
  name: "Focused",
  systemPrompt: "Stay focused",
} as SystemPromptPreset

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
