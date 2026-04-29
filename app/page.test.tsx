// app/page.tsx is a thin wrapper that renders <DiscordShell />. We mock the
// shell so this test stays focused on page composition without pulling in the
// shell's transitive dependencies (Tauri APIs, ESM-only token counters, etc).

jest.mock("@/components/desktop/shell", () => ({
  DiscordShell: () => <div data-testid="discord-shell" />,
}))

import { render, screen } from "@testing-library/react"
import Home from "./page"

describe("Home", () => {
  it("renders the desktop shell", () => {
    render(<Home />)
    expect(screen.getByTestId("discord-shell")).toBeInTheDocument()
  })
})
