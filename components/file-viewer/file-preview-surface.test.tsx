import { render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import type { FileViewerRequest } from "@/lib/file-viewer/types"

const mockStat = jest.fn()
const mockRead = jest.fn()
const mockHasBackend = jest.fn(() => true)
const mockWarn = jest.fn()
const mockDebug = jest.fn()

jest.mock("@/lib/files/workspace-fs", () => ({
  statWorkspaceFile: (...args: unknown[]) => mockStat(...args),
  readWorkspaceFile: (...args: unknown[]) => mockRead(...args),
}))
jest.mock("@/lib/files/workspace-backend", () => ({
  hasWorkspaceFsBackend: () => mockHasBackend(),
}))
jest.mock("@cognia/logging", () => ({
  loggers: {
    files: {
      warn: (...a: unknown[]) => mockWarn(...a),
      debug: (...a: unknown[]) => mockDebug(...a),
    },
  },
}))
// `dynamic(loader)` resolves to a synchronous stub so the viewer paints in the
// same tick the surface settles.
jest.mock(
  "next/dynamic",
  () => () =>
    function MockViewer({ text }: { text: string }) {
      return <div data-testid="mock-viewer">{text}</div>
    }
)

import { FilePreviewSurface } from "./file-preview-surface"

const messages = {
  fileViewer: {
    loading: "Loading…",
    openAtLine: "Open at line {line}",
    frameTitle: "File preview",
    error: {
      isDirectory: "folder",
      noBackend: "no backend",
      noRoot: "no root",
      notFound: "gone",
      outsideWorkspace: "outside",
      readFailed: "failed",
      tooLarge: "too large {limit}",
      unsupported: "unsupported",
    },
  },
}

function request(overrides: Partial<FileViewerRequest> = {}): FileViewerRequest {
  return {
    requestId: "r1",
    source: "terminal",
    root: "/work/app",
    relPath: "notes.md",
    displayName: "notes.md",
    ...overrides,
  }
}

function renderSurface(req: FileViewerRequest | null) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <FilePreviewSurface request={req} />
    </NextIntlClientProvider>
  )
}

const errorCode = () => screen.getByTestId("file-preview-error").getAttribute("data-error-code")

beforeEach(() => {
  jest.clearAllMocks()
  mockHasBackend.mockReturnValue(true)
})

describe("FilePreviewSurface", () => {
  it("renders host-supplied text without touching the filesystem", async () => {
    renderSurface(request({ providedText: "# hi", relPath: "a.md" }))

    await screen.findByTestId("mock-viewer")
    // The project workbench previews the live editor draft; reaching the disk
    // would show the saved file instead of what the user is looking at.
    expect(mockStat).not.toHaveBeenCalled()
    expect(mockRead).not.toHaveBeenCalled()
  })

  it("treats empty host text as an empty file, not as absent text", async () => {
    renderSurface(request({ providedText: "", relPath: "a.md" }))
    await screen.findByTestId("mock-viewer")
    expect(mockRead).not.toHaveBeenCalled()
  })

  it("refuses an oversized file from the stat alone, without transferring it", async () => {
    mockStat.mockResolvedValue({ exists: true, isDir: false, size: 3 * 1024 * 1024, mtimeMs: 0 })
    renderSurface(request())

    await waitFor(() => expect(errorCode()).toBe("too-large"))
    expect(mockRead).not.toHaveBeenCalled()
  })

  it("asks for one byte more than the cap so growth mid-read is detectable", async () => {
    mockStat.mockResolvedValue({ exists: true, isDir: false, size: 10, mtimeMs: 0 })
    mockRead.mockResolvedValue("ok")
    renderSurface(request())

    await screen.findByTestId("mock-viewer")
    expect(mockRead).toHaveBeenCalledWith("/work/app", "notes.md", 2 * 1024 * 1024 + 1)
  })

  it("rejects a file that grew past the cap between the stat and the read", async () => {
    // The Rust side truncates and appends a marker rather than failing, so a
    // surface that trusted the stat would show a silently shortened document.
    mockStat.mockResolvedValue({
      exists: true,
      isDir: false,
      size: 2 * 1024 * 1024 - 1,
      mtimeMs: 0,
    })
    mockRead.mockResolvedValue("a".repeat(2 * 1024 * 1024 + 1))
    renderSurface(request())

    await waitFor(() => expect(errorCode()).toBe("too-large"))
  })

  it("renders a file of exactly the cap, with no truncation marker", async () => {
    const exact = "a".repeat(2 * 1024 * 1024)
    mockStat.mockResolvedValue({ exists: true, isDir: false, size: exact.length, mtimeMs: 0 })
    mockRead.mockResolvedValue(exact)
    renderSurface(request())

    const viewer = await screen.findByTestId("mock-viewer")
    expect(viewer.textContent).not.toContain("... (truncated)")
  })

  it("fails closed on every shape that is not a readable file", async () => {
    const cases: Array<[Partial<FileViewerRequest>, () => void, string]> = [
      [
        {},
        () => mockStat.mockResolvedValue({ exists: false, isDir: false, size: 0, mtimeMs: 0 }),
        "not-found",
      ],
      [
        {},
        () => mockStat.mockResolvedValue({ exists: true, isDir: true, size: 0, mtimeMs: 0 }),
        "is-directory",
      ],
      [{ root: undefined }, () => undefined, "no-root"],
      [{}, () => mockHasBackend.mockReturnValue(false), "no-backend"],
    ]
    for (const [overrides, arrange, expected] of cases) {
      jest.clearAllMocks()
      mockHasBackend.mockReturnValue(true)
      arrange()
      const { unmount } = renderSurface(request({ ...overrides, requestId: expected }))
      await waitFor(() => expect(errorCode()).toBe(expected))
      if (expected === "no-root" || expected === "no-backend") {
        expect(mockStat).not.toHaveBeenCalled()
      }
      unmount()
    }
  })

  it("separates a workspace escape from an ordinary read failure", async () => {
    mockStat.mockResolvedValue({ exists: true, isDir: false, size: 10, mtimeMs: 0 })
    mockRead.mockRejectedValue(new Error("path escapes workspace: /etc/passwd"))
    const { unmount } = renderSurface(request())
    await waitFor(() => expect(errorCode()).toBe("outside-workspace"))
    unmount()

    jest.clearAllMocks()
    mockHasBackend.mockReturnValue(true)
    mockStat.mockResolvedValue({ exists: true, isDir: false, size: 10, mtimeMs: 0 })
    mockRead.mockRejectedValue(new Error("EIO"))
    renderSurface(request({ requestId: "r2" }))
    await waitFor(() => expect(errorCode()).toBe("read-failed"))
  })

  it("discards a slow read whose request has already been replaced", async () => {
    let resolveSlow: ((value: string) => void) | undefined
    mockStat.mockResolvedValue({ exists: true, isDir: false, size: 10, mtimeMs: 0 })
    mockRead.mockImplementationOnce(() => new Promise<string>((resolve) => (resolveSlow = resolve)))
    const { rerender } = renderSurface(request({ requestId: "slow", relPath: "slow.txt" }))

    mockRead.mockResolvedValueOnce("fast content")
    rerender(
      <NextIntlClientProvider locale="en" messages={messages}>
        <FilePreviewSurface request={request({ requestId: "fast", relPath: "fast.txt" })} />
      </NextIntlClientProvider>
    )
    await screen.findByText("fast content")

    // The slow read lands last and must not paint over the file on screen.
    resolveSlow?.("slow content")
    await waitFor(() => expect(screen.queryByText("slow content")).not.toBeInTheDocument())
    expect(screen.getByTestId("mock-viewer")).toHaveTextContent("fast content")
  })

  it("says so when nothing can render the file", async () => {
    mockStat.mockResolvedValue({ exists: true, isDir: false, size: 10, mtimeMs: 0 })
    mockRead.mockResolvedValue("binary-ish")
    renderSurface(request({ source: "project-preview", relPath: "image.png" }))

    await waitFor(() => expect(errorCode()).toBe("unsupported"))
  })

  it("logs a bounded payload that names no path, file or content", async () => {
    mockStat.mockResolvedValue({ exists: true, isDir: false, size: 4, mtimeMs: 0 })
    mockRead.mockResolvedValue("text")
    renderSurface(request({ relPath: "deep/secret-name.md" }))

    await waitFor(() => expect(mockDebug).toHaveBeenCalled())
    const [event, payload] = mockDebug.mock.calls[0] as [string, Record<string, unknown>]
    expect(event).toBe("fileViewer.render")
    // Pinned as an exact key set: this is the only thing stopping someone
    // adding `path` later "just for debugging".
    expect(Object.keys(payload).sort()).toEqual(
      ["durationMs", "extension", "sizeBucket", "source"].sort()
    )
    expect(JSON.stringify(payload)).not.toContain("secret-name")
  })

  it("offers a way to reach a line the chosen viewer cannot honour", async () => {
    mockStat.mockResolvedValue({ exists: true, isDir: false, size: 4, mtimeMs: 0 })
    mockRead.mockResolvedValue("# doc")
    renderSurface(request({ relPath: "a.md", line: 42 }))

    // Markdown wins the file, but only the text viewer can jump to a line —
    // dropping the location silently would lose what the user clicked.
    await waitFor(() =>
      expect(screen.getByTestId("file-preview-surface")).toHaveAttribute(
        "data-viewer-id",
        "builtin.markdown"
      )
    )
    screen.getByTestId("file-preview-open-at-line").click()

    await waitFor(() =>
      expect(screen.getByTestId("file-preview-surface")).toHaveAttribute(
        "data-viewer-id",
        "builtin.text"
      )
    )
    // Reuses the text already in hand — no second read.
    expect(mockRead).toHaveBeenCalledTimes(1)
  })

  it("does not offer the line affordance where it cannot apply", async () => {
    mockStat.mockResolvedValue({ exists: true, isDir: false, size: 4, mtimeMs: 0 })
    mockRead.mockResolvedValue("# doc")
    renderSurface(request({ relPath: "a.md" }))

    await screen.findByTestId("mock-viewer")
    expect(screen.queryByTestId("file-preview-open-at-line")).not.toBeInTheDocument()
  })

  it("renders nothing at all without a request", () => {
    const { container } = renderSurface(null)
    expect(container).toBeEmptyDOMElement()
  })
})
