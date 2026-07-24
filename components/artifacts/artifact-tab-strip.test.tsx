/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, act } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${Object.values(values).join(",")}` : key,
}))

import { ArtifactTabStrip } from "./artifact-tab-strip"
import { useArtifactStore } from "@/stores/artifact/artifact-store"

function seed(titles: string[]) {
  return titles.map((title) =>
    useArtifactStore.getState().createArtifact({
      sessionId: "s1",
      messageId: "m",
      type: "code",
      title,
      content: "x",
    })
  )
}

beforeEach(() => {
  localStorage.clear()
  act(() => {
    useArtifactStore.setState({
      artifacts: {},
      activeArtifactId: null,
      openArtifactIds: [],
      artifactVersions: {},
    })
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
    expect(useArtifactStore.getState().openArtifactIds).toEqual([first.id, second.id])
  })

  it("switches the active artifact when a tab is clicked", () => {
    const [first] = seed(["First", "Second"])
    render(<ArtifactTabStrip />)

    fireEvent.click(screen.getByTestId(`artifact-tab-${first.id}`))

    expect(useArtifactStore.getState().activeArtifactId).toBe(first.id)
  })

  it("keeps open order stable when switching, unlike the MRU recents list", () => {
    const [first, second] = seed(["First", "Second"])
    render(<ArtifactTabStrip />)

    fireEvent.click(screen.getByTestId(`artifact-tab-${first.id}`))

    // Tabs must not reshuffle under the pointer — that is what separates them
    // from `artifactWorkspace.recentArtifactIds`, which does reorder.
    expect(useArtifactStore.getState().openArtifactIds).toEqual([first.id, second.id])
    expect(useArtifactStore.getState().artifactWorkspace.recentArtifactIds[0]).toBe(first.id)
  })

  it("closing the active tab hands over to its neighbour", () => {
    const [first, second, third] = seed(["First", "Second", "Third"])
    act(() => useArtifactStore.getState().setActiveArtifact(second.id))
    render(<ArtifactTabStrip />)

    fireEvent.click(screen.getByTestId(`artifact-tab-close-${second.id}`))

    expect(useArtifactStore.getState().openArtifactIds).toEqual([first.id, third.id])
    expect(useArtifactStore.getState().activeArtifactId).toBe(third.id)
  })

  it("closing the last tab falls back to the one before it", () => {
    const [first, second] = seed(["First", "Second"])
    act(() => useArtifactStore.getState().setActiveArtifact(second.id))
    render(<ArtifactTabStrip />)

    fireEvent.click(screen.getByTestId(`artifact-tab-close-${second.id}`))

    expect(useArtifactStore.getState().activeArtifactId).toBe(first.id)
  })

  it("closing an inactive tab leaves the active artifact alone", () => {
    const [first, second] = seed(["First", "Second"])
    render(<ArtifactTabStrip />)

    fireEvent.click(screen.getByTestId(`artifact-tab-close-${first.id}`))

    expect(useArtifactStore.getState().activeArtifactId).toBe(second.id)
  })

  it("middle-click closes a tab (browser/editor convention)", () => {
    const [first, second] = seed(["First", "Second"])
    render(<ArtifactTabStrip />)

    fireEvent(
      screen.getByTestId(`artifact-tab-${first.id}`),
      new MouseEvent("auxclick", { bubbles: true, button: 1 })
    )

    expect(useArtifactStore.getState().openArtifactIds).toEqual([second.id])
  })

  it("non-middle aux clicks leave the tab alone", () => {
    const [first, second] = seed(["First", "Second"])
    render(<ArtifactTabStrip />)

    fireEvent(
      screen.getByTestId(`artifact-tab-${first.id}`),
      new MouseEvent("auxclick", { bubbles: true, button: 2 })
    )

    expect(useArtifactStore.getState().openArtifactIds).toEqual([first.id, second.id])
  })

  it("drag-reorders tabs without touching the MRU recents list", () => {
    const [first, second, third] = seed(["First", "Second", "Third"])
    const recentsBefore = useArtifactStore.getState().artifactWorkspace.recentArtifactIds
    render(<ArtifactTabStrip />)

    fireEvent.dragStart(screen.getByTestId(`artifact-tab-item-${first.id}`), {
      dataTransfer: { effectAllowed: "" },
    })
    fireEvent.drop(screen.getByTestId(`artifact-tab-item-${third.id}`))

    expect(useArtifactStore.getState().openArtifactIds).toEqual([second.id, third.id, first.id])
    expect(useArtifactStore.getState().artifactWorkspace.recentArtifactIds).toEqual(recentsBefore)
  })

  it("ignores ids whose artifact no longer exists", () => {
    const [first, second] = seed(["First", "Second"])
    // The persist layer evicts artifacts under an LRU cap while the tab id list
    // survives, so a dangling id must not render an undefined title.
    act(() =>
      useArtifactStore.setState((state) => ({
        artifacts: { [second.id]: state.artifacts[second.id] },
        openArtifactIds: [first.id, second.id],
      }))
    )

    const { container } = render(<ArtifactTabStrip />)

    expect(container.firstChild).toBeNull()
  })
})
