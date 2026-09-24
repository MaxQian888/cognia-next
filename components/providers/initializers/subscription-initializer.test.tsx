/**
 * @jest-environment jsdom
 */

import { render, waitFor } from "@testing-library/react"

import { SubscriptionInitializer } from "./subscription-initializer"
import {
  __resetSecretStoreReadinessForTesting,
  setSecretStoreReadiness,
} from "@/lib/credentials/secret-store-readiness"

let accountState = {
  unlockedAccountId: "local_acct_a" as string | null,
  accountRevision: 1,
}

const mInitOnce = jest.fn().mockResolvedValue({
  outcomes: [],
  migratedCount: 0,
  toastShown: false,
})

jest.mock("@/lib/subscription/core/migration", () => ({
  subscriptionInitOnce: (...args: unknown[]) => mInitOnce(...args),
}))

const mNotifyChanged = jest.fn()
jest.mock("@/lib/subscription/core/subscription-events", () => ({
  notifySubscriptionChanged: () => mNotifyChanged(),
}))

jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: (selector: (state: typeof accountState) => unknown) => selector(accountState),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))

beforeEach(() => {
  __resetSecretStoreReadinessForTesting()
  mInitOnce.mockClear()
  mNotifyChanged.mockClear()
  accountState = {
    unlockedAccountId: "local_acct_a",
    accountRevision: 1,
  }
})

describe("SubscriptionInitializer", () => {
  it("renders nothing visible", () => {
    const { container } = render(<SubscriptionInitializer />)
    expect(container.firstChild).toBeNull()
  })

  it("fires subscriptionInitOnce on mount", async () => {
    render(<SubscriptionInitializer />)
    await waitFor(() => expect(mInitOnce).toHaveBeenCalledTimes(1))
  })

  it("forwards a translator that resolves toast keys via next-intl", async () => {
    render(<SubscriptionInitializer />)
    await waitFor(() => expect(mInitOnce).toHaveBeenCalledTimes(1))
    const opts = mInitOnce.mock.calls[0][0] as {
      translateToast?: (k: string, p?: Record<string, unknown>) => string
    }
    expect(opts.translateToast).toBeDefined()
    expect(opts.translateToast!("toastTitle")).toBe("toastTitle")
    expect(opts.translateToast!("toastBody", { count: 2 })).toBe('toastBody:{"count":2}')
  })

  it("does not re-fire when the component re-renders", async () => {
    const { rerender } = render(<SubscriptionInitializer />)
    rerender(<SubscriptionInitializer />)
    rerender(<SubscriptionInitializer />)
    await waitFor(() => expect(mInitOnce).toHaveBeenCalledTimes(1))
  })

  it("re-runs when the unlocked local account changes", async () => {
    const { rerender } = render(<SubscriptionInitializer />)
    await waitFor(() => expect(mInitOnce).toHaveBeenCalledTimes(1))

    accountState = {
      unlockedAccountId: "local_acct_b",
      accountRevision: 2,
    }
    rerender(<SubscriptionInitializer />)

    await waitFor(() => expect(mInitOnce).toHaveBeenCalledTimes(2))
  })

  it("re-runs when the account revision bumps for the same unlocked account", async () => {
    // Switching away and back (or re-activating) keeps the same
    // unlockedAccountId but bumps accountRevision — the init key must change so
    // the per-account credential projection is rebuilt rather than left stale.
    const { rerender } = render(<SubscriptionInitializer />)
    await waitFor(() => expect(mInitOnce).toHaveBeenCalledTimes(1))

    accountState = { unlockedAccountId: "local_acct_a", accountRevision: 2 }
    rerender(<SubscriptionInitializer />)

    await waitFor(() => expect(mInitOnce).toHaveBeenCalledTimes(2))
  })

  it("notifies subscription listeners after rebuilding the projection", async () => {
    render(<SubscriptionInitializer />)
    await waitFor(() => expect(mNotifyChanged).toHaveBeenCalledTimes(1))
  })

  it("does not initialize subscription keyrings while no local account is unlocked", async () => {
    accountState = {
      unlockedAccountId: null,
      accountRevision: 2,
    }

    render(<SubscriptionInitializer />)

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(mInitOnce).not.toHaveBeenCalled()
  })

  it("re-runs the whole init after the secret store unlocks", async () => {
    mInitOnce.mockResolvedValueOnce({
      outcomes: [],
      migratedCount: 0,
      toastShown: false,
      error: "SECRET_STORE_LOCKED: denied",
      secretStoreUnavailable: true,
    })
    setSecretStoreReadiness("locked")
    render(<SubscriptionInitializer />)
    await waitFor(() => expect(mInitOnce).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(mInitOnce).toHaveBeenCalledTimes(1)

    setSecretStoreReadiness("ready")

    await waitFor(() => expect(mInitOnce).toHaveBeenCalledTimes(2))
    // Each run tells subscribers (limits, chat header) to reload.
    await waitFor(() => expect(mNotifyChanged).toHaveBeenCalledTimes(2))
  })

  it("does not replay a deferred init for an account that is no longer active", async () => {
    mInitOnce.mockResolvedValueOnce({
      outcomes: [],
      migratedCount: 0,
      toastShown: false,
      secretStoreUnavailable: true,
    })
    setSecretStoreReadiness("locked")
    const { rerender } = render(<SubscriptionInitializer />)
    await waitFor(() => expect(mInitOnce).toHaveBeenCalledTimes(1))
    accountState = { unlockedAccountId: "local_acct_b", accountRevision: 1 }
    rerender(<SubscriptionInitializer />)
    await waitFor(() => expect(mInitOnce).toHaveBeenCalledTimes(2))

    setSecretStoreReadiness("ready")
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(mInitOnce).toHaveBeenCalledTimes(2)
  })
})
