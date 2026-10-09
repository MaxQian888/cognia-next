/** @jest-environment jsdom */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

const mockAuthorize = jest.fn()
let mockTransport = "tauri-channel"
jest.mock("@/lib/terminal/host-settings", () => ({
  authorizeTerminalHostCredentials: () => mockAuthorize(),
}))
jest.mock("@/lib/terminal/pick-transport", () => ({
  selectTerminalTransportChain: () => [mockTransport],
}))

import { useTerminalStore } from "@/stores/terminal/terminal-store"
import { TerminalHostStateBanner } from "./terminal-host-state-banner"

beforeEach(() => {
  useTerminalStore.getState().reset()
  mockAuthorize.mockReset()
  mockTransport = "tauri-channel"
})

it("stays hidden while the durable host is online", () => {
  const { container } = render(
    <TerminalHostStateBanner onRetry={jest.fn()} onOpenSettings={jest.fn()} />
  )
  expect(container).toBeEmptyDOMElement()
})

it("offers retry for an offline host and settings for authorization failures", () => {
  const retry = jest.fn()
  const openSettings = jest.fn()
  act(() => useTerminalStore.getState().setHostState("offline"))
  const { rerender } = render(
    <TerminalHostStateBanner onRetry={retry} onOpenSettings={openSettings} />
  )
  fireEvent.click(screen.getByRole("button"))
  expect(retry).toHaveBeenCalled()

  act(() => useTerminalStore.getState().setHostState("unauthorized"))
  rerender(<TerminalHostStateBanner onRetry={retry} onOpenSettings={openSettings} />)
  fireEvent.click(screen.getByRole("button"))
  expect(openSettings).toHaveBeenCalled()
})

// A retry cannot turn a switch back on. Sending the user to settings is the
// only button that leads anywhere.
it("sends the user to settings when the host's remote-access switch is off", () => {
  const retry = jest.fn()
  const openSettings = jest.fn()
  act(() => useTerminalStore.getState().setHostState("remote_access_disabled"))
  render(<TerminalHostStateBanner onRetry={retry} onOpenSettings={openSettings} />)
  expect(screen.getByTestId("terminal-host-state-banner")).toHaveAttribute(
    "data-state",
    "remote_access_disabled"
  )
  fireEvent.click(screen.getByRole("button"))
  expect(openSettings).toHaveBeenCalled()
  expect(retry).not.toHaveBeenCalled()
})

it("authorizes saved credentials only after a click and waits before retrying", async () => {
  let complete!: () => void
  mockAuthorize.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        complete = resolve
      })
  )
  useTerminalStore
    .getState()
    .setHostState("credential_unavailable", "terminal credential read failed")
  const retry = jest.fn()
  render(<TerminalHostStateBanner onRetry={retry} onOpenSettings={jest.fn()} />)
  expect(mockAuthorize).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "Authorize access" }))
  expect(screen.getByRole("button", { name: "Authorizing…" })).toBeDisabled()
  fireEvent.click(screen.getByRole("button"))
  expect(mockAuthorize).toHaveBeenCalledTimes(1)
  expect(retry).not.toHaveBeenCalled()
  await act(async () => complete())
  expect(retry).toHaveBeenCalledTimes(1)
})

it("keeps refused authorization visible and lets the user try again", async () => {
  mockAuthorize.mockRejectedValue("terminal_credential_unavailable: cancelled")
  useTerminalStore.getState().setHostState("credential_unavailable")
  const retry = jest.fn()
  render(<TerminalHostStateBanner onRetry={retry} onOpenSettings={jest.fn()} />)
  fireEvent.click(screen.getByRole("button", { name: "Authorize access" }))
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Authorize access" })).toBeEnabled()
  )
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Authorization did not complete. You can try again."
  )
  expect(useTerminalStore.getState().hostState).toBe("credential_unavailable")
  expect(useTerminalStore.getState().hostStateMessage).toBe(
    "terminal_credential_unavailable: cancelled"
  )
  expect(retry).not.toHaveBeenCalled()
})

it("does not authorize a remote host's credentials from this device", () => {
  mockTransport = "ws"
  useTerminalStore.getState().setHostState("credential_unavailable")
  const openSettings = jest.fn()
  render(<TerminalHostStateBanner onRetry={jest.fn()} onOpenSettings={openSettings} />)
  fireEvent.click(screen.getByRole("button", { name: "Open settings" }))
  expect(openSettings).toHaveBeenCalledTimes(1)
  expect(mockAuthorize).not.toHaveBeenCalled()
})

it("clears a refused authorization after the host recovers", async () => {
  mockAuthorize.mockRejectedValue("terminal_credential_unavailable: cancelled")
  useTerminalStore.getState().setHostState("credential_unavailable")
  render(<TerminalHostStateBanner onRetry={jest.fn()} onOpenSettings={jest.fn()} />)
  fireEvent.click(screen.getByRole("button", { name: "Authorize access" }))
  await screen.findByRole("alert")

  act(() => useTerminalStore.getState().setHostState("online"))
  act(() => useTerminalStore.getState().setHostState("offline"))
  expect(screen.queryByRole("alert")).not.toBeInTheDocument()
})
