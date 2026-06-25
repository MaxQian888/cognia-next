/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, act } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

import { ArtifactSelectionChips } from "./artifact-selection-chips"
import { useChatStore } from "@/stores/chat"

beforeEach(() => {
  act(() => useChatStore.getState().clear())
})

const sel = (over = {}) => ({
  artifactId: "a1",
  title: "Snippet",
  snapshot: "const x = 1",
  comment: "rename",
  range: { startLine: 2, endLine: 4 },
  ...over,
})

describe("ArtifactSelectionChips", () => {
  it("renders nothing when there are no selections", () => {
    const { container } = render(<ArtifactSelectionChips />)
    expect(container.firstChild).toBeNull()
  })

  it("renders one chip per staged selection", () => {
    act(() => {
      useChatStore.getState().addArtifactSelection(sel({ title: "one" }))
      useChatStore.getState().addArtifactSelection(sel({ title: "two" }))
    })
    render(<ArtifactSelectionChips />)
    expect(screen.getAllByTestId("artifact-selection-chip")).toHaveLength(2)
  })

  it("removes a chip via its remove button", () => {
    act(() => useChatStore.getState().addArtifactSelection(sel()))
    render(<ArtifactSelectionChips />)
    fireEvent.click(screen.getByRole("button"))
    expect(useChatStore.getState().artifactSelections).toHaveLength(0)
  })

  it("renders bare (no container) and falls back to the label when no comment", () => {
    act(() => useChatStore.getState().addArtifactSelection(sel({ comment: "" })))
    const { container } = render(<ArtifactSelectionChips bare />)
    // Bare mode renders chips directly without the padded wrapper div.
    expect(container.querySelector(".pt-2")).toBeNull()
    expect(screen.getByTestId("artifact-selection-chip")).toBeInTheDocument()
  })
})
