/** @jest-environment jsdom */

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: () => {
    const t = (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${JSON.stringify(values)}` : key
    t.has = () => true
    return t
  },
}))

const refreshCollabPlane = jest.fn()
jest.mock("@/lib/collab/refresh", () => ({
  refreshCollabPlane: (...args: unknown[]) => refreshCollabPlane(...args),
}))

jest.mock("@/lib/accounts/active-account-id", () => ({
  getActiveAccountId: () => "acct_a",
}))

import { loadCollabConnection, saveCollabConnection } from "@/lib/collab/connection"
import {
  isSharedChatClientEnabled,
  readSharedChatPreference,
  writeSharedChatPreference,
} from "@/lib/collab/shared-chat-feature"
import { CollaborationCard } from "./collaboration-card"

describe("CollaborationCard", () => {
  beforeEach(() => {
    localStorage.clear()
    refreshCollabPlane.mockReset()
  })

  it("saves a normalized url so the plane has an address at all", async () => {
    // Nothing in the collaboration plane runs until this exists — the client,
    // the mirror, the board source and the membership pull all wait on it.
    const user = userEvent.setup({ delay: null })
    render(<CollaborationCard />)

    await user.type(screen.getByTestId("collaboration-url"), "https://collab.example.com/")
    await user.click(screen.getByTestId("collaboration-save"))

    expect(loadCollabConnection("acct_a")?.baseUrl).toBe("https://collab.example.com")
  })

  it("loads what was already stored", async () => {
    saveCollabConnection("acct_a", { baseUrl: "https://stored.example" })
    render(<CollaborationCard />)
    await waitFor(() => {
      expect(screen.getByTestId("collaboration-url")).toHaveValue("https://stored.example")
    })
  })

  it("disconnects when the field is emptied", async () => {
    saveCollabConnection("acct_a", { baseUrl: "https://stored.example" })
    const user = userEvent.setup({ delay: null })
    render(<CollaborationCard />)
    await waitFor(() => {
      expect(screen.getByTestId("collaboration-url")).toHaveValue("https://stored.example")
    })

    await user.clear(screen.getByTestId("collaboration-url"))
    await user.click(screen.getByTestId("collaboration-save"))

    expect(loadCollabConnection("acct_a")).toBeNull()
  })

  it("reports a successful refresh with what it actually pulled", async () => {
    saveCollabConnection("acct_a", { baseUrl: "https://stored.example" })
    refreshCollabPlane.mockResolvedValue({
      status: "refreshed",
      orgId: "org_a",
      userId: "usr_a",
      issues: 3,
      workspaces: 2,
      orgMember: true,
    })
    const user = userEvent.setup({ delay: null })
    render(<CollaborationCard />)
    await waitFor(() => expect(screen.getByTestId("collaboration-test")).toBeEnabled())

    await user.click(screen.getByTestId("collaboration-test"))

    const ok = await screen.findByTestId("collaboration-ok")
    expect(ok.textContent).toContain('"issues":3')
  })

  it("states a skip as a fact rather than a failure", async () => {
    // No server, nobody signed in, or a personal account with no org are all
    // ordinary states; calling them errors sends people hunting a problem that
    // is not there.
    saveCollabConnection("acct_a", { baseUrl: "https://stored.example" })
    refreshCollabPlane.mockResolvedValue({ status: "skipped", reason: "not-signed-in" })
    const user = userEvent.setup({ delay: null })
    render(<CollaborationCard />)
    await waitFor(() => expect(screen.getByTestId("collaboration-test")).toBeEnabled())

    await user.click(screen.getByTestId("collaboration-test"))

    expect((await screen.findByTestId("collaboration-skipped")).textContent).toContain(
      "skipped.not-signed-in"
    )
    expect(screen.queryByTestId("collaboration-error")).not.toBeInTheDocument()
  })

  it("surfaces a real failure instead of swallowing it", async () => {
    saveCollabConnection("acct_a", { baseUrl: "https://stored.example" })
    refreshCollabPlane.mockRejectedValue(new Error("network down"))
    const user = userEvent.setup({ delay: null })
    render(<CollaborationCard />)
    await waitFor(() => expect(screen.getByTestId("collaboration-test")).toBeEnabled())

    await user.click(screen.getByTestId("collaboration-test"))

    expect((await screen.findByTestId("collaboration-error")).textContent).toContain("network down")
  })

  it("cannot refresh before an address is saved", () => {
    render(<CollaborationCard />)
    expect(screen.getByTestId("collaboration-test")).toBeDisabled()
  })
})

describe("CollaborationCard shared-chat switch", () => {
  const buildFlag = process.env.NEXT_PUBLIC_SHARED_CHAT_ENABLED

  beforeEach(() => {
    localStorage.clear()
    refreshCollabPlane.mockReset()
  })

  afterEach(() => {
    if (buildFlag === undefined) delete process.env.NEXT_PUBLIC_SHARED_CHAT_ENABLED
    else process.env.NEXT_PUBLIC_SHARED_CHAT_ENABLED = buildFlag
  })

  it("starts on for a machine that has never chosen", async () => {
    render(<CollaborationCard />)
    await waitFor(() => expect(screen.getByTestId("collaboration-shared-chat")).toBeChecked())
    expect(isSharedChatClientEnabled()).toBe(true)
  })

  it("turns the plane off for this machine, and back on", async () => {
    // The gate the panel, the sync pulls and the run coordinator all consult
    // has to move with the switch. A control that only changes its own
    // appearance is the failure this batch exists to remove.
    const user = userEvent.setup({ delay: null })
    render(<CollaborationCard />)
    await waitFor(() => expect(screen.getByTestId("collaboration-shared-chat")).toBeEnabled())

    await user.click(screen.getByTestId("collaboration-shared-chat"))
    expect(readSharedChatPreference()).toBe(false)
    expect(isSharedChatClientEnabled()).toBe(false)

    await user.click(screen.getByTestId("collaboration-shared-chat"))
    expect(readSharedChatPreference()).toBe(true)
    expect(isSharedChatClientEnabled()).toBe(true)
  })

  it("shows the switch disabled, with the reason, when the build says no", async () => {
    process.env.NEXT_PUBLIC_SHARED_CHAT_ENABLED = "false"
    render(<CollaborationCard />)

    const toggle = await screen.findByTestId("collaboration-shared-chat")
    await waitFor(() => expect(toggle).toBeDisabled())
    expect(toggle).not.toBeChecked()
    // Rendered rather than hidden: "you switched it off" and "this build never
    // carried it" need different actions from whoever is reading.
    expect(screen.getByText("switchBuildDisabled")).toBeInTheDocument()
  })

  it("never lets a local yes overrule a build that says no", async () => {
    writeSharedChatPreference(true)
    process.env.NEXT_PUBLIC_SHARED_CHAT_ENABLED = "false"
    render(<CollaborationCard />)
    await waitFor(() => expect(screen.getByTestId("collaboration-shared-chat")).not.toBeChecked())
    expect(isSharedChatClientEnabled()).toBe(false)
  })
})
