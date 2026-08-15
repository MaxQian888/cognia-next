import { render, screen } from "@testing-library/react"
import type { FileViewerRenderProps } from "@/lib/file-viewer/types"

const mockReveal = jest.fn()
const mockSetPosition = jest.fn()

// Synchronous Monaco stub, same shape the terminal viewer's test uses: fires
// `onMount` from a ref callback (which runs on commit) rather than a hook,
// because a `mock`-prefixed lowercase function may not call hooks.
function mockMonacoComponent({
  value,
  path,
  onMount,
}: {
  value?: string
  path?: string
  onMount?: (editor: unknown) => void
}) {
  return (
    <div
      data-testid="monaco"
      data-path={path}
      ref={() =>
        onMount?.({
          revealLineInCenter: mockReveal,
          setPosition: mockSetPosition,
          focus: jest.fn(),
        })
      }
    >
      {value}
    </div>
  )
}

jest.mock("next/dynamic", () => () => mockMonacoComponent)

import MonacoViewer from "./monaco-viewer"

function props(overrides: Partial<FileViewerRenderProps> = {}): FileViewerRenderProps {
  return {
    text: "const a = 1",
    displayName: "a.ts",
    relPath: "src/a.ts",
    line: null,
    column: null,
    source: "terminal",
    ...overrides,
  }
}

describe("MonacoViewer", () => {
  beforeEach(() => {
    mockReveal.mockClear()
    mockSetPosition.mockClear()
  })

  it("renders the text and hands Monaco the path so it can infer a language", () => {
    render(<MonacoViewer {...props()} />)
    expect(screen.getByTestId("file-viewer-monaco")).toHaveTextContent("const a = 1")
    expect(screen.getByTestId("monaco")).toHaveAttribute("data-path", "src/a.ts")
  })

  it("reveals the requested location", () => {
    render(<MonacoViewer {...props({ line: 42, column: 7 })} />)
    expect(mockReveal).toHaveBeenCalledWith(42)
    expect(mockSetPosition).toHaveBeenCalledWith({ lineNumber: 42, column: 7 })
  })

  it("defaults the column when only a line was given", () => {
    render(<MonacoViewer {...props({ line: 42 })} />)
    expect(mockSetPosition).toHaveBeenCalledWith({ lineNumber: 42, column: 1 })
  })

  it("does not reveal when there is no location to reveal", () => {
    render(<MonacoViewer {...props()} />)
    expect(mockReveal).not.toHaveBeenCalled()
  })
})
