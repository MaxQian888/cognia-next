/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({ useTranslations: () => (k: string) => k }))
jest.mock("sonner", () => ({ toast: { error: jest.fn(), info: jest.fn() } }))

const paneState = {
  phase: "starting" as "unsupported" | "starting" | "downloading" | "ready" | "error",
  mounted: false,
  progress: null as number | null,
  error: null as string | null,
  retry: jest.fn(),
}
const capturedOptions: { onRevoked?: () => void } = {}
jest.mock("@/hooks/codeserver/use-code-server-pane", () => ({
  useCodeServerPane: (_ref: unknown, options: { onRevoked: () => void }) => {
    capturedOptions.onRevoked = options.onRevoked
    return paneState
  },
}))
const driveOpen = jest.fn()
const driveApplyEdit = jest.fn()
const openFile = jest.fn()
const cancelDownload = jest.fn()
jest.mock("@/lib/codeserver/client", () => ({
  codeServerClient: {
    driveOpen: (...args: unknown[]) => driveOpen(...args),
    driveApplyEdit: (...args: unknown[]) => driveApplyEdit(...args),
    openFile: (...args: unknown[]) => openFile(...args),
    cancelDownload: (...args: unknown[]) => cancelDownload(...args),
  },
}))
// The debounce/single-flight policy has its own suite; here it is a pass-through
// so the wiring assertions stay deterministic.
const queueDispose = jest.fn()
jest.mock("@/lib/codeserver/open-file-queue", () => ({
  createCodeServerOpenQueue: (
    open: (path: string, line?: number, column?: number) => Promise<void>,
    options?: { onError?: (cause: unknown) => void }
  ) => ({
    request: (path: string, line?: number, column?: number) => {
      void open(path, line, column).catch((cause) => options?.onError?.(cause))
    },
    dispose: queueDispose,
  }),
}))
let registeredOpener:
  | {
      root: string
      open: (path: string, line?: number, column?: number) => void
      applyEdit?: (path: string, line?: number, column?: number) => void
    }
  | undefined
const unregister = jest.fn()
jest.mock("@/lib/files/project-editor-bridge", () => ({
  registerProjectEditorOpener: (opener: NonNullable<typeof registeredOpener>) => {
    registeredOpener = opener
    return unregister
  },
}))

import { PRO_IDE_REGION_ATTR } from "@/lib/codeserver/pane-manager"
import { CodeServerPane, joinProjectPath } from "./code-server-pane"

const renderPane = (
  props: Partial<{ root: string; onRevoked: () => void; onCancelled?: () => void }> = {}
) =>
  render(
    <CodeServerPane
      root={props.root ?? "/repo"}
      ownerId="team:t1"
      onRevoked={props.onRevoked ?? jest.fn()}
      onCancelled={"onCancelled" in props ? props.onCancelled : jest.fn()}
    />
  )

beforeEach(() => {
  paneState.phase = "starting"
  paneState.mounted = false
  paneState.progress = null
  paneState.error = null
  paneState.retry = jest.fn()
  registeredOpener = undefined
  driveOpen.mockReset().mockResolvedValue(undefined)
  driveApplyEdit.mockReset().mockResolvedValue(undefined)
  openFile.mockReset().mockResolvedValue(undefined)
  cancelDownload.mockReset().mockResolvedValue(undefined)
  unregister.mockReset()
  queueDispose.mockReset()
})

it("prefers the extension (absolute path) for file navigation once ready", () => {
  paneState.phase = "ready"
  paneState.mounted = true
  const { unmount } = renderPane()

  registeredOpener?.open("src/index.ts", 9, 2)

  expect(registeredOpener?.root).toBe("/repo")
  // The extension opens by ABSOLUTE path; the CLI is not touched on the happy path.
  expect(driveOpen).toHaveBeenCalledWith("/repo", "/repo/src/index.ts", 9, 2)
  expect(openFile).not.toHaveBeenCalled()
  unmount()
  expect(unregister).toHaveBeenCalled()
  expect(queueDispose).toHaveBeenCalled()
})

it("falls back to the CLI reuse-window path when the extension isn't connected", async () => {
  paneState.phase = "ready"
  paneState.mounted = true
  driveOpen.mockRejectedValueOnce(new Error("Pro IDE extension is not connected"))
  renderPane()

  registeredOpener?.open("src/index.ts", 9, 2)
  await Promise.resolve()
  await Promise.resolve()

  // CLI fallback takes the project-RELATIVE path (Rust resolves it against root).
  expect(openFile).toHaveBeenCalledWith("/repo", "src/index.ts", 9, 2)
})

it("reflects an agent write via the extension (absolute path) once ready", () => {
  paneState.phase = "ready"
  paneState.mounted = true
  renderPane()

  registeredOpener?.applyEdit?.("src/index.ts", 9, 2)

  expect(driveApplyEdit).toHaveBeenCalledWith("/repo", "/repo/src/index.ts", 9, 2)
  expect(driveOpen).not.toHaveBeenCalled()
  expect(openFile).not.toHaveBeenCalled()
})

it("degrades a reflect to a reveal, then the CLI, when the extension can't apply", async () => {
  paneState.phase = "ready"
  paneState.mounted = true
  driveApplyEdit.mockRejectedValueOnce(new Error("not connected"))
  driveOpen.mockRejectedValueOnce(new Error("not connected"))
  renderPane()

  registeredOpener?.applyEdit?.("src/index.ts", 9, 2)
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()

  expect(driveApplyEdit).toHaveBeenCalledWith("/repo", "/repo/src/index.ts", 9, 2)
  expect(driveOpen).toHaveBeenCalledWith("/repo", "/repo/src/index.ts", 9, 2)
  expect(openFile).toHaveBeenCalledWith("/repo", "src/index.ts", 9, 2)
})

it("surfaces a dirty-buffer conflict without falling back to a reveal", async () => {
  const { toast } = jest.requireMock("sonner") as { toast: { error: jest.Mock } }
  paneState.phase = "ready"
  paneState.mounted = true
  driveApplyEdit.mockRejectedValueOnce(
    new Error("DIRTY_DOCUMENT_CONFLICT: the editor has unsaved changes")
  )
  renderPane()

  registeredOpener?.applyEdit?.("src/index.ts", 9, 2)
  await Promise.resolve()
  await Promise.resolve()

  expect(driveOpen).not.toHaveBeenCalled()
  expect(openFile).not.toHaveBeenCalled()
  expect(toast.error).toHaveBeenCalledWith("proIde.openFileFailed")
})

it("does not claim the opener before code-server can service an open", () => {
  paneState.phase = "downloading"
  renderPane()
  expect(registeredOpener).toBeUndefined()

  paneState.phase = "error"
  renderPane()
  expect(registeredOpener).toBeUndefined()
})

it("reports a navigation failure only when both the extension and the CLI fail", async () => {
  const { toast } = jest.requireMock("sonner") as { toast: { error: jest.Mock } }
  paneState.phase = "ready"
  paneState.mounted = true
  driveOpen.mockRejectedValueOnce(new Error("extension down"))
  openFile.mockRejectedValueOnce(new Error("session socket unavailable"))
  renderPane()

  registeredOpener?.open("src/index.ts", 9, 2)
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()

  expect(toast.error).toHaveBeenCalledWith("proIde.openFileFailed")
})

it("surfaces a toast and calls onRevoked when the shared pane is revoked", () => {
  const { toast } = jest.requireMock("sonner") as { toast: { info: jest.Mock } }
  toast.info.mockClear()
  const onRevoked = jest.fn()
  paneState.phase = "ready"
  paneState.mounted = true
  renderPane({ onRevoked })

  act(() => capturedOptions.onRevoked?.())

  expect(toast.info).toHaveBeenCalledWith("proIde.revokedToMonaco")
  expect(onRevoked).toHaveBeenCalled()
})

it("always renders the reserved region the webview is positioned over", () => {
  renderPane()
  expect(screen.getByTestId("code-server-region")).toBeInTheDocument()
})

it("marks the reserved region so animating ancestors can detect the native pane", () => {
  // The other half of this contract lives in `isProIdePanePinnedWithin`: a
  // layout container about to tween itself asks whether an unclippable native
  // webview is pinned inside. Drop this attribute and the artifact dock silently
  // goes back to smearing VS Code across the chat on collapse.
  renderPane()
  expect(screen.getByTestId("code-server-region")).toHaveAttribute(PRO_IDE_REGION_ATTR)
})

it("shows a spinner + starting label while spawning", () => {
  paneState.phase = "starting"
  renderPane()
  expect(screen.getByTestId("code-server-loading")).toBeInTheDocument()
  expect(screen.getByText("proIde.starting")).toBeInTheDocument()
})

it("shows the downloading label while fetching code-server", () => {
  paneState.phase = "downloading"
  paneState.progress = 0.42
  renderPane()
  expect(screen.getByText("proIde.downloading")).toBeInTheDocument()
})

it("hides the overlay once the native webview is actually mounted", () => {
  paneState.phase = "ready"
  paneState.mounted = true
  renderPane()
  expect(screen.queryByTestId("code-server-loading")).not.toBeInTheDocument()
  expect(screen.getByTestId("code-server-region")).toBeInTheDocument()
})

it("keeps the placeholder up between ready and the webview landing", () => {
  // code-server answers /healthz before the native webview paints; dropping the
  // placeholder on `phase` alone flashes bare background in that gap.
  paneState.phase = "ready"
  paneState.mounted = false
  renderPane()
  expect(screen.getByTestId("code-server-loading")).toBeInTheDocument()
})

describe("cancelling the first-run download", () => {
  it("offers a way out while the download is in flight", () => {
    // ~100-200MB with no exit turned a mis-click on the engine toggle into a
    // commitment to the whole transfer.
    paneState.phase = "downloading"
    paneState.progress = 0.1
    renderPane()

    expect(screen.getByTestId("code-server-cancel")).toBeInTheDocument()
  })

  it("also offers it while merely starting, which can sit a while", () => {
    paneState.phase = "starting"
    renderPane()

    expect(screen.getByTestId("code-server-cancel")).toBeInTheDocument()
  })

  it("aborts the backend download and hands the host back to Monaco", () => {
    paneState.phase = "downloading"
    paneState.progress = 0.5
    const onCancelled = jest.fn()
    renderPane({ onCancelled })

    fireEvent.click(screen.getByTestId("code-server-cancel"))

    expect(cancelDownload).toHaveBeenCalled()
    expect(onCancelled).toHaveBeenCalled()
  })

  it("never lets a failed cancel raise at the user", () => {
    paneState.phase = "downloading"
    paneState.progress = 0.5
    cancelDownload.mockRejectedValueOnce(new Error("ipc down"))
    const onCancelled = jest.fn()
    renderPane({ onCancelled })

    expect(() => fireEvent.click(screen.getByTestId("code-server-cancel"))).not.toThrow()
    expect(onCancelled).toHaveBeenCalled()
  })

  it("hides the affordance for a host that cannot switch engines", () => {
    paneState.phase = "downloading"
    paneState.progress = 0.5
    renderPane({ onCancelled: undefined })

    expect(screen.queryByTestId("code-server-cancel")).not.toBeInTheDocument()
  })

  it("is gone once the pane is ready", () => {
    paneState.phase = "ready"
    paneState.mounted = true
    renderPane()

    expect(screen.queryByTestId("code-server-cancel")).not.toBeInTheDocument()
  })
})

it("renders a real progress bar while downloading", () => {
  paneState.phase = "downloading"
  paneState.progress = 0.42
  renderPane()
  const bar = screen.getByTestId("code-server-progress")
  expect(bar).toBeInTheDocument()
  // The vendored shadcn `Progress` never forwards `value` to the Radix root, so
  // the fill lives entirely in the indicator's transform — assert what actually
  // renders rather than an `aria-valuenow` this component does not emit.
  expect(bar.querySelector('[data-slot="progress-indicator"]')).toHaveStyle({
    transform: "translateX(-58%)",
  })
})

it("shows no progress bar when the download size is unknown", () => {
  paneState.phase = "downloading"
  paneState.progress = null
  renderPane()
  expect(screen.queryByTestId("code-server-progress")).not.toBeInTheDocument()
})

it("explains the unsupported platform and points at local VS Code", () => {
  paneState.phase = "unsupported"
  renderPane()
  expect(screen.getByTestId("code-server-unsupported")).toBeInTheDocument()
  expect(screen.getByText("proIde.unsupportedTitle")).toBeInTheDocument()
})

it("shows the error + retry, and retry invokes the hook", () => {
  paneState.phase = "error"
  paneState.error = "spawn code-server: ENOENT"
  renderPane()
  expect(screen.getByTestId("code-server-error")).toBeInTheDocument()
  expect(screen.getByText("spawn code-server: ENOENT")).toBeInTheDocument()
  fireEvent.click(screen.getByText("proIde.retry"))
  expect(paneState.retry).toHaveBeenCalled()
})

describe("joinProjectPath", () => {
  it("joins a root and a project-relative path into an absolute path", () => {
    expect(joinProjectPath("/repo", "src/index.ts")).toBe("/repo/src/index.ts")
  })
  it("normalizes a trailing root slash and a leading relative slash", () => {
    expect(joinProjectPath("/repo/", "/src/index.ts")).toBe("/repo/src/index.ts")
  })
  it("returns the bare root when the relative path is empty", () => {
    expect(joinProjectPath("/repo/", "")).toBe("/repo")
  })
})
