import { render, screen, waitFor } from "@testing-library/react"

const checkMock = jest.fn(async (..._a: unknown[]) => ({ newer: false }) as { newer: boolean })
jest.mock("@/lib/webdav/startup-check", () => ({
  checkRemoteNewerThanLocal: (...a: unknown[]) => checkMock(...a),
}))

const toastInfo = jest.fn()
jest.mock("sonner", () => ({
  toast: { info: (msg: string, opts: unknown) => toastInfo(msg, opts) },
}))

// Capture the controlled dialog's open state.
jest.mock("@/components/data/import/webdav-restore-dialog", () => ({
  WebDavRestoreDialog: ({ open }: { open?: boolean }) => (
    <div data-testid="restore-dialog">{open ? "open" : "closed"}</div>
  ),
}))

import { WebDavStartupPromptProvider } from "./webdav-startup-prompt-provider"

const ORIGINAL_ENV = process.env.NODE_ENV

function setNodeEnv(value: string) {
  ;(process.env as Record<string, string>).NODE_ENV = value
}

afterEach(() => {
  setNodeEnv(ORIGINAL_ENV as string)
  checkMock.mockReset()
  checkMock.mockResolvedValue({ newer: false })
  toastInfo.mockClear()
})

describe("WebDavStartupPromptProvider", () => {
  it("renders children and skips the check in test mode", async () => {
    render(
      <WebDavStartupPromptProvider>
        <span>child</span>
      </WebDavStartupPromptProvider>
    )
    expect(screen.getByText("child")).toBeInTheDocument()
    // Guarded out under NODE_ENV=test.
    expect(checkMock).not.toHaveBeenCalled()
  })

  it("shows a toast when the remote snapshot is newer", async () => {
    setNodeEnv("development")
    checkMock.mockResolvedValue({ newer: true })
    render(
      <WebDavStartupPromptProvider>
        <span>child</span>
      </WebDavStartupPromptProvider>
    )
    await waitFor(() => expect(toastInfo).toHaveBeenCalled())
    // The toast action opens the (controlled) restore dialog.
    const [, opts] = toastInfo.mock.calls[0] as [string, { action: { onClick: () => void } }]
    expect(typeof opts.action.onClick).toBe("function")
  })

  it("stays quiet when the remote is not newer", async () => {
    setNodeEnv("development")
    checkMock.mockResolvedValue({ newer: false })
    render(
      <WebDavStartupPromptProvider>
        <span>child</span>
      </WebDavStartupPromptProvider>
    )
    await waitFor(() => expect(checkMock).toHaveBeenCalled())
    expect(toastInfo).not.toHaveBeenCalled()
  })
})
