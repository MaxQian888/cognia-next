/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"

import { ComposerSessionProvider, useComposerSessionId } from "./composer-session-context"

function Probe() {
  const id = useComposerSessionId()
  return <span data-testid="probe">{id === undefined ? "undefined" : String(id)}</span>
}

it("hands the surrounding composer's conversation to its controls", () => {
  render(
    <ComposerSessionProvider value="session-b">
      <Probe />
    </ComposerSessionProvider>
  )
  expect(screen.getByTestId("probe")).toHaveTextContent("session-b")
})

it("reads undefined outside a provider, which the store treats as the focused conversation", () => {
  // The degradation that keeps every pre-split call site behaving exactly as
  // it did: no provider, no opinion, actions fall back to focus.
  render(<Probe />)
  expect(screen.getByTestId("probe")).toHaveTextContent("undefined")
})

it("distinguishes 'no conversation yet' from 'no provider'", () => {
  // A composer mounted before its session exists passes null on purpose; the
  // store reads that as the pre-session ephemeral case rather than as focus.
  render(
    <ComposerSessionProvider value={null}>
      <Probe />
    </ComposerSessionProvider>
  )
  expect(screen.getByTestId("probe")).toHaveTextContent("null")
})

it("lets a nested composer override the one above it", () => {
  // Split view nests two composers in one tree; the inner one wins for its
  // own controls.
  render(
    <ComposerSessionProvider value="session-a">
      <ComposerSessionProvider value="session-b">
        <Probe />
      </ComposerSessionProvider>
    </ComposerSessionProvider>
  )
  expect(screen.getByTestId("probe")).toHaveTextContent("session-b")
})
