/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, act, waitFor } from "@testing-library/react"

const buildMessageReferenceTextMock = jest.fn()
jest.mock("@/lib/chat/mentions/message-reference", () => {
  const actual = jest.requireActual("@/lib/chat/mentions/message-reference")
  return {
    ...actual,
    buildMessageReferenceText: (input: unknown) => buildMessageReferenceTextMock(input),
  }
})
const toastErrorMock = jest.fn()
jest.mock("sonner", () => ({ toast: { error: (m: string) => toastErrorMock(m) } }))

const refreshFreshnessMock = jest.fn()
jest.mock("@/lib/chat/mentions/selection-freshness", () => ({
  // Default-safe: most of this suite is about the chips, not about freshness,
  // and an unmocked call must resolve to "nothing changed" rather than
  // undefined.
  refreshSelectionFreshness: (s: readonly unknown[]) =>
    refreshFreshnessMock(s) ?? Promise.resolve({ selections: s, changed: false }),
}))
const snapshotMock = jest.fn()
const fingerprintMock = jest.fn()
jest.mock("@/lib/chat/mentions/entity-sources", () => {
  const actual = jest.requireActual("@/lib/chat/mentions/entity-sources")
  return {
    ...actual,
    getEntityMentionSource: () => ({
      entityKind: "memory",
      prefix: "memory:",
      snapshot: snapshotMock,
      fingerprint: fingerprintMock,
    }),
  }
})

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

import { ArtifactSelectionChips } from "./artifact-selection-chips"
import { ComposerSessionProvider } from "./composer-session-context"
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

  it("stages the pane's OWN selections, and removes by an index into them", () => {
    // `remove` takes an INDEX, so reading a different slice than the one being
    // written dropped whichever selection happened to sit at that index in the
    // other conversation.
    act(() => {
      useChatStore.getState().setActiveSession("ses_focused")
      useChatStore.getState().addContextSelection(sel({ title: "Focused only" }))
      useChatStore.getState().addContextSelection(sel({ title: "Background A" }), "ses_background")
      useChatStore.getState().addContextSelection(sel({ title: "Background B" }), "ses_background")
    })

    render(
      <ComposerSessionProvider value="ses_background">
        <ArtifactSelectionChips />
      </ComposerSessionProvider>
    )
    const chips = screen.getAllByTestId("artifact-selection-chip")
    expect(chips).toHaveLength(2)

    fireEvent.click(screen.getByRole("button", { name: /removeSelectionAria.*Background A/ }))
    const state = useChatStore.getState()
    expect(state.sessions["ses_background"]?.contextSelections.map((c) => c.title)).toEqual([
      "Background B",
    ])
    expect(state.contextSelections.map((c) => c.title)).toEqual(["Focused only"])
  })
})

describe("entity chips", () => {
  const entity = (over = {}) => ({
    kind: "entity" as const,
    entityKind: "issue" as const,
    entityId: "iss_1",
    title: "Fix the broker race",
    subtitle: "COG-14 · in_progress",
    snapshot: "body",
    comment: "",
    capturedAt: 1_000,
    ...over,
  })

  it("labels the chip with the localized kind noun and the record's own title", () => {
    act(() => useChatStore.getState().addContextSelection(entity()))
    render(
      <ComposerSessionProvider sessionId={null}>
        <ArtifactSelectionChips />
      </ComposerSessionProvider>
    )
    // The kind is translated; the title is the user's own text and is not.
    expect(screen.getByText(/selectionChipEntityLabel/)).toHaveTextContent("Fix the broker race")
    expect(screen.getByText(/selectionChipEntityLabel/)).toHaveTextContent("issue")
  })

  it("renders one chip per referenced record", () => {
    act(() => {
      useChatStore.getState().addContextSelection(entity())
      useChatStore
        .getState()
        .addContextSelection(
          entity({ entityKind: "memory", entityId: "m1", title: "Prefers pnpm" })
        )
    })
    render(
      <ComposerSessionProvider sessionId={null}>
        <ArtifactSelectionChips />
      </ComposerSessionProvider>
    )
    expect(screen.getAllByText(/selectionChipEntityLabel/)).toHaveLength(2)
  })

  it("keeps two records of different kinds apart even when their ids collide", () => {
    // The React key is `entity:<kind>:<id>` — ids are only unique within a kind.
    act(() => {
      useChatStore.getState().addContextSelection(entity({ entityKind: "issue", entityId: "x" }))
      useChatStore.getState().addContextSelection(entity({ entityKind: "plan", entityId: "x" }))
    })
    render(
      <ComposerSessionProvider sessionId={null}>
        <ArtifactSelectionChips />
      </ComposerSessionProvider>
    )
    expect(screen.getAllByText(/selectionChipEntityLabel/)).toHaveLength(2)
  })

  it("never claims an entity chip is the artifact edit target", () => {
    // Only an artifact can receive a revision proposal; a staged record has
    // nothing for the hunks to diff against.
    act(() => {
      useChatStore.getState().addContextSelection(entity())
      useChatStore.getState().addContextSelection(sel())
      useChatStore.getState().addContextSelection(sel({ artifactId: "a2" }))
    })
    render(
      <ComposerSessionProvider sessionId={null}>
        <ArtifactSelectionChips />
      </ComposerSessionProvider>
    )
    const badges = screen.getAllByText(/editTargetBadge/)
    expect(badges).toHaveLength(1)
  })
})

describe("message span control", () => {
  const msgSel = (over = {}) => ({
    kind: "entity" as const,
    entityKind: "message" as const,
    entityId: "s1#m1",
    capturedAt: 1_000,
    title: "Restacking",
    snapshot: "assistant: run /stack restack",
    comment: "",
    ...over,
  })

  beforeEach(() => {
    buildMessageReferenceTextMock.mockReset()
    toastErrorMock.mockReset()
    buildMessageReferenceTextMock.mockResolvedValue("user: before\n\nassistant: anchor")
  })

  // Only a message reference has neighbours to reach for.
  it("offers the control on a message chip and on nothing else", () => {
    act(() => {
      useChatStore.getState().addContextSelection(msgSel())
      useChatStore
        .getState()
        .addContextSelection(msgSel({ entityKind: "memory", entityId: "mem1" }))
    })
    render(<ArtifactSelectionChips />)
    expect(screen.getAllByTestId("context-selection-widen")).toHaveLength(1)
  })

  it("widens both sides by one and re-reads the body", async () => {
    act(() => useChatStore.getState().addContextSelection(msgSel()))
    render(<ArtifactSelectionChips />)
    fireEvent.click(screen.getByTestId("context-selection-widen"))
    await waitFor(() =>
      expect(useChatStore.getState().contextSelections[0].span).toEqual({ before: 1, after: 1 })
    )
    expect(buildMessageReferenceTextMock).toHaveBeenCalledWith({
      sessionId: "s1",
      messageId: "m1",
      span: { before: 1, after: 1 },
    })
    expect(useChatStore.getState().contextSelections[0].snapshot).toContain("assistant: anchor")
  })

  // A body carrying someone else's tool output must keep its preamble when it
  // is rebuilt, not only when it is first staged.
  it("re-wraps the widened body as untrusted content", async () => {
    act(() => useChatStore.getState().addContextSelection(msgSel()))
    render(<ArtifactSelectionChips />)
    fireEvent.click(screen.getByTestId("context-selection-widen"))
    await waitFor(() =>
      expect(useChatStore.getState().contextSelections[0].snapshot).not.toBe(
        "user: before\n\nassistant: anchor"
      )
    )
  })

  it("stops offering the control once the span is at its ceiling", () => {
    act(() =>
      useChatStore.getState().addContextSelection(msgSel({ span: { before: 10, after: 10 } }))
    )
    render(<ArtifactSelectionChips />)
    expect(screen.queryByTestId("context-selection-widen")).toBeNull()
  })

  // A chip that silently kept its old, narrower body while claiming a wider
  // span is the failure this guards.
  it("says so and leaves the chip alone when the message is gone", async () => {
    buildMessageReferenceTextMock.mockResolvedValue(null)
    act(() => useChatStore.getState().addContextSelection(msgSel()))
    render(<ArtifactSelectionChips />)
    fireEvent.click(screen.getByTestId("context-selection-widen"))
    await waitFor(() => expect(toastErrorMock).toHaveBeenCalled())
    expect(useChatStore.getState().contextSelections[0].span).toBeUndefined()
    expect(useChatStore.getState().contextSelections[0].snapshot).toBe(
      "assistant: run /stack restack"
    )
  })

  it("counts the turns in the label once widened", () => {
    act(() =>
      useChatStore.getState().addContextSelection(msgSel({ span: { before: 2, after: 1 } }))
    )
    render(<ArtifactSelectionChips />)
    expect(screen.getByTestId("artifact-selection-chip").textContent).toContain(
      "selectionChipMessageSpanLabel"
    )
    expect(screen.getByTestId("artifact-selection-chip").textContent).toContain('"count":4')
  })
})

describe("stale snapshots", () => {
  const staleSel = (over = {}) => ({
    kind: "entity" as const,
    entityKind: "memory" as const,
    entityId: "mem1",
    title: "Prefers pnpm",
    snapshot: "the approved body",
    comment: "",
    capturedAt: 1_000,
    fingerprint: "v1",
    ...over,
  })

  beforeEach(() => {
    refreshFreshnessMock.mockReset().mockResolvedValue({ selections: [], changed: false })
    snapshotMock.mockReset().mockResolvedValue("fresh body")
    fingerprintMock.mockReset().mockResolvedValue("v2")
    toastErrorMock.mockReset()
  })

  it("shows no refresh control on a chip that still matches", () => {
    act(() => useChatStore.getState().addContextSelection(staleSel()))
    render(<ArtifactSelectionChips />)
    expect(screen.queryByTestId("context-selection-refresh")).toBeNull()
  })

  it("offers a refresh control once the chip is marked stale", () => {
    act(() => useChatStore.getState().addContextSelection(staleSel({ stale: true })))
    render(<ArtifactSelectionChips />)
    expect(screen.getByTestId("context-selection-refresh")).toBeInTheDocument()
    expect(screen.getByTestId("artifact-selection-chip")).toHaveAttribute("data-stale", "true")
  })

  // Two moments a chip can go stale without this pane hearing about it: the
  // record was edited in another window, or on another surface of this one.
  it("re-checks on mount and again when the window regains focus", async () => {
    act(() => useChatStore.getState().addContextSelection(staleSel()))
    render(<ArtifactSelectionChips />)
    await waitFor(() => expect(refreshFreshnessMock).toHaveBeenCalledTimes(1))
    act(() => {
      window.dispatchEvent(new Event("focus"))
    })
    await waitFor(() => expect(refreshFreshnessMock).toHaveBeenCalledTimes(2))
  })

  it("writes back only the selections whose staleness actually flipped", async () => {
    act(() => useChatStore.getState().addContextSelection(staleSel()))
    const staged = useChatStore.getState().contextSelections
    refreshFreshnessMock.mockResolvedValue({
      selections: [{ ...staged[0], stale: true }],
      changed: true,
    })
    render(<ArtifactSelectionChips />)
    await waitFor(() =>
      expect((useChatStore.getState().contextSelections[0] as { stale?: boolean }).stale).toBe(true)
    )
  })

  it("re-reads the body and the fingerprint when refresh is clicked", async () => {
    act(() => useChatStore.getState().addContextSelection(staleSel({ stale: true })))
    render(<ArtifactSelectionChips />)
    fireEvent.click(screen.getByTestId("context-selection-refresh"))
    await waitFor(() =>
      expect(useChatStore.getState().contextSelections[0].snapshot).toContain("fresh body")
    )
    const next = useChatStore.getState().contextSelections[0] as {
      fingerprint?: string
      stale?: boolean
    }
    expect(next.fingerprint).toBe("v2")
    expect(next.stale).toBeUndefined()
  })

  // Neither is a property of the source, so neither is the source's to discard.
  it("keeps the user's comment and their chosen span across a refresh", async () => {
    act(() =>
      useChatStore
        .getState()
        .addContextSelection(
          staleSel({ stale: true, comment: "check this", span: { before: 1, after: 1 } })
        )
    )
    render(<ArtifactSelectionChips />)
    fireEvent.click(screen.getByTestId("context-selection-refresh"))
    await waitFor(() =>
      expect(useChatStore.getState().contextSelections[0].snapshot).toContain("fresh body")
    )
    expect(useChatStore.getState().contextSelections[0].comment).toBe("check this")
    expect(useChatStore.getState().contextSelections[0].span).toEqual({ before: 1, after: 1 })
  })

  // Gone, not merely changed. Leaving the old body and saying so beats
  // replacing it with nothing.
  it("keeps the existing copy when the record can no longer be read", async () => {
    snapshotMock.mockResolvedValue(null)
    act(() => useChatStore.getState().addContextSelection(staleSel({ stale: true })))
    render(<ArtifactSelectionChips />)
    fireEvent.click(screen.getByTestId("context-selection-refresh"))
    await waitFor(() => expect(toastErrorMock).toHaveBeenCalled())
    expect(useChatStore.getState().contextSelections[0].snapshot).toBe("the approved body")
  })
})
