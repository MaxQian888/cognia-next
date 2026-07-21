/** @jest-environment jsdom */
import { revealArtifactInWorkspace } from "./reveal"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"

afterEach(() => {
  // Reset the store between tests; persist hydration is namespace-scoped
  // and the test runner shares localStorage across cases.
  useArtifactStore.setState({
    artifacts: {},
    activeArtifactId: null,
    panelOpen: false,
    panelView: "artifact",
  })
  useArtifactDockLayoutStore.getState().resetLayout()
})

describe("revealArtifactInWorkspace", () => {
  it("returns null when the artifact id is unknown", () => {
    expect(revealArtifactInWorkspace("missing")).toBeNull()
  })

  it("activates the artifact and opens the panel", () => {
    const artifact = useArtifactStore.getState().createArtifact({
      sessionId: "s",
      messageId: "m",
      type: "code",
      title: "t",
      content: "console.log(1)",
    })
    // createArtifact already opens the panel; clear it to make the assertion crisp.
    useArtifactStore.setState({ panelOpen: false, activeArtifactId: null })

    const revealed = revealArtifactInWorkspace(artifact.id)
    expect(revealed?.id).toBe(artifact.id)
    expect(useArtifactStore.getState().activeArtifactId).toBe(artifact.id)
    expect(useArtifactStore.getState().panelOpen).toBe(true)
    expect(useArtifactStore.getState().panelView).toBe("artifact")
  })

  it("expands the docked panel and asks the workbench for the preview panel", () => {
    const artifact = useArtifactStore.getState().createArtifact({
      sessionId: "s",
      messageId: "m",
      type: "code",
      title: "t",
      content: "console.log(1)",
    })
    useArtifactDockLayoutStore.getState().setDockCollapsed(true)

    revealArtifactInWorkspace(artifact.id)
    expect(useArtifactDockLayoutStore.getState().dockCollapsed).toBe(false)
    expect(useArtifactDockLayoutStore.getState().revealIntent).toEqual({
      panelId: "preview",
      mode: "narrow",
    })
  })

  it("pulls a dock parked on the workspace back to the revealed artifact", () => {
    const artifact = useArtifactStore.getState().createArtifact({
      sessionId: "s",
      messageId: "m",
      type: "code",
      title: "t",
      content: "console.log(1)",
    })
    useArtifactDockLayoutStore.getState().setDockProfile("workspace")

    revealArtifactInWorkspace(artifact.id)

    expect(useArtifactDockLayoutStore.getState().revealIntent?.panelId).toBe("preview")
  })
})
