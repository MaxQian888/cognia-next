/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, act } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// Only this one hook matters here; the store's own create path calls others, so
// hand back a no-op for anything else rather than blanking the module. The spy
// is built inside the factory — jest hoists this above any `const`, so a
// module-scope one would be in its TDZ when the factory runs.
jest.mock("@/lib/plugin", () => {
  const hooks = new Proxy({ dispatchContextMenuShow: jest.fn() } as Record<string, unknown>, {
    get: (target: Record<string, unknown>, key: string) =>
      key in target ? target[key] : () => Promise.resolve(),
  })
  return { getPluginEventHooks: () => hooks }
})

// Radix menus open on pointer events jsdom does not deliver, so the row's
// context menu is unreachable through `fireEvent`. Flatten the primitives so
// the items render inline and stay directly clickable — the repo's established
// pattern (see components/agent/mode/runtime-selector.test.tsx).
jest.mock("@/components/ui/context-menu", () => {
  const React = jest.requireActual("react")
  type Props = { children?: React.ReactNode; onOpenChange?: (open: boolean) => void }
  return {
    ContextMenu: ({ children, onOpenChange }: Props) => (
      <div>
        <button type="button" data-testid="open-context-menu" onClick={() => onOpenChange?.(true)}>
          context
        </button>
        {children}
      </div>
    ),
    ContextMenuTrigger: ({ children }: Props) => <>{children}</>,
    ContextMenuContent: ({ children }: Props) => <div>{children}</div>,
    ContextMenuItem: ({ children, onClick }: Props & { onClick?: (event: unknown) => void }) => (
      <button type="button" onClick={onClick}>
        {children}
      </button>
    ),
  }
})

import { ArtifactList, ArtifactListCompact } from "./artifact-list"
import { getPluginEventHooks } from "@/lib/plugin"
import { selectActiveArtifactId, useArtifactStore } from "@/stores/artifact/artifact-store"
import { useChatStore } from "@/stores/chat"
import { useSettingsStore } from "@/stores/settings"

beforeEach(() => {
  localStorage.clear()
  useArtifactStore.setState({
    artifacts: {},
    activeArtifactIdBySession: {},
    artifactVersions: {},
    artifactWorkspace: {
      scope: "session",
      sessionId: null,
      searchQuery: "",
      typeFilter: "all",
      runtimeFilter: "all",
      recentArtifactIds: [],
      returnContext: null,
    },
    canvasDocuments: {},
    activeCanvasId: null,
    panelOpen: false,
    panelView: "artifact",
  })
  useChatStore.setState({ activeSessionId: "s1", status: "idle", messages: [] })
  useSettingsStore.setState({ settings: { artifacts: {} } } as never)
})

/** Put the chat into a streaming turn with an open, artifact-sized fence. */
function streamAnArtifact() {
  useChatStore.setState({
    status: "streaming",
    messages: [
      {
        id: "m1",
        role: "assistant",
        parts: [
          {
            type: "text",
            text:
              "Sure:\n\n```python\n" +
              Array.from({ length: 12 }, (_, index) => `print(${index})`).join("\n"),
          },
        ],
      },
    ] as never,
  })
}

const dispatchContextMenuShow = getPluginEventHooks()
  .dispatchContextMenuShow as unknown as jest.Mock

describe("ArtifactList", () => {
  it("renders the empty state when no artifacts exist", () => {
    render(<ArtifactList />)
    expect(screen.getByText("noArtifacts")).toBeInTheDocument()
  })

  it("renders a list item for each session artifact", () => {
    useArtifactStore.getState().createArtifact({
      sessionId: "s1",
      messageId: "m",
      type: "code",
      title: "Foo",
      content: "x",
    })
    render(<ArtifactList />)
    expect(screen.getByText("Foo")).toBeInTheDocument()
  })

  it("clicking an item activates the artifact", () => {
    const a = useArtifactStore.getState().createArtifact({
      sessionId: "s1",
      messageId: "m",
      type: "code",
      title: "Foo",
      content: "x",
    })
    render(<ArtifactList />)
    fireEvent.click(screen.getByTestId(`artifact-list-item-${a.id}`))
    expect(selectActiveArtifactId(useArtifactStore.getState(), "s1")).toBe(a.id)
  })

  it("typing in the search box updates the filter", () => {
    useArtifactStore.getState().createArtifact({
      sessionId: "s1",
      messageId: "m",
      type: "code",
      title: "Foo",
      content: "x",
    })
    render(<ArtifactList />)
    const input = screen.getByPlaceholderText("search")
    fireEvent.change(input, { target: { value: "alpha" } })
    expect(useArtifactStore.getState().artifactWorkspace.searchQuery).toBe("alpha")
  })

  it("typing in the search box actually filters the rendered list", () => {
    // The store-level assertion above only proves the value landed. The list
    // itself is what the user judges the filter by.
    const keep = useArtifactStore.getState().createArtifact({
      sessionId: "s1",
      messageId: "m",
      type: "code",
      title: "Alpha",
      content: "x",
    })
    const drop = useArtifactStore.getState().createArtifact({
      sessionId: "s1",
      messageId: "m",
      type: "code",
      title: "Beta",
      content: "y",
    })
    render(<ArtifactList />)
    expect(screen.getByTestId(`artifact-list-item-${drop.id}`)).toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText("search"), { target: { value: "Alpha" } })

    expect(screen.getByTestId(`artifact-list-item-${keep.id}`)).toBeInTheDocument()
    expect(screen.queryByTestId(`artifact-list-item-${drop.id}`)).toBeNull()
  })

  it("switches to the cross-session recent scope", () => {
    // `recentArtifactIds` was maintained in eight places and read by a store
    // branch no control could select.
    const other = useArtifactStore.getState().createArtifact({
      sessionId: "s2",
      messageId: "m",
      type: "code",
      title: "FromAnotherChat",
      content: "x",
    })
    // setActiveArtifact is what pushes an id onto the MRU list.
    act(() => useArtifactStore.getState().setActiveArtifact(other.id))
    const { rerender } = render(<ArtifactList sessionId="s1" />)
    // The switcher has to be reachable even though this session is empty —
    // that is exactly when a user wants to widen the scope.
    expect(screen.getByTestId("scope-filter-select")).toBeInTheDocument()
    expect(screen.queryByTestId(`artifact-list-item-${other.id}`)).toBeNull()

    // Driven through the store rather than the Radix trigger: jsdom does not
    // render Select options with role="option", so clicking them is untestable
    // here — the other filter tests in this file take the same route.
    act(() => useArtifactStore.getState().setArtifactWorkspaceScope("recent", null))
    rerender(<ArtifactList sessionId="s1" />)

    expect(screen.getByTestId(`artifact-list-item-${other.id}`)).toBeInTheDocument()
  })

  it("keeps the filter row on screen when a filter empties the list", () => {
    // The empty state replaces the row that produced it, so a user who filtered
    // down to nothing had no way back.
    useArtifactStore.getState().createArtifact({
      sessionId: "s1",
      messageId: "m",
      type: "code",
      title: "Foo",
      content: "x",
    })
    render(<ArtifactList sessionId="s1" />)

    fireEvent.change(screen.getByPlaceholderText("search"), { target: { value: "zzz-no-match" } })

    expect(screen.queryByText("noArtifacts")).toBeNull()
    expect(screen.getByTestId("scope-filter-select")).toBeInTheDocument()
  })

  it("keeps the whole filter row reachable in a narrow container", () => {
    useArtifactStore.getState().createArtifact({
      sessionId: "s1",
      messageId: "m",
      type: "code",
      title: "Foo",
      content: "x",
    })
    render(<ArtifactList />)

    // The two filters used to carry fixed 120px/140px widths and, as flex items
    // with `min-width: auto`, refused to shrink — so at the dock's narrowest the
    // row overflowed and `overflow-hidden` clipped the batch button away. They
    // now collapse to icon triggers via a container query.
    const typeTrigger = screen.getByTestId("type-filter-select")
    expect(typeTrigger.className).toContain("w-8")
    expect(typeTrigger.className).toContain("shrink-0")
    expect(typeTrigger.className).not.toContain("w-[120px] ")
    expect(screen.getByRole("button", { name: "batchSelect" })).toBeInTheDocument()
  })

  it("marks a narrowed filter as active while its label is hidden", () => {
    useArtifactStore.getState().createArtifact({
      sessionId: "s1",
      messageId: "m",
      type: "code",
      title: "Foo",
      content: "x",
    })
    const { rerender } = render(<ArtifactList />)
    const dotSelector = "[data-testid='type-filter-select'] span[aria-hidden]"
    expect(document.querySelector(dotSelector)).toBeNull()

    act(() => useArtifactStore.getState().setArtifactWorkspaceFilters({ typeFilter: "code" }))
    rerender(<ArtifactList />)

    // The compact trigger hides the label, so an applied filter would otherwise
    // be invisible — the list looks arbitrarily short with no explanation.
    expect(document.querySelector(dotSelector)).not.toBeNull()
  })

  it("announces an opened row context menu to plugins", () => {
    const a = useArtifactStore.getState().createArtifact({
      sessionId: "s1",
      messageId: "m",
      type: "code",
      title: "Foo",
      content: "x",
    })
    render(<ArtifactList />)

    fireEvent.click(screen.getByTestId("open-context-menu"))

    expect(dispatchContextMenuShow).toHaveBeenCalledWith({
      type: "artifact-list",
      target: { artifactId: a.id, artifactType: "code" },
    })
  })

  it("opens an artifact from its context menu", () => {
    const a = useArtifactStore.getState().createArtifact({
      sessionId: "s1",
      messageId: "m",
      type: "code",
      title: "Foo",
      content: "x",
    })
    render(<ArtifactList />)

    fireEvent.click(screen.getByRole("button", { name: "open" }))

    expect(selectActiveArtifactId(useArtifactStore.getState(), "s1")).toBe(a.id)
  })

  it("confirms before deleting, and only deletes on confirm", () => {
    const a = useArtifactStore.getState().createArtifact({
      sessionId: "s1",
      messageId: "m",
      type: "code",
      title: "Foo",
      content: "x",
    })
    render(<ArtifactList />)

    fireEvent.click(screen.getByRole("button", { name: "delete" }))
    expect(screen.getByText("deleteConfirmTitle")).toBeInTheDocument()
    expect(useArtifactStore.getState().artifacts[a.id]).toBeDefined()

    fireEvent.click(screen.getByRole("button", { name: "cancel" }))
    expect(useArtifactStore.getState().artifacts[a.id]).toBeDefined()

    fireEvent.click(screen.getByRole("button", { name: "delete" }))
    // Two buttons answer to "delete" once the dialog is up — the row's menu
    // item and the dialog's confirm. The confirm is the later one.
    const deleteButtons = screen.getAllByRole("button", { name: "delete" })
    fireEvent.click(deleteButtons[deleteButtons.length - 1])
    expect(useArtifactStore.getState().artifacts[a.id]).toBeUndefined()
  })

  it("marks the runtime filter as active too", () => {
    useArtifactStore.getState().createArtifact({
      sessionId: "s1",
      messageId: "m",
      type: "code",
      title: "Foo",
      content: "x",
    })
    const { rerender } = render(<ArtifactList />)
    const dot = "[data-testid='runtime-filter-select'] span[aria-hidden]"
    expect(document.querySelector(dot)).toBeNull()

    act(() => useArtifactStore.getState().setArtifactWorkspaceFilters({ runtimeFilter: "error" }))
    rerender(<ArtifactList />)

    expect(document.querySelector(dot)).not.toBeNull()
  })

  it("batch-selects rows and confirms with the batch wording", () => {
    const a = useArtifactStore.getState().createArtifact({
      sessionId: "s1",
      messageId: "m",
      type: "code",
      title: "Foo",
      content: "x",
    })
    render(<ArtifactList />)

    fireEvent.click(screen.getByRole("button", { name: "batchSelect" }))
    // Clicking a row selects rather than opens once batch mode is on — the
    // batch bar only appears when something is actually selected.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId(`artifact-list-item-${a.id}`))
    expect(screen.getByRole("alert")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: /batchDelete/ }))
    expect(screen.getByText("deleteConfirmBatchDesc")).toBeInTheDocument()
  })

  it("revives a persisted createdAt that came back as a string", () => {
    const a = useArtifactStore.getState().createArtifact({
      sessionId: "s1",
      messageId: "m",
      type: "code",
      title: "Foo",
      content: "x",
    })
    // Rehydrating from localStorage yields ISO strings, not Date instances —
    // formatDistanceToNow would throw on one.
    act(() =>
      useArtifactStore.setState((state) => ({
        artifacts: {
          ...state.artifacts,
          [a.id]: { ...state.artifacts[a.id], createdAt: a.createdAt.toISOString() as never },
        },
      }))
    )

    render(<ArtifactList />)
    expect(screen.getByText("Foo")).toBeInTheDocument()
  })

  it("shows the generating row instead of claiming there are no artifacts", () => {
    streamAnArtifact()
    render(<ArtifactList sessionId="s1" />)

    expect(screen.getByTestId("artifact-list-generating")).toBeInTheDocument()
    // "No artifacts yet" would be a lie while one is being written.
    expect(screen.queryByText("noArtifacts")).not.toBeInTheDocument()
  })

  it("shows the generating row above the artifacts already in the list", () => {
    useArtifactStore.getState().createArtifact({
      sessionId: "s1",
      messageId: "m",
      type: "code",
      title: "Foo",
      content: "x",
    })
    streamAnArtifact()
    render(<ArtifactList sessionId="s1" />)

    expect(screen.getByTestId("artifact-list-generating")).toBeInTheDocument()
    expect(screen.getByText("Foo")).toBeInTheDocument()
  })

  it("shows no generating row once the turn is idle", () => {
    render(<ArtifactList sessionId="s1" />)
    expect(screen.queryByTestId("artifact-list-generating")).not.toBeInTheDocument()
  })

  it("compact list renders nothing when empty", () => {
    const { container } = render(<ArtifactListCompact sessionId="s1" />)
    expect(container.firstChild).toBeNull()
  })

  it("compact list falls back to recent artifacts with no session", () => {
    useArtifactStore.getState().createArtifact({
      sessionId: "s1",
      messageId: "m",
      type: "code",
      title: "Recent",
      content: "x",
    })
    useChatStore.setState({ activeSessionId: null })

    render(<ArtifactListCompact />)

    expect(screen.getByText("Recent")).toBeInTheDocument()
  })

  it("compact list renders the recent artifacts", () => {
    useArtifactStore.getState().createArtifact({
      sessionId: "s1",
      messageId: "m",
      type: "code",
      title: "Foo",
      content: "x",
    })
    render(<ArtifactListCompact sessionId="s1" />)
    expect(screen.getByText("Foo")).toBeInTheDocument()
  })

  it("compact list activates an artifact and opens the panel on click", () => {
    const a = useArtifactStore.getState().createArtifact({
      sessionId: "s1",
      messageId: "m",
      type: "code",
      title: "Bar",
      content: "x",
    })
    useArtifactStore.setState({ panelOpen: false, activeArtifactIdBySession: {} })
    render(<ArtifactListCompact sessionId="s1" />)
    fireEvent.click(screen.getByText("Bar"))
    expect(selectActiveArtifactId(useArtifactStore.getState(), "s1")).toBe(a.id)
    expect(useArtifactStore.getState().panelOpen).toBe(true)
  })
})
