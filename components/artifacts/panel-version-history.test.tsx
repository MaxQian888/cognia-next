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
    const compareBtn = screen.getByRole("button", { name: "compareVersion" })
    expect(compareBtn).toHaveAttribute("aria-pressed", "false")
    fireEvent.click(compareBtn)
    expect(compareBtn).toHaveAttribute("aria-pressed", "true")
    expect(screen.getAllByText(/currentVersion/).length).toBeGreaterThan(0)
    expect(screen.getByTestId("version-inline-diff")).toBeInTheDocument()
    fireEvent.click(compareBtn)
    expect(screen.queryByTestId("version-inline-diff")).not.toBeInTheDocument()
  })

  it("compares any two saved versions, older to newer, from the picker", () => {
    const a = makeArtifact()
    useArtifactStore.getState().saveArtifactVersion(a.id, "first")
    useArtifactStore.getState().updateArtifact(a.id, { content: "v2" })
    useArtifactStore.getState().saveArtifactVersion(a.id, "second")
    useArtifactStore.getState().updateArtifact(a.id, { content: "v3" })
    const updated = useArtifactStore.getState().artifacts[a.id]
    const versions = useArtifactStore.getState().getArtifactVersions(a.id)
    const first = versions.find((v) => v.changeDescription === "first")!
    const second = versions.find((v) => v.changeDescription === "second")!
    render(<PanelVersionHistory artifact={updated} />)

    // Open the comparison on the NEWER saved version, then pick the older one.
    const rows = screen.getAllByRole("button", { name: "compareVersion" })
    const secondIndex = versions.indexOf(second)
    fireEvent.click(rows[secondIndex])
    const picker = screen.getByTestId("version-compare-against") as HTMLSelectElement
    expect(picker.value).toBe("current")
    // The opened version is not offered against itself.
    expect([...picker.options].map((o) => o.value)).toEqual(["current", first.id])
    fireEvent.change(picker, { target: { value: first.id } })
    // v1 → v2 whichever was opened first: one line removed, one added.
    expect(screen.getByTestId("version-compare-stats")).toHaveTextContent("+1 -1")
    expect(screen.getByRole("region", { name: /v1 · first → v2 · second/ })).toBeInTheDocument()
  })

  it("starts each newly opened comparison against the current version", () => {
    const a = makeArtifact()
    useArtifactStore.getState().saveArtifactVersion(a.id, "first")
    useArtifactStore.getState().updateArtifact(a.id, { content: "v2" })
    useArtifactStore.getState().saveArtifactVersion(a.id, "second")
    const updated = useArtifactStore.getState().artifacts[a.id]
    render(<PanelVersionHistory artifact={updated} />)
    const buttons = screen.getAllByRole("button", { name: "compareVersion" })
    fireEvent.click(buttons[0])
    const picker = screen.getByTestId("version-compare-against") as HTMLSelectElement
    fireEvent.change(picker, { target: { value: picker.options[1].value } })
    fireEvent.click(buttons[1])
    expect((screen.getByTestId("version-compare-against") as HTMLSelectElement).value).toBe(
      "current"
    )
  })
})
