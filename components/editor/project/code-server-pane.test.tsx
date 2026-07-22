/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({ useTranslations: () => (k: string) => k }))
jest.mock("sonner", () => ({ toast: { error: jest.fn() } }))

const paneState = {
  phase: "starting" as "unsupported" | "starting" | "downloading" | "ready" | "error",
  mounted: false,
  progress: null as number | null,
  error: null as string | null,
  retry: jest.fn(),
}
jest.mock("@/hooks/codeserver/use-code-server-pane", () => ({
  useCodeServerPane: () => paneState,
}))
const driveOpen = jest.fn()
jest.mock("@/lib/codeserver/client", () => ({
  codeServerClient: { openFile: (...args: unknown[]) => driveOpen(...args) },
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
  { root: string; open: (path: string, line?: number, column?: number) => void } | undefined
const unregister = jest.fn()
jest.mock("@/lib/files/project-editor-bridge", () => ({
  registerProjectEditorOpener: (opener: NonNullable<typeof registeredOpener>) => {
    registeredOpener = opener
    return unregister
  },
}))

import { CodeServerPane } from "./code-server-pane"

const renderPane = (props: Partial<{ root: string; onRevoked: () => void }> = {}) =>
  render(
    <CodeServerPane
      root={props.root ?? "/repo"}
      ownerId="team:t1"
      onRevoked={props.onRevoked ?? jest.fn()}
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
  unregister.mockReset()
  queueDispose.mockReset()
})

it("registers file navigation for the active CodeServer root once ready", () => {
  paneState.phase = "ready"
  paneState.mounted = true
  const { unmount } = renderPane()

  registeredOpener?.open("src/index.ts", 9, 2)

  expect(registeredOpener?.root).toBe("/repo")
  expect(driveOpen).toHaveBeenCalledWith("/repo", "src/index.ts", 9, 2)
  unmount()
  expect(unregister).toHaveBeenCalled()
  expect(queueDispose).toHaveBeenCalled()
})

it("does not claim the opener before code-server can service an open", () => {
  paneState.phase = "downloading"
  renderPane()
  expect(registeredOpener).toBeUndefined()

  paneState.phase = "error"
  renderPane()
  expect(registeredOpener).toBeUndefined()
})

it("reports file navigation failures", async () => {
  const { toast } = jest.requireMock("sonner") as { toast: { error: jest.Mock } }
  paneState.phase = "ready"
  paneState.mounted = true
  driveOpen.mockRejectedValueOnce(new Error("session socket unavailable"))
  renderPane()

  registeredOpener?.open("src/index.ts", 9, 2)
  await Promise.resolve()

  expect(toast.error).toHaveBeenCalledWith("proIde.openFileFailed")
})

it("always renders the reserved region the webview is positioned over", () => {
  renderPane()
  expect(screen.getByTestId("code-server-region")).toBeInTheDocument()
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
