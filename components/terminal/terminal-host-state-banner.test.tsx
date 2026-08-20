/** @jest-environment jsdom */

import { act, fireEvent, render, screen } from "@testing-library/react"

import { useTerminalStore } from "@/stores/terminal/terminal-store"
import { TerminalHostStateBanner } from "./terminal-host-state-banner"

beforeEach(() => useTerminalStore.getState().reset())

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
