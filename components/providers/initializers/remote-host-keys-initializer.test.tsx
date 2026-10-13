/** @jest-environment jsdom */
import { render, waitFor } from "@testing-library/react"

const stop = jest.fn()
const follow = jest.fn(() => ({ ready: Promise.resolve(), stop }))
jest.mock("@/lib/host-secrets/remote-host-keys-follower", () => ({
  followRemoteHostKeys: (...args: unknown[]) => follow(...(args as [])),
}))

import { RemoteHostKeysInitializer } from "./remote-host-keys-initializer"

beforeEach(() => jest.clearAllMocks())

it("follows the driven Host's provider keys and stops on unmount", async () => {
  const { unmount } = render(<RemoteHostKeysInitializer />)
  await waitFor(() => expect(follow).toHaveBeenCalledTimes(1))
  unmount()
  expect(stop).toHaveBeenCalledTimes(1)
})

it("does not start following once unmounted before the module loads", async () => {
  const { unmount } = render(<RemoteHostKeysInitializer />)
  unmount()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(follow).not.toHaveBeenCalled()
})
