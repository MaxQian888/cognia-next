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

jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: jest.fn(),
}))

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import * as hooksMod from "@/lib/anthropic-subscription/hooks"
import {
  DEFAULT_SUBSCRIPTION_SETTINGS,
  type SubscriptionCredential,
  type SubscriptionUsageRow,
} from "@/lib/anthropic-subscription/types"
import { useSettingsStore } from "@/stores/settings/settings-store"

import { SubscriptionOverviewTab } from "./overview-tab"

const mUseCredential = hooksMod.useSubscriptionCredential as jest.Mock
const mUseUsage = hooksMod.useSubscriptionUsage as jest.Mock
const mUseSettingsStore = useSettingsStore as unknown as jest.Mock

function makeCredentialHook(
  credential: SubscriptionCredential | null
): ReturnType<typeof hooksMod.useSubscriptionCredential> {
  return {
    credential,
    isFresh: !!credential,
    loading: false,
    reload: jest.fn(async () => undefined),
    refresh: jest.fn(async () => null),
    signOut: jest.fn(async () => undefined),
  }
}

function makeUsageHook(
  latest: SubscriptionUsageRow | null
): ReturnType<typeof hooksMod.useSubscriptionUsage> {
  return {
    rows: latest ? [latest] : [],
    latest,
    loading: false,
  }
}

const credential: SubscriptionCredential = {
  accessToken: "oat-test",
  refreshToken: "rt-test",
  expiresAtMs: Date.now() + 60 * 60 * 1000,
  mode: "subscription",
  scope: "user:profile",
  email: "user@example.com",
  plan: "pro",
  storedAtMs: Date.now(),
}

const sampleRow: SubscriptionUsageRow = {
  localId: 1,
  fetchedAt: Date.now() - 5000,
  source: "passive",
  status: "allowed",
  representativeClaim: "five_hour",
  fiveHour: { utilization: 0.42, resetAt: Date.now() + 60 * 60 * 1000, status: "allowed" },
  sevenDay: { utilization: 0.17, resetAt: Date.now() + 7 * 24 * 60 * 60 * 1000, status: "allowed" },
  fallbackPercentage: null,
  overageDisabledReason: null,
  rawHeaders: {},
}

beforeEach(() => {
  mUseCredential.mockReset()
  mUseUsage.mockReset()
  mUseSettingsStore.mockReset()
  mUseSettingsStore.mockImplementation(
    (
      selector: (s: {
        settings: { subscriptionSettings: typeof DEFAULT_SUBSCRIPTION_SETTINGS }
      }) => unknown
    ) => selector({ settings: { subscriptionSettings: DEFAULT_SUBSCRIPTION_SETTINGS } })
  )
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe("SubscriptionOverviewTab", () => {
  it("renders signed-out CTA + opens login dialog on click", async () => {
    const user = userEvent.setup()
    mUseCredential.mockReturnValue(makeCredentialHook(null))
    mUseUsage.mockReturnValue(makeUsageHook(null))

    render(<SubscriptionOverviewTab />)
    // CTA button always rendered in signed-out state.
    const signInBtn = screen.getByRole("button")
    await user.click(signInBtn)
    expect(screen.getByTestId("login-dialog")).toBeInTheDocument()
  })

  it("renders status + 5h + 7d cards when there is a usage sample", () => {
    mUseCredential.mockReturnValue(makeCredentialHook(credential))
    mUseUsage.mockReturnValue(makeUsageHook(sampleRow))

    const { container } = render(<SubscriptionOverviewTab />)
    // Both 5h (42%) and 7d (17%) percentages should appear in the DOM.
    expect(container.textContent).toContain("42%")
    expect(container.textContent).toContain("17%")
  })
})
