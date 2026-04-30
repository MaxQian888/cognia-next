/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { ArtifactCreateButton } from "./artifact-create-button"
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

describe("ArtifactCreateButton", () => {
  it("creates an artifact when the icon variant is clicked", () => {
    render(<ArtifactCreateButton content={"console.log(1)"} language="javascript" messageId="m1" />)
    fireEvent.click(screen.getByRole("button"))
    const created = Object.values(useArtifactStore.getState().artifacts)
    expect(created).toHaveLength(1)
    expect(created[0].messageId).toBe("m1")
  })

  it("button variant also creates an artifact", () => {
    render(<ArtifactCreateButton content="x" variant="button" />)
    fireEvent.click(screen.getByRole("button"))
    expect(Object.keys(useArtifactStore.getState().artifacts)).toHaveLength(1)
  })

  it("dropdown variant renders the menu trigger", () => {
    render(<ArtifactCreateButton content="x" variant="dropdown" />)
    expect(screen.getByRole("button", { name: /createArtifact/i })).toBeInTheDocument()
  })

  it("falls back to 'standalone' session when no chat session is active", () => {
    useChatStore.setState({ activeSessionId: null })
    render(<ArtifactCreateButton content="anything" />)
    fireEvent.click(screen.getByRole("button"))
    const created = Object.values(useArtifactStore.getState().artifacts)
    expect(created[0].sessionId).toBe("standalone")
  })

  it("uses translated default title for typed artifacts (no name extracted)", () => {
    // The next-intl mock returns the key, so the title comes through as the
    // i18n key — proves we pass it through useTranslations rather than the
    // English fallback in lib/artifacts/utils.ts.
    render(<ArtifactCreateButton content="some text" />)
    fireEvent.click(screen.getByRole("button"))
    const created = Object.values(useArtifactStore.getState().artifacts)
    // No language → no type matched as react/jsx → default code path → codeSnippet key
    expect(created[0].title).toBe("codeSnippet")
  })
})
