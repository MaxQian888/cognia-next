import { act, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

const mockStat = jest.fn()
const mockRead = jest.fn()

jest.mock("@/lib/files/workspace-fs", () => ({
  statWorkspaceFile: (...a: unknown[]) => mockStat(...a),
  readWorkspaceFile: (...a: unknown[]) => mockRead(...a),
}))
jest.mock("@/lib/files/workspace-backend", () => ({ hasWorkspaceFsBackend: () => true }))
jest.mock(
  "next/dynamic",
  () => () =>
    function MockViewer({ text }: { text: string }) {
      return <div data-testid="mock-viewer">{text}</div>
    }
)

import { FileViewerDialog } from "./file-viewer-dialog"
import { useFileViewerStore } from "@/stores/file-viewer/file-viewer-store"
import type { FileViewerRequest } from "@/lib/file-viewer/types"

const messages = {
  terminal: { fileViewer: { title: "File viewer", description: "Read-only source file preview" } },
  fileViewer: {
    loading: "Loading…",
    openAtLine: "Open at line {line}",
    frameTitle: "File preview",
    error: {
      isDirectory: "folder",
      noBackend: "no backend",
      noRoot: "no root",
      notFound: "gone",
      outsideWorkspace: "This file is outside your open workspaces.",
      readFailed: "failed",
      tooLarge: "too large {limit}",
      unsupported: "unsupported",
    },
  },
}

function renderDialog() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <FileViewerDialog />
    </NextIntlClientProvider>
  )
}

const request: FileViewerRequest = {
  requestId: "r1",
  source: "terminal",
  root: "/proj",
  relPath: "src/a.ts",
  displayName: "src/a.ts",
  line: 2,
  column: 4,
}

beforeEach(() => {
  useFileViewerStore.setState({ open: false, request: null, failure: null })
  mockStat.mockReset()
  mockRead.mockReset()
})

describe("FileViewerDialog", () => {
  it("renders nothing while closed", () => {
    renderDialog()
    expect(screen.queryByTestId("terminal-file-viewer")).toBeNull()
  })

  it("shows the file and its location in the title", async () => {
    mockStat.mockResolvedValue({ exists: true, isDir: false, size: 12, mtimeMs: 0 })
    mockRead.mockResolvedValue("line1\nline2")
    renderDialog()

    await act(async () => {
      useFileViewerStore.getState().openRequest(request)
    })

    await screen.findByTestId("mock-viewer")
    expect(screen.getByTestId("terminal-file-viewer")).toHaveTextContent("src/a.ts:2:4")
  })

  it("opens on a refusal instead of doing nothing", async () => {
    renderDialog()

    await act(async () => {
      useFileViewerStore.getState().openFailure("outside-workspace", "/usr/lib/x.js")
    })

    // A click that silently does nothing is indistinguishable from a broken
    // link, which is exactly how this dialog behaved when the terminal panel
    // was closed.
    const error = await screen.findByTestId("file-preview-error")
    expect(error).toHaveAttribute("data-error-code", "outside-workspace")
    expect(screen.getByTestId("terminal-file-viewer")).toHaveTextContent("/usr/lib/x.js")
    expect(mockStat).not.toHaveBeenCalled()
  })

  it("keeps the payload on close so the exit transition is not blanked", async () => {
    mockStat.mockResolvedValue({ exists: true, isDir: false, size: 5, mtimeMs: 0 })
    mockRead.mockResolvedValue("body")
    renderDialog()
    await act(async () => {
      useFileViewerStore.getState().openRequest(request)
    })
    await screen.findByTestId("mock-viewer")

    act(() => useFileViewerStore.getState().close())

    await waitFor(() => expect(screen.queryByTestId("terminal-file-viewer")).toBeNull())
    expect(useFileViewerStore.getState().request).not.toBeNull()
  })
})
