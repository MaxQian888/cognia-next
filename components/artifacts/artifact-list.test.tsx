/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { ArtifactList, ArtifactListCompact } from "./artifact-list"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useChatStore } from "@/stores/chat"

beforeEach(() => {
  localStorage.clear()
  useArtifactStore.setState({
    artifacts: {},
    activeArtifactId: null,
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
    canvasOpen: false,
    analysisResults: {},
    panelOpen: false,
    panelView: "artifact",
  })
  useChatStore.setState({ activeSessionId: "s1" })
})

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
    expect(useArtifactStore.getState().activeArtifactId).toBe(a.id)
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

  it("compact list renders nothing when empty", () => {
    const { container } = render(<ArtifactListCompact sessionId="s1" />)
    expect(container.firstChild).toBeNull()
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
    useArtifactStore.setState({ panelOpen: false, activeArtifactId: null })
    render(<ArtifactListCompact sessionId="s1" />)
    fireEvent.click(screen.getByText("Bar"))
    expect(useArtifactStore.getState().activeArtifactId).toBe(a.id)
    expect(useArtifactStore.getState().panelOpen).toBe(true)
  })
})
