/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import {
  ArtifactCard,
  ArtifactInlineRef,
  MessageArtifacts,
  MessageAnalysisResults,
} from "./artifact-card"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import type { Artifact } from "@/types"

const baseArtifact = (overrides: Partial<Artifact> = {}): Artifact => ({
  id: "a1",
  sessionId: "s",
  messageId: "m1",
  type: "code",
  title: "My Snippet",
  content: "console.log('hi')",
  language: "javascript",
  version: 2,
  createdAt: new Date(),
  updatedAt: new Date(),
  metadata: { runnable: true, wordCount: 12 },
  ...overrides,
})

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
})

describe("ArtifactCard", () => {
  it("renders title and metadata badges in full mode", () => {
    render(<ArtifactCard artifact={baseArtifact()} showPreview />)
    expect(screen.getByText("My Snippet")).toBeInTheDocument()
    expect(screen.getByText("typeCode")).toBeInTheDocument()
    expect(screen.getByText("runnable")).toBeInTheDocument()
  })

  it("compact variant renders just the title button", () => {
    render(<ArtifactCard artifact={baseArtifact()} compact />)
    expect(screen.getByText("My Snippet")).toBeInTheDocument()
  })

  it("clicking the card reveals the artifact in the workspace", () => {
    const a = baseArtifact()
    useArtifactStore.setState({ artifacts: { [a.id]: a } })
    render(<ArtifactCard artifact={a} />)
    fireEvent.click(screen.getByText("My Snippet"))
    expect(useArtifactStore.getState().activeArtifactId).toBe(a.id)
  })

  it("duplicate button creates a derivative artifact", () => {
    const a = baseArtifact()
    useArtifactStore.setState({ artifacts: { [a.id]: a } })
    render(<ArtifactCard artifact={a} />)
    // Two icon buttons: open + duplicate. Pick the title='duplicate' one.
    fireEvent.click(screen.getByTitle("duplicate"))
    expect(Object.keys(useArtifactStore.getState().artifacts).length).toBeGreaterThan(1)
  })
})

describe("ArtifactInlineRef", () => {
  it("renders a clickable inline reference", () => {
    const a = baseArtifact()
    useArtifactStore.setState({ artifacts: { [a.id]: a } })
    render(<ArtifactInlineRef artifact={a} />)
    fireEvent.click(screen.getByText("My Snippet"))
    expect(useArtifactStore.getState().activeArtifactId).toBe(a.id)
  })
})

describe("MessageArtifacts", () => {
  it("renders nothing when the message has no artifacts", () => {
    const { container } = render(<MessageArtifacts messageId="missing" />)
    expect(container.firstChild).toBeNull()
  })

  it("compact mode renders inline refs", () => {
    const a = baseArtifact()
    useArtifactStore.setState({ artifacts: { [a.id]: a } })
    render(<MessageArtifacts messageId="m1" />)
    expect(screen.getByText("My Snippet")).toBeInTheDocument()
  })

  it("non-compact mode renders cards with previews", () => {
    const a = baseArtifact()
    useArtifactStore.setState({ artifacts: { [a.id]: a } })
    render(<MessageArtifacts messageId="m1" compact={false} />)
    expect(screen.getByText("typeCode")).toBeInTheDocument()
  })
})

describe("MessageAnalysisResults", () => {
  it("renders nothing when there are no analysis results", () => {
    const { container } = render(<MessageAnalysisResults messageId="m1" />)
    expect(container.firstChild).toBeNull()
  })

  it("renders math/chart/data buttons when results exist", () => {
    useArtifactStore.getState().addAnalysisResult({
      sessionId: "s",
      messageId: "m1",
      type: "math",
      content: "1+1",
      output: { result: 2, summary: "two" },
    })
    useArtifactStore.getState().addAnalysisResult({
      sessionId: "s",
      messageId: "m1",
      type: "chart",
      content: "[]",
      output: { summary: "demo" },
    })
    useArtifactStore.getState().addAnalysisResult({
      sessionId: "s",
      messageId: "m1",
      type: "data",
      content: "[]",
      output: { summary: "rows" },
    })
    render(<MessageAnalysisResults messageId="m1" />)
    expect(screen.getByText("two")).toBeInTheDocument()
    expect(screen.getByText("demo")).toBeInTheDocument()
    expect(screen.getByText("rows")).toBeInTheDocument()
  })
})
