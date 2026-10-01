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

let mockSearch = ""
const mockReplace = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace, push: jest.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(mockSearch),
}))

jest.mock("@/components/chat/targeted-invite-accept", () => ({
  TargetedInviteAccept: (props: { inviteId: string; orgId: string; onSettled: () => void }) => (
    <button
      type="button"
      data-testid="targeted-invite-accept"
      data-invite={props.inviteId}
      data-org={props.orgId}
      onClick={props.onSettled}
    />
  ),
}))

const mockSwitchToDm = jest.fn()
jest.mock("@/components/shell/use-shell-nav", () => ({
  useShellNav: () => ({ switchToDm: mockSwitchToDm }),
}))

const mockUseSessionLink = jest.fn()
jest.mock("@/hooks/chat/use-session-link", () => ({
  useSessionLink: (options: unknown) => mockUseSessionLink(options),
}))

import { fireEvent, render, screen } from "@testing-library/react"
import Home from "./page"

beforeEach(() => {
  mockSearch = ""
  mockReplace.mockClear()
  mockUseSessionLink.mockClear()
})

describe("Home", () => {
  it("renders the desktop chat workspace", async () => {
    render(<Home />)
    expect(await screen.findByTestId("desktop-chat-workspace")).toBeInTheDocument()
  })

  it("does not load the invite dialog without an invite link", async () => {
    render(<Home />)
    await screen.findByTestId("desktop-chat-workspace")
    expect(screen.queryByTestId("targeted-invite-accept")).not.toBeInTheDocument()
  })

  it("mounts the invite dialog for a chat.invited link on the conversation route", async () => {
    mockSearch = "acceptInvite=inv_1&org=org_1"
    render(<Home />)
    const dialog = await screen.findByTestId("targeted-invite-accept")
    expect(dialog).toHaveAttribute("data-invite", "inv_1")
    expect(dialog).toHaveAttribute("data-org", "org_1")
  })

  it("drops only the invite params once the link is spent", async () => {
    mockSearch = "acceptInvite=inv_1&org=org_1&session=s1"
    render(<Home />)
    fireEvent.click(await screen.findByTestId("targeted-invite-accept"))
    expect(mockReplace).toHaveBeenCalledWith("/?session=s1", { scroll: false })
  })

  it("ignores half a link", async () => {
    mockSearch = "acceptInvite=inv_1"
    render(<Home />)
    await screen.findByTestId("desktop-chat-workspace")
    expect(screen.queryByTestId("targeted-invite-accept")).not.toBeInTheDocument()
  })

  it("opens a session-only link and drops only the session param", async () => {
    mockSearch = "session=s1&tab=notes"
    render(<Home />)
    await screen.findByTestId("desktop-chat-workspace")
    const options = mockUseSessionLink.mock.calls.at(-1)![0] as {
      params: URLSearchParams
      onConsumed: () => void
      onOpened: () => void
    }
    expect(options.params.get("session")).toBe("s1")
    expect(options.onOpened).toBe(mockSwitchToDm)
    options.onConsumed()
    expect(mockReplace).toHaveBeenCalledWith("/?tab=notes", { scroll: false })
  })
})
