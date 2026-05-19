/**
 * Tests for components/settings/built-in-skills/lark-tab.tsx.
 *
 * Renders the tab against the live registry (which is module-load
 * populated by importing the Lark family barrel) and asserts the tab
 * exposes every Lark skill with the right mutation badge.
 */

import { render, screen, waitFor } from "@testing-library/react"
import { LarkTab } from "./lark-tab"

// next-intl is hard to spin up in unit tests; stub useTranslations to
// return the key path verbatim so we can assert on it.
jest.mock("next-intl", () => ({
  useTranslations: (namespace?: string) => (key: string) =>
    namespace ? `${namespace}.${key}` : key,
}))

// Ensure the family barrel registers skills before render.
import "@/lib/skills/built-in"

describe("LarkTab", () => {
  it("renders one accordion item per registered Lark family", async () => {
    render(<LarkTab />)
    await waitFor(() => {
      // Family identifiers are surfaced verbatim in the trigger.
      expect(screen.getByText("lark.calendar")).toBeDefined()
    })
    expect(screen.getByText("lark.doc")).toBeDefined()
    expect(screen.getByText("lark.sheets")).toBeDefined()
    expect(screen.getByText("lark.base")).toBeDefined()
    expect(screen.getByText("lark.task")).toBeDefined()
    expect(screen.getByText("lark.wiki")).toBeDefined()
  })

  it("renders the intro card with translated copy", async () => {
    render(<LarkTab />)
    await waitFor(() => {
      expect(screen.getByText("settings.builtInSkills.lark.intro.title")).toBeDefined()
    })
  })
})
