/**
 * @jest-environment jsdom
 */
import { render, waitFor } from "@testing-library/react"

const startWebviewHeartbeat = jest.fn()
const takeWhiteScreenRecoveryNotice = jest.fn()
jest.mock("@/lib/tauri/webview-watchdog", () => ({
  startWebviewHeartbeat: () => startWebviewHeartbeat(),
  takeWhiteScreenRecoveryNotice: () => takeWhiteScreenRecoveryNotice(),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const toastSuccess = jest.fn()
jest.mock("sonner", () => ({
  toast: { success: (...args: unknown[]) => toastSuccess(...args) },
}))

import { WebviewHeartbeatInitializer } from "./webview-heartbeat-initializer"

beforeEach(() => {
  startWebviewHeartbeat.mockReset()
  takeWhiteScreenRecoveryNotice.mockReset().mockResolvedValue(false)
  toastSuccess.mockReset()
})

test("renders nothing and starts the heartbeat on mount", async () => {
  const { container } = render(<WebviewHeartbeatInitializer />)
  expect(container).toBeEmptyDOMElement()
  await waitFor(() => expect(startWebviewHeartbeat).toHaveBeenCalledTimes(1))
})

test("does not toast when there was no recovery", async () => {
  takeWhiteScreenRecoveryNotice.mockResolvedValue(false)
  render(<WebviewHeartbeatInitializer />)
  await waitFor(() => expect(takeWhiteScreenRecoveryNotice).toHaveBeenCalled())
  expect(toastSuccess).not.toHaveBeenCalled()
})

test("toasts the recovery notice when Rust reports a recovery", async () => {
  takeWhiteScreenRecoveryNotice.mockResolvedValue(true)
  render(<WebviewHeartbeatInitializer />)
  await waitFor(() =>
    expect(toastSuccess).toHaveBeenCalledWith(
      "recoveredTitle",
      expect.objectContaining({ description: "recoveredDescription" })
    )
  )
})
