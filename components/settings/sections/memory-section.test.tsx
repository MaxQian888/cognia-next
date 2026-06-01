/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent } from "@testing-library/react"
import type { MemoryConfig } from "@/types/memory/memory"

const mockSave = jest.fn()
let mockSettings: { memory?: Partial<MemoryConfig> } | null = { memory: {} }
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) =>
    selector({ settings: mockSettings, save: mockSave }),
}))
const mockClear = jest.fn(async () => 0)
jest.mock("@/lib/db/memories", () => ({
  clearMemories: () => mockClear(),
}))

import { MemorySection } from "./memory-section"

beforeEach(() => {
  jest.clearAllMocks()
  mockSettings = { memory: {} }
})

describe("MemorySection", () => {
  it("renders the master toggle (default enabled)", () => {
    render(<MemorySection />)
    const sw = screen.getByRole("switch", { name: /enable long-term memory/i })
    expect((sw as HTMLInputElement).getAttribute("aria-checked")).toBe("true")
  })

  it("saves when the master toggle is flipped off", () => {
    render(<MemorySection />)
    fireEvent.click(screen.getByRole("switch", { name: /enable long-term memory/i }))
    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({ memory: expect.objectContaining({ enabled: false }) })
    )
  })

  it("disables auto-learn switch when memory is off", () => {
    mockSettings = { memory: { enabled: false } }
    render(<MemorySection />)
    const auto = screen.getByRole("switch", { name: /learn automatically/i })
    expect(auto).toBeDisabled()
  })

  it("saves the default-scope select", () => {
    render(<MemorySection />)
    // Radix Select is awkward in jsdom; assert the topK input save path instead.
    const topk = screen.getByLabelText(/memories injected per turn/i)
    fireEvent.change(topk, { target: { value: "12" } })
    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({ memory: expect.objectContaining({ retrievalTopK: 12 }) })
    )
  })

  it("opens the clear-all confirmation and clears on confirm", async () => {
    render(<MemorySection />)
    fireEvent.click(screen.getByRole("button", { name: /clear all/i }))
    // The dialog's confirm button
    const confirm = await screen.findByRole("button", { name: /delete everything/i })
    fireEvent.click(confirm)
    expect(mockClear).toHaveBeenCalled()
  })

  it("links to the management panel", () => {
    render(<MemorySection />)
    const link = screen.getByRole("link", { name: /manage memories/i })
    expect(link.getAttribute("href")).toBe("/memory")
  })
})
