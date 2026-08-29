/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string, vars?: { default?: string }) =>
    vars?.default ?? `${ns}.${key}`,
}))

jest.mock("next-themes", () => ({ useTheme: () => ({ theme: "light", setTheme: jest.fn() }) }))

jest.mock("@/lib/tauri", () => ({ isTauri: () => false }))

// The keybinding tab mounts a heavy editor that is covered by its own suite.
jest.mock("@/components/canvas/keybinding-settings", () => ({
  KeybindingSettings: () => <div data-testid="keybinding-settings" />,
}))

import { useCanvasSettingsStore } from "@/stores/canvas/canvas-settings-store"
import { CanvasSection } from "./canvas-section"

beforeEach(() => {
  useCanvasSettingsStore.getState().resetSettings()
})

afterAll(() => {
  useCanvasSettingsStore.getState().resetSettings()
})

describe("CanvasSection", () => {
  it("renders the eight tabs", () => {
    render(<CanvasSection />)
    for (const label of [
      "Editor",
      "AI",
      "Versioning",
      "Collab",
      "Execution",
      "Accessibility",
      "Keybindings",
      "Theme",
    ]) {
      expect(screen.getByRole("tab", { name: label })).toBeInTheDocument()
    }
  })

  it("scrolls the tab strip instead of cramming it into a fixed grid", () => {
    // A `grid-cols-4` strip gave each tab ~93px at 375px, clipping
    // "Collaboration", "Accessibility" and "Keybindings".
    const { container } = render(<CanvasSection />)
    const list = container.querySelector('[role="tablist"]')
    expect(list?.className).toContain("overflow-x-auto")
    expect(list?.className).not.toContain("grid-cols-4")
  })

  it("stacks the header below sm so the actions do not squeeze the description", () => {
    const { container } = render(<CanvasSection />)
    const header = container.querySelector(".flex.flex-col.sm\\:flex-row")
    expect(header).not.toBeNull()
    expect(within(header as HTMLElement).getByRole("button", { name: /reset all/i })).toBeVisible()
  })

  it("resets every section from the header button", () => {
    useCanvasSettingsStore.getState().updateEditorSettings({ fontSize: 22 })
    expect(useCanvasSettingsStore.getState().settings.editor.fontSize).toBe(22)
    render(<CanvasSection />)
    fireEvent.click(screen.getByRole("button", { name: /reset all/i }))
    expect(useCanvasSettingsStore.getState().settings.editor.fontSize).not.toBe(22)
  })
})

describe("CanvasSection — fields with no runtime consumer", () => {
  /**
   * The exact set of controls this page renders inert. Shrinking it means a
   * field got wired up; growing it means a new promise shipped without one.
   * Either way the change should be deliberate, so it is pinned here.
   */
  const DORMANT = [
    { tab: "AI", testid: "canvas-ai-streaming-responses" },
    { tab: "AI", testid: "canvas-ai-inline-completion" },
    { tab: "Versioning", testid: "canvas-version-compress" },
  ]

  async function openTab(name: string) {
    // Radix tab triggers activate on pointer events, which `fireEvent.click`
    // does not synthesise — the panel would stay unmounted.
    await userEvent.click(screen.getByRole("tab", { name }))
  }

  it.each(DORMANT)("renders $testid disabled with a reason", async ({ tab, testid }) => {
    render(<CanvasSection />)
    await openTab(tab)
    const row = screen.getByTestId(testid)
    expect(within(row).getByRole("switch")).toBeDisabled()
    // The reason replaces the description rather than sitting beside it.
    expect(row.textContent).toContain("settings.canvas.dormant")
    expect(row.className).toContain("opacity-60")
  })

  it("leaves every OTHER toggle on those two tabs live", async () => {
    render(<CanvasSection />)
    const dormantIds = new Set(DORMANT.map((d) => d.testid))
    for (const tab of ["AI", "Versioning"]) {
      await openTab(tab)
      const switches = screen.getAllByRole("switch")
      const others = switches.filter((s) => {
        const id = s.closest("[data-testid]")?.getAttribute("data-testid") ?? ""
        return !dormantIds.has(id)
      })
      // Guard the walk itself: a tab that rendered nothing would otherwise
      // pass this as "no disabled switches found".
      expect(others.length).toBeGreaterThan(0)
      expect(others.filter((s) => s.hasAttribute("disabled"))).toEqual([])
    }
  })

  it("keeps the confidence toggle live — it was wired up", async () => {
    render(<CanvasSection />)
    await openTab("AI")
    const before = useCanvasSettingsStore.getState().settings.ai.showConfidence
    const toggle = screen.getByRole("switch", { name: "settings.canvas.ai.showConfidence" })
    expect(toggle).not.toBeDisabled()
    fireEvent.click(toggle)
    expect(useCanvasSettingsStore.getState().settings.ai.showConfidence).toBe(!before)
  })
})
