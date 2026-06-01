/**
 * @jest-environment jsdom
 */

import React from "react"
import { render, screen, waitFor } from "@testing-library/react"

const syncTrustedWorkspacesToRust = jest.fn()
jest.mock("@/lib/claude/hook-trust-sync", () => ({
  syncTrustedWorkspacesToRust: () => syncTrustedWorkspacesToRust(),
}))

import { HookTrustSyncProvider } from "./hook-trust-sync-provider"

beforeEach(() => {
  syncTrustedWorkspacesToRust.mockReset()
  syncTrustedWorkspacesToRust.mockResolvedValue(undefined)
})

it("syncs the trust gate once on mount and renders children", async () => {
  render(
    <HookTrustSyncProvider>
      <span>child</span>
    </HookTrustSyncProvider>
  )
  expect(screen.getByText("child")).toBeInTheDocument()
  await waitFor(() => expect(syncTrustedWorkspacesToRust).toHaveBeenCalledTimes(1))
})
