/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import { DEFAULT_MEMORY_CONFIG } from "@/types/memory/memory"
import { RecallPreview } from "./recall-preview"

const mockTryBuildMemoryDeps = jest.fn()
const mockApplyMemoryContext = jest.fn()

jest.mock("@/lib/memory/runtime/build-deps", () => ({
  tryBuildMemoryDeps: (...args: unknown[]) => mockTryBuildMemoryDeps(...args),
}))
jest.mock("@/lib/memory/runtime/apply-memory-context", () => ({
  applyMemoryContext: (...args: unknown[]) => mockApplyMemoryContext(...args),
}))
jest.mock("@/components/chat/motion/motion-reveal", () => ({
  useFlowMotion: () => ({ reduce: true, speed: 1 }),
}))

describe("RecallPreview", () => {
  beforeEach(() => {
    mockTryBuildMemoryDeps.mockReset()
    mockApplyMemoryContext.mockReset()
    mockTryBuildMemoryDeps.mockResolvedValue({ touch: jest.fn(), retrieve: jest.fn() })
    mockApplyMemoryContext.mockResolvedValue({
      retrievedMemories: [{ id: "memory-1", text: "Prefers dark mode", relevance: 0.91 }],
      budget: { used: 12, limit: 900 },
      withheldCount: 0,
      proceduralCount: 0,
      degraded: false,
    })
  })

  it("shows the estimated recall budget without running retrieval", () => {
    render(<RecallPreview config={DEFAULT_MEMORY_CONFIG} averageTokens={30} activeCount={20} />)

    expect(screen.getByRole("meter", { name: "Recall budget" })).toBeInTheDocument()
    expect(screen.getByTestId("memory-budget-readout")).toHaveTextContent("/ 900 tokens")
    expect(mockApplyMemoryContext).not.toHaveBeenCalled()
  })

  it("runs the production recall path without a touch callback", async () => {
    render(<RecallPreview config={DEFAULT_MEMORY_CONFIG} averageTokens={30} activeCount={20} />)
    fireEvent.click(screen.getByTestId("memory-dryrun-toggle"))
    fireEvent.change(screen.getByRole("textbox", { name: "Recall preview query" }), {
      target: { value: "What theme do I prefer?" },
    })
    fireEvent.click(screen.getByTestId("memory-dryrun-run"))

    expect(await screen.findByText("Prefers dark mode")).toBeInTheDocument()
    await waitFor(() =>
      expect(mockApplyMemoryContext).toHaveBeenCalledWith(
        expect.objectContaining({
          userMessage: "What theme do I prefer?",
          deps: expect.objectContaining({ touch: undefined }),
        })
      )
    )
  })

  it("reports an unavailable backend instead of running recall", async () => {
    mockTryBuildMemoryDeps.mockResolvedValue(undefined)
    render(<RecallPreview config={DEFAULT_MEMORY_CONFIG} averageTokens={30} activeCount={20} />)
    fireEvent.click(screen.getByTestId("memory-dryrun-toggle"))
    fireEvent.change(screen.getByRole("textbox", { name: "Recall preview query" }), {
      target: { value: "query" },
    })
    fireEvent.click(screen.getByTestId("memory-dryrun-run"))

    expect(await screen.findByRole("alert")).toHaveTextContent("Memory retrieval is not available")
    expect(mockApplyMemoryContext).not.toHaveBeenCalled()
  })
})
