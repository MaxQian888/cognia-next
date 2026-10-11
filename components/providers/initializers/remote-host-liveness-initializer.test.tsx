/** @jest-environment jsdom */
import { render, waitFor } from "@testing-library/react"

const hasCapabilityMock = jest.fn(() => true)
jest.mock("@/lib/platform/capabilities", () => ({
  hasCapability: (...args: unknown[]) => hasCapabilityMock(...(args as [])),
}))
const acquireLockMock = jest.fn(async () => true)
jest.mock("@/lib/runtime/exclusive-web-lock", () => ({
  acquireExclusiveWebLock: (...args: unknown[]) => acquireLockMock(...(args as [])),
}))
const stopLoop = jest.fn()
const startLoop = jest.fn(() => stopLoop)
jest.mock("@/lib/remote-host/liveness", () => ({
  startHostLivenessLoop: () => startLoop(),
}))

import {
  HOST_LIVENESS_LOCK,
  RemoteHostLivenessInitializer,
} from "./remote-host-liveness-initializer"

beforeEach(() => {
  jest.clearAllMocks()
  hasCapabilityMock.mockReturnValue(true)
  acquireLockMock.mockResolvedValue(true)
})

it("starts the liveness loop on the desktop under one lock, and stops it on unmount", async () => {
  const { unmount } = render(<RemoteHostLivenessInitializer />)
  await waitFor(() => expect(startLoop).toHaveBeenCalledTimes(1))
  expect(hasCapabilityMock).toHaveBeenCalledWith("always-on")
  expect(acquireLockMock).toHaveBeenCalledWith(HOST_LIVENESS_LOCK, expect.any(AbortSignal))
  unmount()
  expect(stopLoop).toHaveBeenCalledTimes(1)
})

it("does nothing on a shell without paired hosts to manage", async () => {
  hasCapabilityMock.mockReturnValue(false)
  render(<RemoteHostLivenessInitializer />)
  await Promise.resolve()
  expect(acquireLockMock).not.toHaveBeenCalled()
  expect(startLoop).not.toHaveBeenCalled()
})

it("leaves probing to the webview that holds the lock", async () => {
  acquireLockMock.mockResolvedValue(false)
  render(<RemoteHostLivenessInitializer />)
  await waitFor(() => expect(acquireLockMock).toHaveBeenCalled())
  await Promise.resolve()
  expect(startLoop).not.toHaveBeenCalled()
})
