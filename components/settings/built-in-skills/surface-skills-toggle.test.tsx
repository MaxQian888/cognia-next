/**
 * Tests for components/settings/built-in-skills/surface-skills-toggle.tsx.
 *
 * Verifies the default-ON semantics (only an explicit `false` disables) and
 * that toggling persists the flag through the settings store's `save`.
 */

import { render, screen, fireEvent } from "@testing-library/react"
import { SurfaceSkillsToggle } from "./surface-skills-toggle"

jest.mock("next-intl", () => ({
  useTranslations: (namespace?: string) => (key: string) =>
    namespace ? `${namespace}.${key}` : key,
}))

const save = jest.fn()
let mockSettings: { surfaceSkillsEnabled?: boolean } = {}

jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) =>
    selector({ settings: mockSettings, save }),
}))

describe("SurfaceSkillsToggle", () => {
  beforeEach(() => {
    save.mockReset()
    mockSettings = {}
  })

  it("is ON by default when the setting is undefined", () => {
    render(<SurfaceSkillsToggle />)
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true")
  })

  it("is ON when explicitly true", () => {
    mockSettings = { surfaceSkillsEnabled: true }
    render(<SurfaceSkillsToggle />)
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true")
  })

  it("is OFF only when explicitly false", () => {
    mockSettings = { surfaceSkillsEnabled: false }
    render(<SurfaceSkillsToggle />)
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false")
  })

  it("persists the new value on toggle", () => {
    render(<SurfaceSkillsToggle />)
    fireEvent.click(screen.getByRole("switch"))
    expect(save).toHaveBeenCalledWith({ surfaceSkillsEnabled: false })
  })
})
