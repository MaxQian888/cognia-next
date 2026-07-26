/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { PanelVersionHistory } from "./panel-version-history"
import { useArtifactStore } from "@/stores/artifact/artifact-store"

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
})

function makeArtifact() {
  return useArtifactStore.getState().createArtifact({
    sessionId: "s",
    messageId: "m",
    type: "code",
    title: "T",
    content: "v1",
  })
}

describe("PanelVersionHistory", () => {
  it("shows the empty state when no versions exist", () => {
    const a = makeArtifact()
    render(<PanelVersionHistory artifact={a} />)
    expect(screen.getByText("noVersions")).toBeInTheDocument()
  })

  it("saves a new version when 'Save Version' is clicked", () => {
    const a = makeArtifact()
    render(<PanelVersionHistory artifact={a} />)
    fireEvent.click(screen.getByText("saveVersion"))
    expect(useArtifactStore.getState().getArtifactVersions(a.id)).toHaveLength(1)
  })

  it("renders a saved version row with restore + diff buttons", () => {
    const a = makeArtifact()
    useArtifactStore.getState().saveArtifactVersion(a.id, "first")
    render(<PanelVersionHistory artifact={a} />)
    expect(screen.getByText("first")).toBeInTheDocument()
    expect(screen.getByText("restoreVersion")).toBeInTheDocument()
  })

  it("restoring a version writes its content back and runs the callback", () => {
    const a = makeArtifact()
    useArtifactStore.getState().saveArtifactVersion(a.id, "first")
    useArtifactStore.getState().updateArtifact(a.id, { content: "v2" })
    const updated = useArtifactStore.getState().artifacts[a.id]
    const onRestored = jest.fn()
    render(<PanelVersionHistory artifact={updated} onVersionRestored={onRestored} />)
    fireEvent.click(screen.getByText("restoreVersion"))
    expect(onRestored).toHaveBeenCalled()
    expect(useArtifactStore.getState().artifacts[a.id].content).toBe("v1")
  })

  it("toggles the inline diff view", () => {
    const a = makeArtifact()
    useArtifactStore.getState().saveArtifactVersion(a.id, "first")
    useArtifactStore.getState().updateArtifact(a.id, { content: "v2" })
    const updated = useArtifactStore.getState().artifacts[a.id]
    render(<PanelVersionHistory artifact={updated} />)
    const compareBtn = screen.getByTitle("compareWithCurrent")
    fireEvent.click(compareBtn)
    expect(screen.getByText(/currentVersion/)).toBeInTheDocument()
    fireEvent.click(compareBtn)
  })
})
