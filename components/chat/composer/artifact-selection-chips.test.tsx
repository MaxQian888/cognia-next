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

  it("marks the lead chip as the edit target and promotes another on click", () => {
    act(() => {
      useChatStore.getState().addArtifactSelection(sel({ title: "one", artifactId: "a1" }))
      useChatStore.getState().addArtifactSelection(sel({ title: "two", artifactId: "a2" }))
    })
    render(<ArtifactSelectionChips />)

    // Only the first selection becomes the send's edit target. Every chip used
    // to look identical, so the other artifact silently could never receive a
    // revision proposal — the drop was recorded in a `debug` log alone.
    const chips = screen.getAllByTestId("artifact-selection-chip")
    expect(chips[0]).toHaveAttribute("data-edit-target", "true")
    expect(chips[1]).not.toHaveAttribute("data-edit-target")

    fireEvent.click(screen.getByTestId("artifact-selection-promote"))

    expect(useChatStore.getState().artifactSelections.map((s) => s.artifactId)).toEqual([
      "a2",
      "a1",
    ])
  })

  it("shows no edit-target badge for a lone selection", () => {
    act(() => useChatStore.getState().addArtifactSelection(sel()))
    render(<ArtifactSelectionChips />)
    // With nothing to choose between, the badge is noise.
    expect(screen.getByTestId("artifact-selection-chip")).not.toHaveAttribute("data-edit-target")
  })

  it("labels a whole-artifact reference as such instead of faking a line range", () => {
    // The dock tab's "reference in chat" stages lines 1..N, which rendered as
    // `(1-3)` and read like a hand-picked excerpt.
    act(() =>
      useChatStore
        .getState()
        .addArtifactSelection(sel({ snapshot: "a\nb\nc", range: { startLine: 1, endLine: 3 } }))
    )
    render(<ArtifactSelectionChips />)
    expect(screen.getByTestId("artifact-selection-chip")).toHaveTextContent(
      "selectionChipWholeLabel"
    )
  })

  it("renders bare (no container) and falls back to the label when no comment", () => {
    act(() => useChatStore.getState().addArtifactSelection(sel({ comment: "" })))
    const { container } = render(<ArtifactSelectionChips bare />)
    // Bare mode renders chips directly without the padded wrapper div.
    expect(container.querySelector(".pt-2")).toBeNull()
    expect(screen.getByTestId("artifact-selection-chip")).toBeInTheDocument()
  })
})
