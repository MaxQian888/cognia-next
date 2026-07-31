/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import type { AnthropicCredentialData, SubscriptionUsageRow } from "@/types/subscription"

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const credentialRef: { current: AnthropicCredentialData | null } = { current: null }
const usageRef: { current: SubscriptionUsageRow | null } = { current: null }

jest.mock("@/lib/subscription/anthropic/hooks", () => ({
  useActiveAnthropicCredential: () => ({
    activeAccountId: credentialRef.current ? "acc-1" : null,
    credential: credentialRef.current,
    loading: false,
    reload: jest.fn(async () => undefined),
    refresh: jest.fn(async () => null),
    signOut: jest.fn(async () => undefined),
  }),
  useAnthropicUsage: () => ({
    rows: usageRef.current ? [usageRef.current] : [],
    latest: usageRef.current,
    loading: false,
  }),
}))

// Mirror the real hook's precedence (custom profile > credential email
// prefix) against the same mocked credential ref, plus a profile ref the
// tests can flip. The full precedence matrix is covered by the hook's own
// suite (`lib/profile/use-user-profile.test.ts`).
const profileRef: { current: { displayName?: string; avatarDataUrl?: string } } = { current: {} }

jest.mock("@/lib/profile/use-user-profile", () => ({
  useUserProfile: () => {
    const custom = profileRef.current.displayName?.trim()
    const email = credentialRef.current?.email
    const derived = email && email.includes("@") ? email.split("@")[0] : null
    return {
      profile: profileRef.current,
      loaded: true,
      resolvedDisplayName: custom || derived || null,
      resolvedAvatarUrl: profileRef.current.avatarDataUrl || null,
      email: email ?? "",
      credentialLoading: false,
      save: jest.fn(async () => undefined),
    }
  },
}))

import { AccountCard } from "./account-card"

beforeEach(() => {
  credentialRef.current = null
  usageRef.current = null
  profileRef.current = {}
})

const PRO_CRED: AnthropicCredentialData = {
  accessToken: "tok",
  refreshToken: "rtok",
  expiresAtMs: Date.now() + 3_600_000,
  mode: "subscription",
  scope: "x",
  email: "ada@example.com",
  plan: "pro",
  storedAtMs: Date.now(),
}

describe("<AccountCard />", () => {
  it("renders 'not signed in' fallback when credential is null", () => {
    render(<AccountCard />)
    // next-intl is globally mocked to resolve real i18n strings — the
    // fallback names come from i18n/messages/en.json.
    expect(screen.getByTestId("account-card-name")).toHaveTextContent("Signed-out")
    expect(screen.getByTestId("account-card-plan")).toHaveTextContent("Local account")
    expect(screen.queryByTestId("account-card-email")).toBeNull()
  })

  it("renders the name from the email prefix + uppercased plan", () => {
    credentialRef.current = PRO_CRED
    render(<AccountCard />)
    expect(screen.getByTestId("account-card-name")).toHaveTextContent("ada")
    expect(screen.getByTestId("account-card-plan")).toHaveTextContent("PRO")
    expect(screen.getByTestId("account-card-email")).toHaveTextContent("ada@example.com")
  })

  it("prefers the custom profile name over the credential email prefix", () => {
    credentialRef.current = PRO_CRED
    profileRef.current = { displayName: "Custom Max" }
    render(<AccountCard />)
    expect(screen.getByTestId("account-card-name")).toHaveTextContent("Custom Max")
    // Plan + email stay credential-driven.
    expect(screen.getByTestId("account-card-plan")).toHaveTextContent("PRO")
    expect(screen.getByTestId("account-card-email")).toHaveTextContent("ada@example.com")
  })

  it("renders the custom avatar image when set, initials otherwise", () => {
    credentialRef.current = PRO_CRED
    profileRef.current = { avatarDataUrl: "data:image/webp;base64,AA" }
    const { rerender } = render(<AccountCard />)
    expect(screen.getByTestId("account-card-avatar-img")).toHaveAttribute(
      "src",
      "data:image/webp;base64,AA"
    )

    profileRef.current = {}
    rerender(<AccountCard />)
    expect(screen.queryByTestId("account-card-avatar-img")).toBeNull()
  })

  it("links to /me/subscription", () => {
    render(<AccountCard />)
    expect(screen.getByRole("link")).toHaveAttribute("href", "/me/subscription")
  })

  it("renders usage progress bars when latest snapshot is present", () => {
    credentialRef.current = PRO_CRED
    usageRef.current = {
      fetchedAt: Date.now(),
      source: "passive",
      status: "allowed",
      representativeClaim: "five_hour",
      fiveHour: { utilization: 0.64, resetAt: Date.now() + 2 * 3_600_000, status: "allowed" },
      sevenDay: { utilization: 0.22, resetAt: Date.now() + 4 * 24 * 3_600_000, status: "allowed" },
      fallbackPercentage: null,
      overageDisabledReason: null,
      rawHeaders: {},
    }
    render(<AccountCard />)
    const progressBars = screen.getAllByRole("progressbar")
    expect(progressBars).toHaveLength(2)
    expect(progressBars[0]).toHaveAttribute("aria-label", "5-hour quota")
    expect(progressBars[1]).toHaveAttribute("aria-label", "7-day quota")
  })

  it("omits the usage section when no snapshot is available", () => {
    credentialRef.current = PRO_CRED
    usageRef.current = null
    render(<AccountCard />)
    expect(screen.queryAllByRole("progressbar")).toHaveLength(0)
  })
})
