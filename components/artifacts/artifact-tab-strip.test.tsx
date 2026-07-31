/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, act } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${Object.values(values).join(",")}` : key,
}))

jest.mock("sonner", () => ({ toast: { error: jest.fn() } }))

import { toast } from "sonner"
import { ArtifactTabStrip } from "./artifact-tab-strip"
import {
  selectActiveArtifactId,
  selectOpenArtifactIds,
  useArtifactStore,
} from "@/stores/artifact/artifact-store"
import { useChatStore } from "@/stores/chat"
import { useChatViewportStore } from "@/stores/chat/chat-viewport-store"

const SESSION = "s1"

function seed(titles: string[]) {
  return titles.map((title) =>
    useArtifactStore.getState().createArtifact({
      sessionId: SESSION,
      messageId: "m",
      type: "code",
      title,
      content: "x",
    })
  )
}

/** Tabs and the active id are bucketed per conversation. */
const openTabs = () => selectOpenArtifactIds(useArtifactStore.getState(), SESSION)
const activeTab = () => selectActiveArtifactId(useArtifactStore.getState(), SESSION)

beforeEach(() => {
  jest.clearAllMocks()
  localStorage.clear()
  act(() => {
    useArtifactStore.setState({
      artifacts: {},
      activeArtifactIdBySession: {},
      openArtifactIdsBySession: {},
      artifactVersions: {},
    })
    useChatViewportStore.setState({ activeTurnMessageIds: [], jumpToMessage: null })
    useChatStore.setState({ activeSessionId: SESSION, contextSelections: [] })
  })
})

describe("ArtifactTabStrip", () => {
  it("stays out of the way until a second artifact is open", () => {
    seed(["Only"])
    const { container } = render(<ArtifactTabStrip />)

    // A lone tab is just a label for the panel already on screen; the header
    // in a ~34% wide dock cannot spare a row for it.
    expect(container.firstChild).toBeNull()
  })

  it("lists open artifacts and marks the active one", () => {
    const [first, second] = seed(["First", "Second"])
    render(<ArtifactTabStrip />)

    expect(screen.getByRole("tab", { name: /Second/ })).toHaveAttribute("aria-selected", "true")
    expect(screen.getByRole("tab", { name: /First/ })).toHaveAttribute("aria-selected", "false")
    expect(openTabs()).toEqual([first.id, second.id])
  })

  it("switches the active artifact when a tab is clicked", () => {
    const [first] = seed(["First", "Second"])
    render(<ArtifactTabStrip />)

    fireEvent.click(screen.getByTestId(`artifact-tab-${first.id}`))

    expect(activeTab()).toBe(first.id)
  })

  it("keeps open order stable when switching, unlike the MRU recents list", () => {
    const [first, second] = seed(["First", "Second"])
    render(<ArtifactTabStrip />)

    fireEvent.click(screen.getByTestId(`artifact-tab-${first.id}`))

    // Tabs must not reshuffle under the pointer — that is what separates them
    // from `artifactWorkspace.recentArtifactIds`, which does reorder.
    expect(openTabs()).toEqual([first.id, second.id])
    expect(useArtifactStore.getState().artifactWorkspace.recentArtifactIds[0]).toBe(first.id)
  })

  it("closing the active tab hands over to its neighbour", () => {
    const [first, second, third] = seed(["First", "Second", "Third"])
    act(() => useArtifactStore.getState().setActiveArtifact(second.id))
    render(<ArtifactTabStrip />)

    fireEvent.click(screen.getByTestId(`artifact-tab-close-${second.id}`))

    expect(openTabs()).toEqual([first.id, third.id])
    expect(activeTab()).toBe(third.id)
  })

  it("closing the last tab falls back to the one before it", () => {
    const [first, second] = seed(["First", "Second"])
    act(() => useArtifactStore.getState().setActiveArtifact(second.id))
    render(<ArtifactTabStrip />)

    fireEvent.click(screen.getByTestId(`artifact-tab-close-${second.id}`))

    expect(activeTab()).toBe(first.id)
  })

  it("closing an inactive tab leaves the active artifact alone", () => {
    const [first, second] = seed(["First", "Second"])
    render(<ArtifactTabStrip />)

    fireEvent.click(screen.getByTestId(`artifact-tab-close-${first.id}`))

    expect(activeTab()).toBe(second.id)
  })

  it("middle-click closes a tab (browser/editor convention)", () => {
    const [first, second] = seed(["First", "Second"])
    render(<ArtifactTabStrip />)

    fireEvent(
      screen.getByTestId(`artifact-tab-${first.id}`),
      new MouseEvent("auxclick", { bubbles: true, button: 1 })
    )

    expect(openTabs()).toEqual([second.id])
  })

  it("non-middle aux clicks leave the tab alone", () => {
    const [first, second] = seed(["First", "Second"])
    render(<ArtifactTabStrip />)

    fireEvent(
      screen.getByTestId(`artifact-tab-${first.id}`),
      new MouseEvent("auxclick", { bubbles: true, button: 2 })
    )

    expect(openTabs()).toEqual([first.id, second.id])
  })

  it("drag-reorders tabs without touching the MRU recents list", () => {
    const [first, second, third] = seed(["First", "Second", "Third"])
    const recentsBefore = useArtifactStore.getState().artifactWorkspace.recentArtifactIds
    render(<ArtifactTabStrip />)

    fireEvent.dragStart(screen.getByTestId(`artifact-tab-item-${first.id}`), {
      dataTransfer: { effectAllowed: "" },
    })
    fireEvent.drop(screen.getByTestId(`artifact-tab-item-${third.id}`))

    expect(openTabs()).toEqual([second.id, third.id, first.id])
    expect(useArtifactStore.getState().artifactWorkspace.recentArtifactIds).toEqual(recentsBefore)
  })

  it("accepts a drop only over a different tab, and forgets the drag when it ends", () => {
    const [first, second] = seed(["First", "Second"])
    render(<ArtifactTabStrip />)
    const source = screen.getByTestId(`artifact-tab-item-${first.id}`)
    const target = screen.getByTestId(`artifact-tab-item-${second.id}`)

    fireEvent.dragStart(source, { dataTransfer: { effectAllowed: "" } })
    // The browser refuses a drop unless dragover is prevented, and preventing
    // it over the dragged tab itself would advertise a no-op reorder.
    expect(fireEvent.dragOver(target)).toBe(false)
    expect(fireEvent.dragOver(source)).toBe(true)

    fireEvent.dragEnd(source)
    // Drag state must clear on a cancelled drag, or the next drop over any tab
    // would reorder using a stale source.
    fireEvent.drop(target)
    expect(openTabs()).toEqual([first.id, second.id])
  })

  it("ignores ids whose artifact no longer exists", () => {
    const [first, second] = seed(["First", "Second"])
    // The persist layer evicts artifacts under an LRU cap while the tab id list
    // survives, so a dangling id must not render an undefined title.
    act(() =>
      useArtifactStore.setState((state) => ({
        artifacts: { [second.id]: state.artifacts[second.id] },
        openArtifactIdsBySession: { [SESSION]: [first.id, second.id] },
      }))
    )

    const { container } = render(<ArtifactTabStrip />)

    expect(container.firstChild).toBeNull()
  })

  describe("linkage back into the conversation", () => {
    it("marks the tab whose source turn is on screen, separately from selection", () => {
      const [first, second] = seed(["First", "Second"])
      act(() =>
        useArtifactStore.setState({
          artifacts: {
            [first.id]: { ...first, messageId: "msg-a" },
            [second.id]: { ...second, messageId: "msg-b" },
          },
          activeArtifactIdBySession: { [SESSION]: first.id },
        })
      )
      act(() => useChatViewportStore.getState().setActiveTurnMessageIds(["msg-b", "msg-b-reply"]))

      render(<ArtifactTabStrip />)

      // The tab you are reading is routinely not the one the conversation is
      // scrolled to, so these two states must be able to disagree.
      expect(screen.getByTestId(`artifact-tab-item-${second.id}`)).toHaveAttribute(
        "data-source-in-view"
      )
      expect(screen.getByTestId(`artifact-tab-item-${first.id}`)).not.toHaveAttribute(
        "data-source-in-view"
      )
    })

    it("double-clicking a tab jumps the conversation to the message behind it", () => {
      const [first] = seed(["First", "Second"])
      act(() =>
        useArtifactStore.setState((s) => ({
          artifacts: { ...s.artifacts, [first.id]: { ...first, messageId: "msg-a" } },
        }))
      )
      const jump = jest.fn(() => true)
      act(() => useChatViewportStore.getState().registerJumpToMessage(jump))

      render(<ArtifactTabStrip />)
      fireEvent.doubleClick(screen.getByTestId(`artifact-tab-${first.id}`))

      // Artifacts have always recorded their source message; nothing read it
      // back, so the chat could open the dock but the dock could not point at
      // the chat. `center` because an artifact's source is a point of interest,
      // not a place to start reading downwards from.
      expect(jump).toHaveBeenCalledWith("msg-a", undefined, { align: "center" })
      expect(toast.error).not.toHaveBeenCalled()
    })

    it("reports an unreachable source message instead of doing nothing", () => {
      const [first] = seed(["First", "Second"])
      act(() =>
        useArtifactStore.setState((s) => ({
          artifacts: { ...s.artifacts, [first.id]: { ...first, messageId: "gone" } },
        }))
      )
      // A list is mounted, but the message is not in it — compacted away, or
      // owned by a session that is no longer open.
      act(() => useChatViewportStore.getState().registerJumpToMessage(() => false))

      render(<ArtifactTabStrip />)
      fireEvent.doubleClick(screen.getByTestId(`artifact-tab-${first.id}`))

      expect(toast.error).toHaveBeenCalledWith("notFound")
    })

    it("closes a tab from its context menu", () => {
      const [first, second] = seed(["First", "Second"])

      render(<ArtifactTabStrip />)
      fireEvent.contextMenu(screen.getByTestId(`artifact-tab-item-${first.id}`))
      fireEvent.click(screen.getByTestId(`artifact-tab-close-item-${first.id}`))

      expect(openTabs()).toEqual([second.id])
    })

    it("disables the source jump when no message list is registered", () => {
      const [first] = seed(["First", "Second"])

      render(<ArtifactTabStrip />)
      fireEvent.contextMenu(screen.getByTestId(`artifact-tab-item-${first.id}`))

      expect(screen.getByTestId(`artifact-tab-source-${first.id}`)).toHaveAttribute(
        "aria-disabled",
        "true"
      )
    })

    it("stages a whole artifact as a conversation reference", () => {
      const [first] = seed(["First", "Second"])
      act(() =>
        useArtifactStore.setState((s) => ({
          artifacts: { ...s.artifacts, [first.id]: { ...first, content: "line1\nline2" } },
        }))
      )

      render(<ArtifactTabStrip />)
      fireEvent.contextMenu(screen.getByTestId(`artifact-tab-item-${first.id}`))
      fireEvent.click(screen.getByTestId(`artifact-tab-reference-${first.id}`))

      // Reuses the selection pipeline the composer already renders chips for
      // and folds into the prompt — only sub-ranges could be referenced before.
      expect(useChatStore.getState().contextSelections).toEqual([
        {
          kind: "artifact",
          artifactId: first.id,
          title: "First",
          snapshot: "line1\nline2",
          comment: "",
          range: { startLine: 1, endLine: 2 },
        },
      ])
    })
  })
})
