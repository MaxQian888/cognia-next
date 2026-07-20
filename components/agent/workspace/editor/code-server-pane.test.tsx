/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({ useTranslations: () => (k: string) => k }))
jest.mock("sonner", () => ({ toast: { error: jest.fn() } }))

const paneState = {
  phase: "starting" as "idle" | "unsupported" | "starting" | "downloading" | "ready" | "error",
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
let registeredOpener: { root: string; open: (path: string, line?: number, column?: number) => void }
const unregister = jest.fn()
jest.mock("@/lib/files/project-editor-bridge", () => ({
  registerProjectEditorOpener: (opener: typeof registeredOpener) => {
    registeredOpener = opener
    return unregister
  },
}))

import { CodeServerPane } from "./code-server-pane"

beforeEach(() => {
  paneState.phase = "starting"
  paneState.progress = null
  paneState.error = null
  paneState.retry = jest.fn()
  driveOpen.mockReset().mockResolvedValue(undefined)
  unregister.mockReset()
})

it("registers file navigation for the active CodeServer root", () => {
  const { unmount } = render(<CodeServerPane root="/repo" />)

  registeredOpener.open("src/index.ts", 9, 2)

  expect(registeredOpener.root).toBe("/repo")
  expect(driveOpen).toHaveBeenCalledWith("/repo", "src/index.ts", 9, 2)
  unmount()
  expect(unregister).toHaveBeenCalled()
})

it("reports file navigation failures", async () => {
  const { toast } = jest.requireMock("sonner") as { toast: { error: jest.Mock } }
  driveOpen.mockRejectedValueOnce(new Error("session socket unavailable"))
  render(<CodeServerPane root="/repo" />)

  registeredOpener.open("src/index.ts", 9, 2)
  await Promise.resolve()

  expect(toast.error).toHaveBeenCalledWith("proIde.openFileFailed")
})

it("always renders the reserved region the webview is positioned over", () => {
  render(<CodeServerPane root="/repo" />)
  expect(screen.getByTestId("code-server-region")).toBeInTheDocument()
})

it("shows a spinner + starting label while spawning", () => {
  paneState.phase = "starting"
  render(<CodeServerPane root="/repo" />)
  expect(screen.getByTestId("code-server-loading")).toBeInTheDocument()
  expect(screen.getByText("proIde.starting")).toBeInTheDocument()
})

it("shows the downloading label while fetching code-server", () => {
  paneState.phase = "downloading"
  paneState.progress = 0.42
  render(<CodeServerPane root="/repo" />)
  expect(screen.getByText("proIde.downloading")).toBeInTheDocument()
})

it("hides the overlay once ready so the native webview shows through", () => {
  paneState.phase = "ready"
  render(<CodeServerPane root="/repo" />)
  expect(screen.queryByTestId("code-server-loading")).not.toBeInTheDocument()
  expect(screen.getByTestId("code-server-region")).toBeInTheDocument()
})

it("explains the unsupported platform and points at local VS Code", () => {
  paneState.phase = "unsupported"
  render(<CodeServerPane root="/repo" />)
  expect(screen.getByTestId("code-server-unsupported")).toBeInTheDocument()
  expect(screen.getByText("proIde.unsupportedTitle")).toBeInTheDocument()
})

it("shows the error + retry, and retry invokes the hook", () => {
  paneState.phase = "error"
  paneState.error = "spawn code-server: ENOENT"
  render(<CodeServerPane root="/repo" />)
  expect(screen.getByTestId("code-server-error")).toBeInTheDocument()
  expect(screen.getByText("spawn code-server: ENOENT")).toBeInTheDocument()
  fireEvent.click(screen.getByText("proIde.retry"))
  expect(paneState.retry).toHaveBeenCalled()
})
