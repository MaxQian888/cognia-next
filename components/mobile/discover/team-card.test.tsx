/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import { TeamCard } from "./team-card"
import type { Team } from "@cognia/agent-config-types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

const mkTeam = (p: Partial<Team> = {}): Team =>
  ({
    id: "t1",
    name: "Research Squad",
    members: [{ id: "m1" }, { id: "m2" }],
    createdAt: 0,
    updatedAt: 0,
    ...p,
  }) as unknown as Team

describe("TeamCard", () => {
  it("renders the team name and links to its workspace", () => {
    render(<TeamCard team={mkTeam()} />)
    expect(screen.getByText("Research Squad")).toBeInTheDocument()
    const link = screen.getByTestId("team-card-t1")
    expect(link).toHaveAttribute("href", "/agent-teams/workspace?teamId=t1")
  })

  it("shows the member count and description", () => {
    render(<TeamCard team={mkTeam({ description: "digs papers" })} />)
    // The i18n mock returns the raw key for memberCount.
    expect(screen.getByText("memberCount")).toBeInTheDocument()
    expect(screen.getByText(/digs papers/)).toBeInTheDocument()
  })

  it("renders the built-in badge only for built-in teams", () => {
    const { rerender } = render(<TeamCard team={mkTeam({ isBuiltIn: true })} />)
    expect(screen.getByText("builtInBadge")).toBeInTheDocument()
    rerender(<TeamCard team={mkTeam({ isBuiltIn: false })} />)
    expect(screen.queryByText("builtInBadge")).not.toBeInTheDocument()
  })

  it("encodes team ids with special characters in the href", () => {
    render(<TeamCard team={mkTeam({ id: "a/b c" })} />)
    expect(screen.getByTestId("team-card-a/b c")).toHaveAttribute(
      "href",
      "/agent-teams/workspace?teamId=a%2Fb%20c"
    )
  })
})
