/**
 * @jest-environment jsdom
 */

import { render, waitFor } from "@testing-library/react"

const resolveLogtoSession = jest.fn()
const discardLegacyGlobalLogtoSession = jest.fn()
jest.mock("@/lib/logto/app-session", () => ({
  resolveLogtoSession: (...args: unknown[]) => resolveLogtoSession(...args),
}))
jest.mock("@/lib/logto/session-store", () => ({
  discardLegacyGlobalLogtoSession: () => discardLegacyGlobalLogtoSession(),
}))

let mockUnlocked: string | null = null
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: (selector: (state: { unlockedAccountId: string | null }) => unknown) =>
    selector({ unlockedAccountId: mockUnlocked }),
}))

import { CloudIdentityInitializer } from "./cloud-identity-initializer"

beforeEach(() => {
  jest.clearAllMocks()
  mockUnlocked = null
  resolveLogtoSession.mockResolvedValue({ status: "none" })
  discardLegacyGlobalLogtoSession.mockResolvedValue(false)
})

describe("<CloudIdentityInitializer />", () => {
  it("does nothing while no profile is unlocked", () => {
    render(<CloudIdentityInitializer />)
    expect(discardLegacyGlobalLogtoSession).not.toHaveBeenCalled()
    expect(resolveLogtoSession).not.toHaveBeenCalled()
  })

  it("discards the legacy global session and resolves the profile's session once per unlock", async () => {
    mockUnlocked = "acct_a"
    const view = render(<CloudIdentityInitializer />)
    await waitFor(() => expect(resolveLogtoSession).toHaveBeenCalledTimes(1))
    expect(discardLegacyGlobalLogtoSession).toHaveBeenCalledTimes(1)
    expect(resolveLogtoSession).toHaveBeenCalledWith({ localAccountId: "acct_a" })

    // A re-render for the same profile is not a second boot.
    view.rerender(<CloudIdentityInitializer />)
    await waitFor(() => expect(resolveLogtoSession).toHaveBeenCalledTimes(1))
  })

  it("runs again for a different profile", async () => {
    mockUnlocked = "acct_a"
    const view = render(<CloudIdentityInitializer />)
    await waitFor(() => expect(resolveLogtoSession).toHaveBeenCalledTimes(1))
    mockUnlocked = "acct_b"
    view.rerender(<CloudIdentityInitializer />)
    await waitFor(() => expect(resolveLogtoSession).toHaveBeenCalledTimes(2))
    expect(resolveLogtoSession).toHaveBeenLastCalledWith({ localAccountId: "acct_b" })
  })

  it("survives a discarded legacy blob and a lapsed login (both are logged, not thrown)", async () => {
    mockUnlocked = "acct_a"
    discardLegacyGlobalLogtoSession.mockResolvedValue(true)
    resolveLogtoSession.mockResolvedValue({
      status: "reauth-required",
      reason: "expired",
      metadata: { issuer: "i", clientId: "c", resource: "r", scopes: [] },
    })
    expect(() => render(<CloudIdentityInitializer />)).not.toThrow()
    await waitFor(() => expect(resolveLogtoSession).toHaveBeenCalledTimes(1))
  })

  it("a keyring failure in the legacy cleanup does not stop the resolution", async () => {
    mockUnlocked = "acct_a"
    discardLegacyGlobalLogtoSession.mockRejectedValue(new Error("keyring locked"))
    render(<CloudIdentityInitializer />)
    await waitFor(() => expect(resolveLogtoSession).toHaveBeenCalledTimes(1))
  })

  it("never throws out of the effect when resolution fails", async () => {
    mockUnlocked = "acct_a"
    resolveLogtoSession.mockRejectedValue(new Error("issuer down"))
    expect(() => render(<CloudIdentityInitializer />)).not.toThrow()
    await waitFor(() => expect(resolveLogtoSession).toHaveBeenCalledTimes(1))
  })
})
