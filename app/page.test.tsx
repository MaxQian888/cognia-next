// app/page.tsx is a thin wrapper that picks between <DesktopChatWorkspace /> and
// <AppShellMobile />. We mock both so this test stays focused on page composition
// without pulling in their transitive dependencies (Tauri APIs, ESM-only chat
// libraries, etc).

jest.mock("@/components/desktop/desktop-chat-workspace", () => ({
  DesktopChatWorkspace: () => <div data-testid="desktop-chat-workspace" />,
}))

jest.mock("@/components/app-shell-mobile", () => ({
  AppShellMobile: () => <div data-testid="app-shell-mobile" />,
}))

import { render, screen } from "@testing-library/react"
import Home from "./page"

describe("Home", () => {
  it("renders the desktop chat workspace", async () => {
    render(<Home />)
    expect(await screen.findByTestId("desktop-chat-workspace")).toBeInTheDocument()
  })
})
