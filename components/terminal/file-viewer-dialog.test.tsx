/**
 * @jest-environment jsdom
 */

import { render, screen, act } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vals?: Record<string, unknown>) =>
    vals ? `${key}:${JSON.stringify(vals)}` : key,
}))

const mockReadTextFile = jest.fn()
jest.mock("@/lib/file/file-operations", () => ({
  readTextFile: (...args: unknown[]) => mockReadTextFile(...args),
}))

const mockReveal = jest.fn()
const mockSetPosition = jest.fn()

// Synchronous Monaco stub: records onMount (so we can assert the reveal
// calls) and renders the file content. Declared at top level so the
// next/dynamic mock factory can reference it (mock-prefixed names are
// allowed past jest's hoist guard).
function mockMonacoComponent({
  value,
  path,
  onMount,
}: {
  value?: string
  path?: string
  onMount?: (editor: unknown) => void
}) {
  // Fire onMount via a ref callback (runs on commit) instead of a hook —
  // a `mock`-prefixed (lowercase) function can't legally call hooks.
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

// `dynamic(loader)` resolves to our stub regardless of the loader.
jest.mock("next/dynamic", () => () => mockMonacoComponent)

import { FileViewerDialog } from "./file-viewer-dialog"
import { useFileViewerStore } from "@/stores/terminal/file-viewer-store"

beforeEach(() => {
  useFileViewerStore.setState({ open: false, path: null, line: null, column: null })
  mockReadTextFile.mockReset()
  mockReveal.mockReset()
  mockSetPosition.mockReset()
})

describe("FileViewerDialog", () => {
  it("renders nothing while closed", () => {
    render(<FileViewerDialog />)
    expect(screen.queryByTestId("terminal-file-viewer")).toBeNull()
  })

  it("loads the file and reveals the target line on open", async () => {
    mockReadTextFile.mockResolvedValue("line1\nline2\nline3")
    render(<FileViewerDialog />)
    await act(async () => {
      useFileViewerStore.getState().openFile("/proj/src/a.ts", 2, 4)
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(mockReadTextFile).toHaveBeenCalledWith("/proj/src/a.ts")
    const monaco = await screen.findByTestId("monaco")
    expect(monaco.getAttribute("data-path")).toBe("/proj/src/a.ts")
    expect(monaco.textContent).toContain("line2")
    expect(mockReveal).toHaveBeenCalledWith(2)
    expect(mockSetPosition).toHaveBeenCalledWith({ lineNumber: 2, column: 4 })
  })

  it("shows an error when the file cannot be read", async () => {
    mockReadTextFile.mockRejectedValue(new Error("ENOENT"))
    render(<FileViewerDialog />)
    await act(async () => {
      useFileViewerStore.getState().openFile("/missing.ts", 1, null)
    })
    await act(async () => {
      await Promise.resolve()
    })
    const err = await screen.findByTestId("terminal-file-viewer-error")
    expect(err.textContent).toContain("ENOENT")
  })
})
