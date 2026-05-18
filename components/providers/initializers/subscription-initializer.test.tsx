/**
 * @jest-environment jsdom
 */

import { render, waitFor } from "@testing-library/react"

import { SubscriptionInitializer } from "./subscription-initializer"

const mInitOnce = jest.fn().mockResolvedValue({
  outcomes: [],
  migratedCount: 0,
  toastShown: false,
})

jest.mock("@/lib/subscription/core/migration", () => ({
  subscriptionInitOnce: (...args: unknown[]) => mInitOnce(...args),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))

beforeEach(() => {
  mInitOnce.mockClear()
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
})
