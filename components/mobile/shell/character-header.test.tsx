/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import { CharacterHeader } from "./character-header"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => {
    const map: Record<string, string> = {
      presenceStreaming: "Streaming",
    }
    return map[key] ?? key
  },
}))

describe("<CharacterHeader />", () => {
  it("renders the fallback title when no subject is provided", () => {
    render(<CharacterHeader subject={null} fallbackTitle="cognia" />)
    expect(screen.getByTestId("mobile-active-title")).toHaveTextContent("cognia")
    expect(screen.queryByTestId("character-header")).not.toBeInTheDocument()
  })

  it("renders the subject name + emoji glyph when supplied", () => {
    render(
      <CharacterHeader
        fallbackTitle="cognia"
        subject={{ name: "Octopus Tutor", avatarColor: "#abc", avatarEmoji: "🐙" }}
      />
    )
    expect(screen.getByTestId("character-header")).toBeInTheDocument()
    expect(screen.getByTestId("mobile-active-title")).toHaveTextContent("Octopus Tutor")
    expect(screen.getByText("🐙")).toBeInTheDocument()
  })

  it("falls back to initials when no emoji is supplied", () => {
    render(<CharacterHeader fallbackTitle="cognia" subject={{ name: "Code Reviewer" }} />)
    // initials() uses first+last initials → "CR"
    expect(screen.getByText("CR")).toBeInTheDocument()
  })

  it("shows a streaming dot only when streaming=true", () => {
    const { rerender } = render(
      <CharacterHeader fallbackTitle="cognia" subject={{ name: "Foo" }} />
    )
    expect(screen.queryByTestId("character-header-streaming")).not.toBeInTheDocument()
    rerender(<CharacterHeader fallbackTitle="cognia" subject={{ name: "Foo" }} streaming />)
    expect(screen.getByTestId("character-header-streaming")).toHaveTextContent("Streaming")
  })
})
