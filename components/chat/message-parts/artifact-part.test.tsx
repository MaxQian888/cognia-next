/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import { ArtifactPart } from "./artifact-part"
import type { ArtifactPart as ArtifactPartType } from "@/lib/claude/parts-extensions"
import type { Artifact } from "@/types"

const mockArtifacts: Record<string, Artifact | undefined> = {}
const mockRevealArtifact = jest.fn()
const mockCopy = jest.fn().mockResolvedValue(true)

jest.mock("@/stores/artifact/artifact-store", () => ({
  useArtifactStore: (selector: (s: { artifacts: typeof mockArtifacts }) => unknown) =>
    selector({ artifacts: mockArtifacts }),
}))

jest.mock("@/lib/artifacts/reveal", () => ({
  revealArtifactInWorkspace: (...args: unknown[]) => mockRevealArtifact(...args),
}))

jest.mock("@/hooks/ui/use-copy", () => ({
  useCopy: () => ({ copy: mockCopy, copied: false, isCopying: false }),
}))

jest.mock("@/components/artifacts/artifact-preview", () => ({
  ArtifactPreview: ({ artifact }: { artifact: { id: string; title: string } }) => (
    <div data-testid="artifact-preview" data-artifact-id={artifact.id}>
      preview:{artifact.title}
    </div>
  ),
}))

const createPart = (overrides: Partial<ArtifactPartType> = {}): ArtifactPartType => ({
  type: "artifact",
  artifactId: "art-1",
  title: "demo-artifact",
  kind: "code",
  ...overrides,
})

const createArtifactRow = (overrides: Partial<Artifact> = {}): Artifact =>
  ({
    id: "art-1",
    sessionId: "sess",
    messageId: "msg",
    type: "code",
    title: "demo-artifact",
    content: "console.log('hi')",
    language: "typescript",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }) as Artifact

beforeEach(() => {
  for (const k of Object.keys(mockArtifacts)) delete mockArtifacts[k]
  mockRevealArtifact.mockClear()
  mockCopy.mockClear()
})

describe("ArtifactPart", () => {
  it("renders ArtifactPreview when the store has the row", () => {
    mockArtifacts["art-1"] = createArtifactRow()
    render(<ArtifactPart part={createPart()} />)

    expect(screen.getByTestId("artifact-part")).toHaveAttribute("data-artifact-id", "art-1")
    expect(screen.getByTestId("artifact-preview")).toHaveAttribute("data-artifact-id", "art-1")
  })

  it("renders the cleared placeholder when the row is missing", () => {
    render(<ArtifactPart part={createPart({ title: "lost-artifact" })} />)

    const node = screen.getByTestId("artifact-part-missing")
    expect(node).toBeInTheDocument()
    expect(node).toHaveTextContent("lost-artifact")
    expect(node).toHaveTextContent("(已清理)")
  })

  it("collapses and re-expands the preview body", () => {
    mockArtifacts["art-1"] = createArtifactRow()
    render(<ArtifactPart part={createPart()} />)

    expect(screen.getByTestId("artifact-preview")).toBeInTheDocument()

    const toggle = screen.getByTestId("artifact-part-toggle")
    fireEvent.click(toggle)

    expect(screen.queryByTestId("artifact-preview")).toBeNull()
    expect(toggle).toHaveAttribute("aria-expanded", "false")

    fireEvent.click(toggle)
    expect(screen.getByTestId("artifact-preview")).toBeInTheDocument()
  })

  it("honors defaultOpen=false", () => {
    mockArtifacts["art-1"] = createArtifactRow()
    render(<ArtifactPart part={createPart({ defaultOpen: false })} />)

    expect(screen.queryByTestId("artifact-preview")).toBeNull()
  })

  it("triggers revealArtifactInWorkspace when Open-in-Canvas is clicked", () => {
    mockArtifacts["art-1"] = createArtifactRow()
    render(<ArtifactPart part={createPart()} />)

    fireEvent.click(screen.getByTestId("artifact-part-open-canvas"))

    expect(mockRevealArtifact).toHaveBeenCalledWith("art-1")
  })

  it("copies the artifact content via clipboard hook", () => {
    mockArtifacts["art-1"] = createArtifactRow({ content: "copy-me" })
    render(<ArtifactPart part={createPart()} />)

    fireEvent.click(screen.getByTestId("artifact-part-copy"))
    expect(mockCopy).toHaveBeenCalledWith("copy-me")
  })

  it("downloads a blob when the download action fires", () => {
    mockArtifacts["art-1"] = createArtifactRow({
      content: "download-payload",
      title: "my-file",
      language: "typescript",
    })
    const createObjectURL = jest.fn().mockReturnValue("blob:fake")
    const revokeObjectURL = jest.fn()
    const originalCreate = (URL as unknown as { createObjectURL?: unknown }).createObjectURL
    const originalRevoke = (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL
    Object.defineProperty(URL, "createObjectURL", { value: createObjectURL, configurable: true })
    Object.defineProperty(URL, "revokeObjectURL", { value: revokeObjectURL, configurable: true })
    const createElementSpy = jest.spyOn(document, "createElement")

    render(<ArtifactPart part={createPart()} />)
    fireEvent.click(screen.getByTestId("artifact-part-download"))

    const anchorCalls = createElementSpy.mock.calls.filter(([tag]) => tag === "a")
    expect(anchorCalls.length).toBeGreaterThanOrEqual(1)
    expect(createObjectURL).toHaveBeenCalled()
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:fake")

    createElementSpy.mockRestore()
    Object.defineProperty(URL, "createObjectURL", { value: originalCreate, configurable: true })
    Object.defineProperty(URL, "revokeObjectURL", { value: originalRevoke, configurable: true })
  })

  it("does not invoke clipboard or download when the artifact is missing", () => {
    render(<ArtifactPart part={createPart()} />)

    expect(screen.queryByTestId("artifact-part")).toBeNull()
    expect(mockCopy).not.toHaveBeenCalled()
  })
})
