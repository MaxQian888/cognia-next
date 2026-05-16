/** @jest-environment jsdom */

jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(() => true),
  transport: { call: jest.fn(async () => null) },
}))

jest.mock("../login-dialog", () => ({
  SubscriptionLoginDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="login-dialog" /> : null,
}))

jest.mock("@/lib/anthropic-subscription/hooks", () => ({
  useSubscriptionCredential: jest.fn(),
  useSubscriptionUsage: jest.fn(),
  useSubscriptionLogout: jest.fn(),
}))

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import * as hooksMod from "@/lib/anthropic-subscription/hooks"
import type { SubscriptionCredential } from "@/lib/anthropic-subscription/types"

import { SubscriptionAccountTab } from "./account-tab"

const mUseCredential = hooksMod.useSubscriptionCredential as jest.Mock

const credential: SubscriptionCredential = {
  accessToken: "oat-test",
  refreshToken: "rt-test",
  expiresAtMs: Date.now() + 60 * 60 * 1000,
  mode: "subscription",
  scope: "user:profile user:inference",
  email: "user@example.com",
  plan: "pro",
  storedAtMs: Date.now(),
}

function makeHookResult(
  overrides: Partial<ReturnType<typeof hooksMod.useSubscriptionCredential>> = {}
) {
  return {
    credential: null,
    isFresh: false,
    loading: false,
    reload: jest.fn(async () => undefined),
    refresh: jest.fn(async () => null),
    signOut: jest.fn(async () => undefined),
    ...overrides,
  } as ReturnType<typeof hooksMod.useSubscriptionCredential>
}

beforeEach(() => {
  mUseCredential.mockReset()
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe("SubscriptionAccountTab", () => {
  it("renders signed-out state when credential is null", () => {
    mUseCredential.mockReturnValue(makeHookResult({ credential: null }))
    render(<SubscriptionAccountTab />)
    // Signed-out empty state surfaces a CTA — exact text comes from real i18n.
    expect(screen.getByRole("button")).toBeInTheDocument()
  })

  it("renders email + scope when signed in", () => {
    mUseCredential.mockReturnValue(makeHookResult({ credential }))
    const { container } = render(<SubscriptionAccountTab />)
    expect(container.textContent).toContain("user@example.com")
    expect(container.textContent).toContain("user:profile user:inference")
  })

  it("triggers refresh on Refresh-now click", async () => {
    const user = userEvent.setup()
    const refresh = jest.fn(async () => credential)
    mUseCredential.mockReturnValue(makeHookResult({ credential, refresh }))
    render(<SubscriptionAccountTab />)
    // The card header has 2 buttons (Refresh, Sign out). Click the first one
    // since they're rendered in deterministic order.
    const refreshBtn = screen.getAllByRole("button")[0]
    await user.click(refreshBtn)
    await waitFor(() => expect(refresh).toHaveBeenCalled())
  })

  it("triggers signOut on the second header button", async () => {
    const user = userEvent.setup()
    const signOut = jest.fn(async () => undefined)
    mUseCredential.mockReturnValue(makeHookResult({ credential, signOut }))
    render(<SubscriptionAccountTab />)
    const signOutBtn = screen.getAllByRole("button")[1]
    await user.click(signOutBtn)
    await waitFor(() => expect(signOut).toHaveBeenCalled())
  })
})
