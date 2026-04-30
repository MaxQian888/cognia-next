/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// Avoid pulling Tauri's plugin-dialog into jsdom — the editor only uses it
// behind an `isTauri()` guard which is false in tests.
jest.mock("@tauri-apps/plugin-dialog", () => ({
  open: jest.fn(),
}))

// The custom-mode store import resolves Zustand persistence; mock it to a
// minimal shape so the editor renders.
jest.mock("@/stores/agent/custom-mode-store", () => ({
  useCustomModeStore: <T,>(selector: (s: { customModes: Record<string, never> }) => T) =>
    selector({ customModes: {} }),
}))

import { PromptPresetsSection } from "./prompt-presets-section"
import { createPreset, listPresets } from "@/lib/db/prompt-presets"
import { getDb, whenSeeded, __resetDbForTesting } from "@/lib/db/schema"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

describe("PromptPresetsSection", () => {
  it("renders the seeded built-ins on first launch", async () => {
    render(<PromptPresetsSection />)
    await waitFor(() => {
      expect(screen.getByText("General Assistant")).toBeInTheDocument()
      expect(screen.getByText("Code Expert")).toBeInTheDocument()
    })
  })

  it("opens the editor when 'New preset' is clicked", async () => {
    const user = userEvent.setup()
    render(<PromptPresetsSection />)
    await screen.findByText("General Assistant")
    // safeT() echoes the fallback string when the i18n mock returns the key.
    await user.click(screen.getByRole("button", { name: /new preset/i }))
    // Editor surfaces a textarea for the system prompt body.
    expect(screen.getByPlaceholderText(/you are/i)).toBeInTheDocument()
  })

  it("filters via the search box", async () => {
    const user = userEvent.setup()
    await getDb().promptPresets.clear()
    await act(async () => {
      await createPreset({ name: "Alpha Helper", content: "x" })
      await createPreset({ name: "Beta Worker", content: "y" })
    })
    render(<PromptPresetsSection />)
    await screen.findByText("Alpha Helper")
    await user.type(screen.getByPlaceholderText(/search presets/i), "Beta")
    await waitFor(() => {
      expect(screen.queryByText("Alpha Helper")).not.toBeInTheDocument()
      expect(screen.getByText("Beta Worker")).toBeInTheDocument()
    })
  })

  it("renders empty state when filters yield nothing", async () => {
    const user = userEvent.setup()
    await getDb().promptPresets.clear()
    await act(async () => {
      await createPreset({ name: "Anything", content: "x" })
    })
    render(<PromptPresetsSection />)
    await screen.findByText("Anything")
    await user.type(screen.getByPlaceholderText(/search presets/i), "zzzz-no-match")
    await waitFor(() => {
      expect(screen.getByText(/no presets match/i)).toBeInTheDocument()
    })
  })

  it("shows the 'no presets yet' empty state when the table is empty", async () => {
    await act(async () => {
      await getDb().promptPresets.clear()
    })
    render(<PromptPresetsSection />)
    await waitFor(() => {
      expect(screen.getByText(/no presets yet/i)).toBeInTheDocument()
    })
  })

  it("seeded built-ins are present in the live query", async () => {
    const all = await listPresets()
    expect(all.filter((p) => p.isBuiltIn)).toHaveLength(12)
  })
})
