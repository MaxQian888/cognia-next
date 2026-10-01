/** @jest-environment jsdom */

const mockResolve = jest.fn()
const mockAcceptTargeted = jest.fn()
const mockOpen = jest.fn()
const mockError = jest.fn()
const mockSuccess = jest.fn()
const mockSwitchToDm = jest.fn()
let mockEnabled = true

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => mockError(...args),
    success: (...args: unknown[]) => mockSuccess(...args),
  },
}))
jest.mock("@/components/shell/use-shell-nav", () => ({
  useShellNav: () => ({ switchToDm: mockSwitchToDm }),
}))
jest.mock("@/lib/collab/runtime-client", () => ({
  resolveCurrentCollabContext: () => mockResolve(),
}))
jest.mock("@/lib/collab/open-shared-session", () => ({
  openAcceptedSharedSession: (...args: unknown[]) => mockOpen(...args),
}))
jest.mock("@/lib/collab/shared-chat-feature", () => ({
  isSharedChatBuildEnabled: () => mockEnabled,
  isSharedChatClientEnabled: () => mockEnabled,
  subscribeSharedChatPreference: () => () => {},
}))

import userEvent from "@testing-library/user-event"
import { render, screen, waitFor } from "@testing-library/react"
import { TargetedInviteAccept } from "./targeted-invite-accept"

const client = { acceptTargetedSessionInvite: mockAcceptTargeted }

function renderDialog(onSettled = jest.fn()) {
  render(<TargetedInviteAccept inviteId="inv_1" orgId="org_1" onSettled={onSettled} />)
  return onSettled
}

beforeEach(() => {
  jest.clearAllMocks()
  mockEnabled = true
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true })
  mockResolve.mockResolvedValue({ orgId: "org_1", userId: "usr_me", client })
  mockAcceptTargeted.mockResolvedValue({ invite: { sessionId: "ses_shared" }, membership: {} })
  mockOpen.mockResolvedValue({ localSessionId: "local", session: { workspaceId: "ws" } })
})

describe("TargetedInviteAccept", () => {
  it("asks before accepting anything", () => {
    renderDialog()
    expect(screen.getByRole("dialog")).toBeInTheDocument()
    expect(screen.getByText("targetedInvite.title")).toBeInTheDocument()
    expect(screen.getByText("targetedInvite.description")).toBeInTheDocument()
    expect(mockResolve).not.toHaveBeenCalled()
    expect(mockAcceptTargeted).not.toHaveBeenCalled()
  })

  it("accepts by id, opens the conversation like a token accept, then spends the link", async () => {
    const user = userEvent.setup()
    const onSettled = renderDialog()

    await user.click(screen.getByRole("button", { name: "targetedInvite.accept" }))

    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1))
    expect(mockAcceptTargeted).toHaveBeenCalledWith("org_1", "inv_1")
    expect(mockOpen).toHaveBeenCalledWith({
      client,
      orgId: "org_1",
      sharedSessionId: "ses_shared",
      switchToDm: mockSwitchToDm,
    })
    expect(mockSuccess).toHaveBeenCalledWith("inviteAccepted")
    expect(mockError).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
  })

  it("'Not now' spends the link without touching the server", async () => {
    const user = userEvent.setup()
    const onSettled = renderDialog()

    await user.click(screen.getByRole("button", { name: "targetedInvite.dismiss" }))

    expect(onSettled).toHaveBeenCalledTimes(1)
    expect(mockResolve).not.toHaveBeenCalled()
    expect(mockAcceptTargeted).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
  })

  it("Escape counts as 'Not now'", async () => {
    const user = userEvent.setup()
    const onSettled = renderDialog()
    await user.keyboard("{Escape}")
    expect(onSettled).toHaveBeenCalledTimes(1)
    expect(mockAcceptTargeted).not.toHaveBeenCalled()
  })

  it("refuses an invite from another org without sending it", async () => {
    mockResolve.mockResolvedValue({ orgId: "org_other", userId: "usr_me", client })
    const user = userEvent.setup()
    const onSettled = renderDialog()

    await user.click(screen.getByRole("button", { name: "targetedInvite.accept" }))

    await waitFor(() =>
      expect(mockError).toHaveBeenCalledWith("inviteAcceptFailed", {
        description: "targetedInvite.wrongOrg",
      })
    )
    expect(mockAcceptTargeted).not.toHaveBeenCalled()
    expect(mockOpen).not.toHaveBeenCalled()
    expect(onSettled).toHaveBeenCalledTimes(1)
  })

  it("reports a refused accept and opens nothing", async () => {
    mockAcceptTargeted.mockRejectedValue(new Error("invite already used"))
    const user = userEvent.setup()
    const onSettled = renderDialog()

    await user.click(screen.getByRole("button", { name: "targetedInvite.accept" }))

    await waitFor(() => expect(mockError).toHaveBeenCalledWith("inviteAcceptFailed"))
    expect(mockOpen).not.toHaveBeenCalled()
    expect(mockSuccess).not.toHaveBeenCalled()
    expect(onSettled).toHaveBeenCalledTimes(1)
  })

  it("reports a failed pull after the accept as a failure too", async () => {
    mockOpen.mockRejectedValue(new Error("sync failed"))
    const user = userEvent.setup()
    renderDialog()

    await user.click(screen.getByRole("button", { name: "targetedInvite.accept" }))

    await waitFor(() => expect(mockError).toHaveBeenCalledWith("inviteAcceptFailed"))
    expect(mockSuccess).not.toHaveBeenCalled()
  })

  it("explains a missing collaboration setup", async () => {
    mockResolve.mockResolvedValue(null)
    const user = userEvent.setup()
    const onSettled = renderDialog()

    await user.click(screen.getByRole("button", { name: "targetedInvite.accept" }))

    await waitFor(() => expect(mockError).toHaveBeenCalledWith("notConfigured"))
    expect(mockAcceptTargeted).not.toHaveBeenCalled()
    expect(onSettled).toHaveBeenCalledTimes(1)
  })

  it("stays open offline so the person can retry after reconnecting", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false })
    const user = userEvent.setup()
    const onSettled = renderDialog()

    await user.click(screen.getByRole("button", { name: "targetedInvite.accept" }))

    expect(mockError).toHaveBeenCalledWith("targetedInvite.offline")
    expect(mockResolve).not.toHaveBeenCalled()
    expect(onSettled).not.toHaveBeenCalled()
    expect(screen.getByRole("dialog")).toBeInTheDocument()
  })

  it("says so when shared chat is turned off, without contacting the server", async () => {
    mockEnabled = false
    const user = userEvent.setup()
    const onSettled = renderDialog()

    await user.click(screen.getByRole("button", { name: "targetedInvite.accept" }))

    expect(mockError).toHaveBeenCalledWith("featureDisabled")
    expect(mockResolve).not.toHaveBeenCalled()
    expect(onSettled).toHaveBeenCalledTimes(1)
  })

  it("locks both buttons while the accept is on the wire", async () => {
    let finish: (value: unknown) => void = () => {}
    mockAcceptTargeted.mockReturnValue(new Promise((resolve) => (finish = resolve)))
    const user = userEvent.setup()
    const onSettled = renderDialog()

    await user.click(screen.getByRole("button", { name: "targetedInvite.accept" }))

    const busy = await screen.findByRole("button", { name: "targetedInvite.accepting" })
    expect(busy).toBeDisabled()
    expect(screen.getByRole("button", { name: "targetedInvite.dismiss" })).toBeDisabled()
    await user.keyboard("{Escape}")
    expect(onSettled).not.toHaveBeenCalled()

    finish({ invite: { sessionId: "ses_shared" }, membership: {} })
    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1))
  })
})
