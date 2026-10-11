/** @jest-environment jsdom */
import { render, waitFor } from "@testing-library/react"

const stop = jest.fn()
const install = jest.fn(() => ({ ready: Promise.resolve(), stop }))
let mockDeps: unknown = { load: jest.fn(), subscribe: jest.fn() }
jest.mock("@/lib/host-secrets/provider-key-overlay", () => ({
  defaultHostProviderKeyDeps: () => mockDeps,
  installHostProviderKeys: (...args: unknown[]) => install(...(args as [])),
}))

import { HostProviderKeysInitializer } from "./host-provider-keys-initializer"

beforeEach(() => {
  jest.clearAllMocks()
  mockDeps = { load: jest.fn(), subscribe: jest.fn() }
})

it("loads this host's sealed provider keys and stops following them on unmount", async () => {
  const { unmount } = render(<HostProviderKeysInitializer />)
  await waitFor(() => expect(install).toHaveBeenCalledWith(mockDeps))
  unmount()
  expect(stop).toHaveBeenCalledTimes(1)
})

it("does nothing in a shell with no host secret store", async () => {
  mockDeps = null
  render(<HostProviderKeysInitializer />)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(install).not.toHaveBeenCalled()
})
