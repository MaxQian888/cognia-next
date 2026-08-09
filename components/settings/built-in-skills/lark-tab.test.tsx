/**
 * Tests for components/settings/built-in-skills/lark-tab.tsx.
 *
 * Renders the tab against the live registry (which is module-load
 * populated by importing the Lark family barrel) and asserts the tab
 * exposes every Lark skill with the right mutation badge.
 */

import { render, screen, waitFor } from "@testing-library/react"
import { LarkTab } from "./lark-tab"
import { probeLarkCliCapabilities } from "@/lib/skills/built-in/lark/capabilities"

// next-intl is hard to spin up in unit tests; stub useTranslations to
// return the key path verbatim so we can assert on it.
jest.mock("next-intl", () => ({
  useTranslations: (namespace?: string) => (key: string, values?: Record<string, unknown>) => {
    const translatedKey = namespace ? `${namespace}.${key}` : key
    return values ? `${translatedKey}:${JSON.stringify(values)}` : translatedKey
  },
}))
jest.mock("@/lib/skills/built-in/lark/capabilities", () => ({
  probeLarkCliCapabilities: jest.fn(),
}))

const mockProbeLarkCliCapabilities = jest.mocked(probeLarkCliCapabilities)

// Ensure the family barrel registers skills before render.
import "@/lib/skills/built-in"

describe("LarkTab", () => {
  beforeEach(() => {
    mockProbeLarkCliCapabilities.mockReset()
    mockProbeLarkCliCapabilities.mockResolvedValue({
      certifiedVersion: "1.0.83",
      detectedVersion: "1.0.83",
      ready: true,
      missingCommands: [],
      missingFlags: {},
      affectedSkillIds: [],
    })
  })

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

  it("shows detected and certified versions when the capability probe succeeds", async () => {
    render(<LarkTab />)

    expect(
      await screen.findByText("settings.builtInSkills.lark.diagnostics.ready")
    ).toBeInTheDocument()
    expect(
      screen.getByText((text) =>
        text.includes(
          'settings.builtInSkills.lark.diagnostics.versions:{"detected":"1.0.83","certified":"1.0.83"}'
        )
      )
    ).toBeInTheDocument()
  })

  it("shows missing capabilities and affected tools when the probe fails closed", async () => {
    mockProbeLarkCliCapabilities.mockResolvedValueOnce({
      certifiedVersion: "1.0.83",
      detectedVersion: "1.0.82",
      ready: false,
      missingCommands: ["sheets +cells-set"],
      missingFlags: { "lark.sheets.export": ["--file-extension"] },
      affectedSkillIds: ["lark.sheets.write_range", "lark.sheets.export"],
    })

    render(<LarkTab />)

    expect(
      await screen.findByText("settings.builtInSkills.lark.diagnostics.blocked")
    ).toBeInTheDocument()
    expect(screen.getByText((text) => text.includes("sheets +cells-set"))).toBeInTheDocument()
    expect(screen.getByText((text) => text.includes("lark.sheets.write_range"))).toBeInTheDocument()
  })
})
