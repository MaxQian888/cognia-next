/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))

const pushMock = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}))

const useUserProfileMock = jest.fn()
jest.mock("@/lib/profile/use-user-profile", () => ({
  useUserProfile: () => useUserProfileMock(),
}))

const useCredentialMock = jest.fn()
const useUsageMock = jest.fn()
jest.mock("@/lib/subscription/anthropic/hooks", () => ({
  useActiveAnthropicCredential: () => useCredentialMock(),
  useAnthropicUsage: () => useUsageMock(),
}))

const useCompanionConfigMock = jest.fn()
jest.mock("@/hooks/companion/use-companion-config", () => ({
  useCompanionConfig: () => useCompanionConfigMock(),
}))

jest.mock("../profile/profile-section", () => ({
  ProfileSection: () => <div data-testid="stub-profile-section" />,
}))

import { AccountOverviewSection } from "./account-overview-section"

beforeEach(() => {
  pushMock.mockReset()
  useUserProfileMock.mockReturnValue({
    profile: {},
    resolvedDisplayName: null,
    resolvedAvatarUrl: null,
  })
  useCredentialMock.mockReturnValue({ credential: null, loading: false })
  useUsageMock.mockReturnValue({ latest: null })
  useCompanionConfigMock.mockReturnValue({ paired: false, shortDeviceId: null })
})

describe("AccountOverviewSection", () => {
  it("renders signed-out identity with initials and no usage", () => {
    render(<AccountOverviewSection />)
    expect(screen.getByTestId("account-overview-section")).toBeInTheDocument()
    expect(screen.getByTestId("stub-profile-section")).toBeInTheDocument()
    expect(screen.getByText("notSignedIn")).toBeInTheDocument()
    expect(screen.queryByTestId("account-overview-avatar-img")).not.toBeInTheDocument()
    expect(screen.queryByLabelText("usageFiveHour")).not.toBeInTheDocument()
  })

  it("renders signed-in identity with avatar, email, pronouns, status and usage", () => {
    useUserProfileMock.mockReturnValue({
      profile: { pronouns: "they/them", statusMessage: "shipping" },
      resolvedDisplayName: "Max",
      resolvedAvatarUrl: "data:image/webp;base64,AA",
    })
    useCredentialMock.mockReturnValue({
      credential: { email: "max@example.com", plan: "pro" },
      loading: false,
    })
    useUsageMock.mockReturnValue({
      latest: {
        fiveHour: { utilization: 0.5, resetAt: Date.now() + 3_600_000 },
        sevenDay: { utilization: 0.2, resetAt: Date.now() + 90_000_000 },
      },
    })
    render(<AccountOverviewSection />)
    expect(screen.getByTestId("account-overview-avatar-img")).toBeInTheDocument()
    expect(screen.getByTestId("account-overview-name")).toHaveTextContent("Max")
    expect(screen.getByTestId("account-overview-email")).toHaveTextContent("max@example.com")
    expect(screen.getByText("they/them")).toBeInTheDocument()
    expect(screen.getByTestId("account-overview-status")).toHaveTextContent("shipping")
    // Plan label appears in both the identity badge and the subscription card.
    expect(screen.getAllByText("PRO").length).toBeGreaterThanOrEqual(2)
    expect(screen.getByLabelText("usageFiveHour")).toBeInTheDocument()
    expect(screen.getByLabelText("usageSevenDay")).toBeInTheDocument()
  })

  it("renders a usage row without a reset hint and skips the missing window", () => {
    useUsageMock.mockReturnValue({
      latest: { fiveHour: { utilization: 0.9 }, sevenDay: null },
    })
    render(<AccountOverviewSection />)
    // fiveHour renders (no resetAt → no reset hint); sevenDay (null) is skipped.
    expect(screen.getByLabelText("usageFiveHour")).toBeInTheDocument()
    expect(screen.queryByLabelText("usageSevenDay")).not.toBeInTheDocument()
  })

  it("ignores a reset time already in the past", () => {
    useUsageMock.mockReturnValue({
      latest: { fiveHour: { utilization: 0.4, resetAt: Date.now() - 1000 }, sevenDay: null },
    })
    render(<AccountOverviewSection />)
    expect(screen.getByLabelText("usageFiveHour")).toBeInTheDocument()
  })

  it("jumps to the subscription section", async () => {
    const user = userEvent.setup()
    render(<AccountOverviewSection />)
    await user.click(screen.getByTestId("account-overview-manage-subscription"))
    expect(pushMock).toHaveBeenCalledWith("/settings?section=subscription")
  })

  it("shows a pair CTA when unpaired and routes to /pair", async () => {
    const user = userEvent.setup()
    render(<AccountOverviewSection />)
    expect(screen.getByText("deviceUnpaired")).toBeInTheDocument()
    await user.click(screen.getByTestId("account-overview-pair"))
    expect(pushMock).toHaveBeenCalledWith("/pair")
  })

  it("shows the device id and a manage button when paired", async () => {
    useCompanionConfigMock.mockReturnValue({ paired: true, shortDeviceId: "ABCDEFGH" })
    const user = userEvent.setup()
    render(<AccountOverviewSection />)
    expect(screen.getByText('devicePaired:{"id":"ABCDEFGH"}')).toBeInTheDocument()
    await user.click(screen.getByTestId("account-overview-manage-devices"))
    expect(pushMock).toHaveBeenCalledWith("/settings?section=companion")
  })
})
