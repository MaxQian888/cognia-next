/**
 * @jest-environment jsdom
 */

import React from "react"
import { render, screen, waitFor } from "@testing-library/react"

const syncTrustedWorkspacesToRust = jest.fn()
jest.mock("@/lib/claude/hook-trust-sync", () => ({
  syncTrustedWorkspacesToRust: () => syncTrustedWorkspacesToRust(),
}))

const syncAllowedRootsToRust = jest.fn()
jest.mock("@/lib/files/allowed-roots-sync", () => ({
  syncAllowedRootsToRust: () => syncAllowedRootsToRust(),
}))

const subscribeUnsub = jest.fn()
const subscribe = jest.fn((..._a: unknown[]) => subscribeUnsub)
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: { subscribe: (...a: unknown[]) => subscribe(...a) },
}))

import { HookTrustSyncProvider } from "./hook-trust-sync-provider"

beforeEach(() => {
  syncTrustedWorkspacesToRust.mockReset().mockResolvedValue(undefined)
  syncAllowedRootsToRust.mockReset().mockResolvedValue(undefined)
  subscribe.mockClear()
  subscribeUnsub.mockClear()
})

it("syncs the trust gate + allowed roots once on mount and renders children", async () => {
  render(
    <HookTrustSyncProvider>
      <span>child</span>
    </HookTrustSyncProvider>
  )
  expect(screen.getByText("child")).toBeInTheDocument()
  await waitFor(() => expect(syncTrustedWorkspacesToRust).toHaveBeenCalledTimes(1))
  expect(syncAllowedRootsToRust).toHaveBeenCalledTimes(1)
  expect(subscribe).toHaveBeenCalledTimes(1)
})

it("re-syncs allowed roots only when the projects array changes", async () => {
  render(
    <HookTrustSyncProvider>
      <span>child</span>
    </HookTrustSyncProvider>
  )
  await waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1))
  const listener = subscribe.mock.calls[0][0] as (s: unknown, p: unknown) => void
  const projects = [{ id: "p1" }]
  syncAllowedRootsToRust.mockClear()
  listener({ projects }, { projects }) // unchanged ref → no re-sync
  expect(syncAllowedRootsToRust).not.toHaveBeenCalled()
  listener({ projects: [{ id: "p2" }] }, { projects }) // changed ref → re-sync
  expect(syncAllowedRootsToRust).toHaveBeenCalledTimes(1)
})

it("unsubscribes from the project store on unmount", () => {
  const { unmount } = render(
    <HookTrustSyncProvider>
      <span>child</span>
    </HookTrustSyncProvider>
  )
  unmount()
  expect(subscribeUnsub).toHaveBeenCalledTimes(1)
})
