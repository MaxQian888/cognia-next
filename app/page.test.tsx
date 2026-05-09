// app/page.tsx is a thin wrapper that picks between <DiscordShell /> and
// <AppShellMobile />. We mock both shells so this test stays focused on page
// composition without pulling in their transitive dependencies (Tauri APIs,
// ESM-only chat libraries, etc).

jest.mock("@/components/desktop/shell", () => ({
  DiscordShell: () => <div data-testid="discord-shell" />,
}))

jest.mock("@/components/app-shell-mobile", () => ({
  AppShellMobile: () => <div data-testid="app-shell-mobile" />,
}))

import { render, screen } from "@testing-library/react"
import Home from "./page"

describe("Home", () => {
  it("renders the desktop shell", () => {
    render(<Home />)
    expect(screen.getByTestId("discord-shell")).toBeInTheDocument()
  })
})
