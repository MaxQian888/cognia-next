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
  kind: "artifact" as const,
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
      useChatStore.getState().addContextSelection(sel({ title: "one" }))
      useChatStore.getState().addContextSelection(sel({ title: "two" }))
    })
    render(<ArtifactSelectionChips />)
    expect(screen.getAllByTestId("artifact-selection-chip")).toHaveLength(2)
  })

  it("removes a chip via its remove button", () => {
    act(() => useChatStore.getState().addContextSelection(sel()))
    render(<ArtifactSelectionChips />)
    fireEvent.click(screen.getByRole("button"))
    expect(useChatStore.getState().contextSelections).toHaveLength(0)
  })

  it("marks the lead chip as the edit target and promotes another on click", () => {
    act(() => {
      useChatStore.getState().addContextSelection(sel({ title: "one", artifactId: "a1" }))
      useChatStore.getState().addContextSelection(sel({ title: "two", artifactId: "a2" }))
    })
    render(<ArtifactSelectionChips />)

    // Only the first selection becomes the send's edit target. Every chip used
    // to look identical, so the other artifact silently could never receive a
    // revision proposal — the drop was recorded in a `debug` log alone.
    const chips = screen.getAllByTestId("artifact-selection-chip")
    expect(chips[0]).toHaveAttribute("data-edit-target", "true")
    expect(chips[1]).not.toHaveAttribute("data-edit-target")

    fireEvent.click(screen.getByTestId("artifact-selection-promote"))

    expect(
      useChatStore
        .getState()
        .contextSelections.map((s) => (s.kind === "artifact" ? s.artifactId : s.kind))
    ).toEqual(["a2", "a1"])
  })

  it("shows no edit-target badge for a lone selection", () => {
    act(() => useChatStore.getState().addContextSelection(sel()))
    render(<ArtifactSelectionChips />)
    // With nothing to choose between, the badge is noise.
    expect(screen.getByTestId("artifact-selection-chip")).not.toHaveAttribute("data-edit-target")
  })

  // A revision proposal needs an artifact to diff against, so the other kinds
  // ride along as context only. Offering them the badge or the promote control
  // would promise a round trip that cannot happen.
  it("never offers the edit target to a non-artifact selection", () => {
    act(() => {
      useChatStore.getState().addContextSelection({
        kind: "file",
        relPath: "src/router.ts",
        title: "router.ts",
        snapshot: "export function route() {}",
        comment: "",
      })
      useChatStore.getState().addContextSelection(sel({ artifactId: "a1" }))
    })
    render(<ArtifactSelectionChips />)

    const chips = screen.getAllByTestId("artifact-selection-chip")
    expect(chips[0]).toHaveAttribute("data-selection-kind", "file")
    expect(chips[1]).toHaveAttribute("data-selection-kind", "artifact")
    // One artifact staged: unambiguous, so no badge on anything — and above all
    // the file chip (index 0) must not claim it.
    expect(chips[0]).not.toHaveAttribute("data-edit-target")
    expect(screen.queryByTestId("artifact-selection-promote")).toBeNull()
  })

  it("badges the first artifact even when a file chip is staged ahead of it", () => {
    act(() => {
      useChatStore.getState().addContextSelection({
        kind: "web",
        url: "https://example.com/docs",
        title: "Docs",
        snapshot: "…",
        comment: "",
      })
      useChatStore.getState().addContextSelection(sel({ artifactId: "a1" }))
      useChatStore.getState().addContextSelection(sel({ artifactId: "a2" }))
    })
    render(<ArtifactSelectionChips />)

    const chips = screen.getAllByTestId("artifact-selection-chip")
    expect(chips[0]).not.toHaveAttribute("data-edit-target")
    expect(chips[1]).toHaveAttribute("data-edit-target", "true")
    expect(chips[2]).not.toHaveAttribute("data-edit-target")
    // Only the trailing artifact can be promoted — the web chip cannot.
    expect(screen.getAllByTestId("artifact-selection-promote")).toHaveLength(1)
  })

  it("labels a whole-artifact reference as such instead of faking a line range", () => {
    // The dock tab's "reference in chat" stages lines 1..N, which rendered as
    // `(1-3)` and read like a hand-picked excerpt.
    act(() =>
      useChatStore
        .getState()
        .addContextSelection(sel({ snapshot: "a\nb\nc", range: { startLine: 1, endLine: 3 } }))
    )
    render(<ArtifactSelectionChips />)
    expect(screen.getByTestId("artifact-selection-chip")).toHaveTextContent(
      "selectionChipWholeLabel"
    )
  })

  it("labels a system selection with both source app and window title", () => {
    act(() =>
      useChatStore.getState().addContextSelection({
        kind: "external",
        candidateId: "candidate-1",
        sourceApp: "TextEdit",
        sourceTitle: "Draft",
        origin: "accessibility",
        truncated: false,
        title: "Draft",
        snapshot: "selected text",
        comment: "",
      })
    )
    render(<ArtifactSelectionChips />)
    expect(screen.getByTestId("artifact-selection-chip")).toHaveTextContent(
      "selectionChipExternalLabel"
    )
  })

  it("marks a truncated system selection in its chip", () => {
    act(() =>
      useChatStore.getState().addContextSelection({
        kind: "external",
        candidateId: "candidate-2",
        sourceApp: "TextEdit",
        sourceTitle: "Large draft",
        origin: "accessibility",
        truncated: true,
        title: "Large draft",
        snapshot: "selected text",
        comment: "",
      })
    )
    render(<ArtifactSelectionChips />)
    expect(screen.getByTestId("artifact-selection-chip")).toHaveTextContent(
      "selectionChipExternalTruncatedLabel"
    )
  })

  it("attributes a plugin selection to the plugin's own source label", () => {
    act(() =>
      useChatStore.getState().addContextSelection({
        kind: "plugin",
        pluginId: "cognia-repowiki",
        sourceLabel: "wiki page",
        title: "Plugin runtime",
        snapshot: "body",
        comment: "",
        ref: "wiki:repo#runtime",
      })
    )
    render(<ArtifactSelectionChips />)
    const chip = screen.getByTestId("artifact-selection-chip")
    expect(chip).toHaveAttribute("data-selection-kind", "plugin")
    expect(chip).toHaveTextContent("selectionChipPluginLabel")
  })

  it("renders bare (no container) and falls back to the label when no comment", () => {
    act(() => useChatStore.getState().addContextSelection(sel({ comment: "" })))
    const { container } = render(<ArtifactSelectionChips bare />)
    // Bare mode renders chips directly without the padded wrapper div.
    expect(container.querySelector(".pt-2")).toBeNull()
    expect(screen.getByTestId("artifact-selection-chip")).toBeInTheDocument()
  })
})
