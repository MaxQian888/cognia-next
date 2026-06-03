/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

import { CharacterCard } from "./character-card"
import type { Character } from "@/lib/claude/types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}))

// Radix Avatar's AvatarImage defers rendering until an internal load event
// fires, which never happens in jsdom. Mock the leaf so the conditional
// `AvatarImage` wiring is observable.
jest.mock("@/components/ui/avatar", () => ({
  Avatar: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AvatarImage: ({ src }: { src: string }) => <span data-testid="avatar-image" data-src={src} />,
  AvatarFallback: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}))

const mkChar = (p: Partial<Character> = {}): Character => ({
  id: "c1",
  name: "Octopus Tutor",
  avatarColor: "#abc",
  systemPrompt: "...",
  createdAt: 0,
  updatedAt: 0,
  ...p,
})

describe("CharacterCard", () => {
  it("renders the emoji avatar and name", () => {
    render(<CharacterCard character={mkChar({ avatarEmoji: "🐙" })} />)
    expect(screen.getByText("Octopus Tutor")).toBeInTheDocument()
    expect(screen.getByText("🐙")).toBeInTheDocument()
  })

  it("falls back to initials when no emoji", () => {
    render(<CharacterCard character={mkChar({ name: "Alice Bob" })} />)
    expect(screen.getByText("AL")).toBeInTheDocument()
  })

  it("renders the avatar image when avatarImage.webDataUrl is set (ADR-0030 v2)", () => {
    render(<CharacterCard character={mkChar({ avatarImage: { webDataUrl: "data:image/png;base64,AAA" } })} />)
    expect(screen.getByTestId("avatar-image").getAttribute("data-src")).toBe(
      "data:image/png;base64,AAA"
    )
  })

  it("shows the built-in and plugin badges", () => {
    render(<CharacterCard character={mkChar({ isBuiltIn: true, sourcePluginId: "plug-a" })} />)
    expect(screen.getByText("builtInBadge")).toBeInTheDocument()
    expect(screen.getByText("pluginBadge")).toBeInTheDocument()
  })

  it("renders as a link when href is provided", () => {
    render(<CharacterCard character={mkChar()} href="/chat/c1" />)
    expect(screen.getByRole("link")).toHaveAttribute("href", "/chat/c1")
  })

  it("fires onSelect when tapped (no href)", () => {
    const onSelect = jest.fn()
    const c = mkChar()
    render(<CharacterCard character={c} onSelect={onSelect} />)
    fireEvent.click(screen.getByRole("button"))
    expect(onSelect).toHaveBeenCalledWith(c)
  })
})
