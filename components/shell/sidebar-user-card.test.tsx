/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${Object.values(values).join(",")}` : key,
}))

const routerPush = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: jest.fn(), back: jest.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}))

jest.mock("@cognia/logging", () => {
  const stub = {
    trace: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    fatal: jest.fn(),
    child: function () {
      return this
    },
    withContext: function () {
      return this
    },
  }
  return { loggers: new Proxy({}, { get: () => stub }), createLogger: () => stub }
})

const toastError = jest.fn()
jest.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => toastError(...a) } }))

const lock = jest.fn(async () => {})
let activeAccount: { id: string; displayName: string; avatarDataUrl?: string } | null = {
  id: "a-1",
  displayName: "Irma Salazar",
}
jest.mock("@/stores/account/account-store", () => ({
  selectActiveAccount: (s: unknown) => (s as { activeAccount: unknown }).activeAccount,
  useAccountStore: <T,>(selector: (s: Record<string, unknown>) => T): T =>
    selector({ activeAccount, lock }),
}))

let identity = {
  displayName: null as string | null,
  email: null as string | null,
  standing: "local" as "local" | "cloud" | "org",
  usagePercent: null as number | null,
}
const useSidebarIdentity = jest.fn((_active: boolean) => identity)
jest.mock("@/hooks/shell/use-sidebar-identity", () => ({
  useSidebarIdentity: (active: boolean) => useSidebarIdentity(active),
}))

const toggleDesktopPetWindow = jest.fn(async () => true)
jest.mock("@/lib/pet/commands", () => ({
  toggleDesktopPetWindow: () => toggleDesktopPetWindow(),
}))

jest.mock("@/components/account/account-manage-dialog", () => ({
  AccountManageDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="manage-dialog" /> : null,
}))
jest.mock("@/components/account/runtime-target-menu-section", () => ({
  RuntimeTargetMenuSection: () => <div data-testid="runtime-targets" />,
}))

import { SidebarUserCard } from "./sidebar-user-card"

function open() {
  render(<SidebarUserCard />)
  fireEvent.click(screen.getByTestId("sidebar-user-card"))
  return screen.findByTestId("sidebar-user-menu")
}

beforeEach(() => {
  routerPush.mockReset()
  toastError.mockReset()
  lock.mockClear()
  toggleDesktopPetWindow.mockClear()
  toggleDesktopPetWindow.mockResolvedValue(true)
  activeAccount = { id: "a-1", displayName: "Irma Salazar" }
  identity = { displayName: null, email: null, standing: "local", usagePercent: null }
})

describe("SidebarUserCard", () => {
  it("names the local profile, and says the profile is only on this device", () => {
    render(<SidebarUserCard />)
    const card = screen.getByTestId("sidebar-user-card")
    expect(card).toHaveTextContent("Irma Salazar")
    expect(screen.getByTestId("sidebar-user-standing")).toHaveTextContent("standingLocal")
    expect(screen.getByTestId("sidebar-user-avatar")).toHaveTextContent("I")
  })

  it("a bound profile is named by the cloud identity, not the local one", () => {
    identity = {
      displayName: "Ada Lovelace",
      email: "ada@x.dev",
      standing: "cloud",
      usagePercent: null,
    }
    render(<SidebarUserCard />)
    expect(screen.getByTestId("sidebar-user-card")).toHaveTextContent("Ada Lovelace")
    expect(screen.getByTestId("sidebar-user-standing")).toHaveTextContent("ada@x.dev")
  })

  it("an organization membership is its own standing", () => {
    identity = { displayName: "Ada", email: null, standing: "org", usagePercent: null }
    render(<SidebarUserCard />)
    expect(screen.getByTestId("sidebar-user-standing")).toHaveTextContent("standingOrg")
  })

  it("reads the identity only while the menu is open", async () => {
    useSidebarIdentity.mockClear()
    render(<SidebarUserCard />)
    expect(useSidebarIdentity).toHaveBeenLastCalledWith(false)
    fireEvent.click(screen.getByTestId("sidebar-user-card"))
    await screen.findByTestId("sidebar-user-menu")
    expect(useSidebarIdentity).toHaveBeenLastCalledWith(true)
  })

  it("shows what is left rather than what is spent, and lands on the usage section", async () => {
    identity = { displayName: null, email: null, standing: "local", usagePercent: 45 }
    await open()
    const usage = screen.getByTestId("sidebar-user-usage")
    expect(usage).toHaveTextContent("usageLeft:55")
    fireEvent.click(usage)
    expect(routerPush).toHaveBeenCalledWith("/settings?section=subscription")
  })

  it("drops the usage row entirely when nothing on the install is measured", async () => {
    await open()
    expect(screen.queryByTestId("sidebar-user-usage")).toBeNull()
  })

  it("offers the way into the cloud only while the profile is local", async () => {
    await open()
    expect(screen.getByTestId("sidebar-user-sign-in")).toBeInTheDocument()
  })

  it("drops the sign-in row once the profile is bound", async () => {
    identity = { displayName: "Ada", email: null, standing: "cloud", usagePercent: null }
    await open()
    expect(screen.queryByTestId("sidebar-user-sign-in")).toBeNull()
  })

  it("opens Settings from the menu, which is where the footer's gear went", async () => {
    await open()
    fireEvent.click(screen.getByTestId("sidebar-user-settings"))
    expect(routerPush).toHaveBeenCalledWith("/settings")
  })

  it("opens the profile manager in place rather than routing away", async () => {
    await open()
    fireEvent.click(screen.getByTestId("sidebar-user-manage"))
    expect(await screen.findByTestId("manage-dialog")).toBeInTheDocument()
    expect(routerPush).not.toHaveBeenCalled()
  })

  it("summons the desktop pet through the shared command", async () => {
    await open()
    fireEvent.click(screen.getByTestId("sidebar-user-pet"))
    await waitFor(() => expect(toggleDesktopPetWindow).toHaveBeenCalledTimes(1))
  })

  it("says so when the pet window refuses", async () => {
    toggleDesktopPetWindow.mockRejectedValue(new Error("no window"))
    await open()
    fireEvent.click(screen.getByTestId("sidebar-user-pet"))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("petFailed"))
  })

  it("locks the vault, which is what signing out means here", async () => {
    await open()
    fireEvent.click(screen.getByTestId("sidebar-user-lock"))
    await waitFor(() => expect(lock).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByTestId("sidebar-user-menu")).toBeNull())
  })

  it("surfaces a refused lock instead of closing over it", async () => {
    lock.mockRejectedValueOnce(new Error("vault busy"))
    await open()
    fireEvent.click(screen.getByTestId("sidebar-user-lock"))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("vault busy"))
  })

  it("falls back to a named empty state when there is no profile at all", () => {
    activeAccount = null
    render(<SidebarUserCard />)
    expect(screen.getByTestId("sidebar-user-card")).toHaveTextContent("noProfile")
  })
})
