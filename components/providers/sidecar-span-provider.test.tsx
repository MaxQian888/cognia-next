import { render, waitFor } from "@testing-library/react"

const subscribeMock = jest.fn()
const isTauriMock = jest.fn()

jest.mock("@/lib/agent-trace/sidecar-span-bridge", () => ({
  subscribeToSidecarSpans: () => subscribeMock(),
}))
jest.mock("@/lib/tauri", () => ({
  isTauri: () => isTauriMock(),
}))

import { SidecarSpanProvider } from "./sidecar-span-provider"

beforeEach(() => {
  subscribeMock.mockReset()
  isTauriMock.mockReset()
  isTauriMock.mockReturnValue(true)
})

it("renders children", () => {
  isTauriMock.mockReturnValue(false)
  const { getByText } = render(
    <SidecarSpanProvider>
      <span>child</span>
    </SidecarSpanProvider>
  )
  expect(getByText("child")).toBeInTheDocument()
})

it("does not subscribe outside Tauri", () => {
  isTauriMock.mockReturnValue(false)
  render(<SidecarSpanProvider>{null}</SidecarSpanProvider>)
  // `onClaudeMessage` needs the IPC listener, which only exists in the shell.
  expect(subscribeMock).not.toHaveBeenCalled()
})

it("subscribes inside Tauri and unsubscribes on unmount", async () => {
  const unlisten = jest.fn()
  subscribeMock.mockResolvedValue(unlisten)
  const { unmount } = render(<SidecarSpanProvider>{null}</SidecarSpanProvider>)
  await waitFor(() => expect(subscribeMock).toHaveBeenCalledTimes(1))
  unmount()
  await waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1))
})

it("releases a subscription that resolves after unmount", async () => {
  const unlisten = jest.fn()
  let resolve: (fn: () => void) => void = () => {}
  subscribeMock.mockReturnValue(
    new Promise<() => void>((r) => {
      resolve = r
    })
  )
  const { unmount } = render(<SidecarSpanProvider>{null}</SidecarSpanProvider>)
  unmount()
  resolve(unlisten)
  // Otherwise the listener leaks for the life of the process.
  await waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1))
})

it("keeps rendering when the IPC bus is unavailable", async () => {
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
  subscribeMock.mockRejectedValue(new Error("no ipc"))
  const { getByText } = render(
    <SidecarSpanProvider>
      <span>still here</span>
    </SidecarSpanProvider>
  )
  await waitFor(() => expect(warn).toHaveBeenCalled())
  expect(getByText("still here")).toBeInTheDocument()
  warn.mockRestore()
})
