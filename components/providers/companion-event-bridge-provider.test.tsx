/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"
import { CompanionEventBridgeProvider } from "./companion-event-bridge-provider"

const detachEventBridge = jest.fn()
const detachDesktopSignaling = jest.fn()
const detachCompanionSignaling = jest.fn()
const installEventBridge = jest.fn(() => detachEventBridge)
const installDesktopSignaling = jest.fn(() => detachDesktopSignaling)
const installCompanionSignaling = jest.fn(() => detachCompanionSignaling)

jest.mock("@/lib/companion/event-bridge", () => ({
  installCompanionEventBridge: () => installEventBridge(),
}))

jest.mock("@/lib/signaling", () => ({
  installDesktopSignalingController: () => installDesktopSignaling(),
  installCompanionSignalingController: () => installCompanionSignaling(),
}))

jest.mock("./companion-outbound-runner-provider", () => ({
  CompanionOutboundRunnerProvider: () => <span data-testid="outbound-runner" />,
}))

beforeEach(() => {
  jest.clearAllMocks()
})

it("mounts all companion bridges and detaches them with the provider", () => {
  const view = render(
    <CompanionEventBridgeProvider>
      <span>child</span>
    </CompanionEventBridgeProvider>
  )

  expect(screen.getByText("child")).toBeInTheDocument()
  expect(screen.getByTestId("outbound-runner")).toBeInTheDocument()
  expect(installEventBridge).toHaveBeenCalledTimes(1)
  expect(installDesktopSignaling).toHaveBeenCalledTimes(1)
  expect(installCompanionSignaling).toHaveBeenCalledTimes(1)

  view.unmount()
  expect(detachEventBridge).toHaveBeenCalledTimes(1)
  expect(detachDesktopSignaling).toHaveBeenCalledTimes(1)
  expect(detachCompanionSignaling).toHaveBeenCalledTimes(1)
})

it("rebinds the event bridge and companion signaling after the web target changes", () => {
  const view = render(
    <CompanionEventBridgeProvider>
      <span>child</span>
    </CompanionEventBridgeProvider>
  )

  window.dispatchEvent(new Event("cognia:companion-config-changed"))

  expect(detachEventBridge).toHaveBeenCalledTimes(1)
  expect(detachCompanionSignaling).toHaveBeenCalledTimes(1)
  expect(installEventBridge).toHaveBeenCalledTimes(2)
  expect(installCompanionSignaling).toHaveBeenCalledTimes(2)
  expect(installDesktopSignaling).toHaveBeenCalledTimes(1)

  view.unmount()
  expect(detachEventBridge).toHaveBeenCalledTimes(2)
  expect(detachCompanionSignaling).toHaveBeenCalledTimes(2)
  expect(detachDesktopSignaling).toHaveBeenCalledTimes(1)
})
