/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"

import { ProfileHeader } from "./profile-header"

jest.mock("next/link", () => {
  const Link = ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  )
  return { __esModule: true, default: Link }
})

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => {
    const map: Record<string, string> = {
      fallbackName: "Local user",
      fallbackPlan: "Free",
      manageAccount: "Manage account",
    }
    return map[key] ?? key
  },
}))

describe("<ProfileHeader />", () => {
  it("falls back to defaults when no credential is loaded", async () => {
    render(<ProfileHeader credentialLoader={async () => null} />)
    await waitFor(() => {
      expect(screen.getByTestId("profile-header-name")).toHaveTextContent("Local user")
      expect(screen.getByTestId("profile-header-plan")).toHaveTextContent("Free")
    })
    expect(screen.queryByTestId("profile-header-email")).not.toBeInTheDocument()
  })

  it("renders the email-prefix as display name and uppercases the plan", async () => {
    render(
      <ProfileHeader
        credentialLoader={async () => ({
          accessToken: "x",
          refreshToken: "y",
          expiresAtMs: Date.now() + 60_000,
          mode: "subscription",
          email: "salazar@example.com",
          plan: "pro",
          storedAtMs: Date.now(),
        })}
      />
    )
    await waitFor(() => {
      expect(screen.getByTestId("profile-header-name")).toHaveTextContent("salazar")
    })
    expect(screen.getByTestId("profile-header-plan")).toHaveTextContent("PRO")
    expect(screen.getByTestId("profile-header-email")).toHaveTextContent("salazar@example.com")
  })

  it("links to the subscription settings", () => {
    render(<ProfileHeader credentialLoader={async () => null} />)
    expect(screen.getByTestId("profile-header")).toHaveAttribute(
      "href",
      "/settings?section=subscription"
    )
  })
})
