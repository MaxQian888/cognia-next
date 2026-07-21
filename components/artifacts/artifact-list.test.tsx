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
import { useSettingsStore } from "@/stores/settings"

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
