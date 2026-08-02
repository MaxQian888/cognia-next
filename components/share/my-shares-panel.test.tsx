import "fake-indexeddb/auto"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { MySharesPanel } from "./my-shares-panel"
import { recordSharedLink, markSharedLinkRevoked } from "@/lib/db/shared-links"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"

// revokeShareLink (client) hits the network + flips the Dexie row. Here we stub
// the network half and keep the real Dexie mark so useLiveQuery refreshes. The
// full client behaviour is covered in lib/share/client.test.ts.
const revokeShareLink = jest.fn((code: string) => markSharedLinkRevoked(code))
const getShareStats = jest.fn()
jest.mock("@/lib/share/client", () => ({
  revokeShareLink: (code: string) => revokeShareLink(code),
  getShareStats: (code: string) => getShareStats(code),
}))

const extendShareLink = jest.fn()
jest.mock("@/lib/share/renew", () => ({
  extendShareLink: (...a: unknown[]) => extendShareLink(...a),
}))

const toastError = jest.fn()
const toastSuccess = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}))

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await getDb().sharedLinks.clear()
  jest.clearAllMocks()
  Object.assign(navigator, { clipboard: { writeText: jest.fn().mockResolvedValue(undefined) } })
  // Cold Dexie open walks every schema version and can exceed 5s.
}, 30_000)

async function seed(overrides: Partial<Parameters<typeof recordSharedLink>[0]> = {}) {
  await recordSharedLink({
    code: "AbC",
    kind: "chat-html",
    title: "My chat",
    url: "https://share.test/v/AbC#k=K",
    createdAt: 1_700_000_000_000,
    burnAfterRead: false,
    hasPassphrase: false,
    ...overrides,
  })
}

describe("MySharesPanel", () => {
  it("renders the empty state when there are no links", async () => {
    render(<MySharesPanel />)
    expect(await screen.findByText("You haven’t created any share links yet.")).toBeInTheDocument()
  })

  it("lists links with badges", async () => {
    await seed({ burnAfterRead: true, hasPassphrase: true })
    render(<MySharesPanel />)
    expect(await screen.findByText("My chat")).toBeInTheDocument()
    expect(screen.getByText("Burn after read")).toBeInTheDocument()
    expect(screen.getByText("Passphrase")).toBeInTheDocument()
  })

  it("copies a link", async () => {
    await seed()
    render(<MySharesPanel />)
    await screen.findByText("My chat")
    fireEvent.click(screen.getByRole("button", { name: "Copy" }))
    await waitFor(() =>
      expect(navigator.clipboard.writeText as jest.Mock).toHaveBeenCalledWith(
        "https://share.test/v/AbC#k=K"
      )
    )
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Copy" }).querySelector('[data-state="copied"]')
      ).toBeInTheDocument()
    )
  })

  it("keeps copied feedback isolated to the successful row", async () => {
    await seed()
    await seed({ code: "DeF", title: "Other chat", url: "https://share.test/v/DeF#k=K" })
    render(<MySharesPanel />)
    await screen.findByText("Other chat")
    const copyButtons = screen.getAllByRole("button", { name: "Copy" })

    fireEvent.click(copyButtons[0])
    await waitFor(() =>
      expect(copyButtons[0].querySelector('[data-state="copied"]')).toBeInTheDocument()
    )
    expect(copyButtons[1].querySelector('[data-state="copied"]')).toBeNull()
  })

  it("does not show copied feedback when the clipboard write fails", async () => {
    ;(navigator.clipboard.writeText as jest.Mock).mockRejectedValueOnce(new Error("denied"))
    await seed()
    render(<MySharesPanel />)
    await screen.findByText("My chat")
    const copyButton = screen.getByRole("button", { name: "Copy" })

    fireEvent.click(copyButton)
    await waitFor(() => expect(navigator.clipboard.writeText as jest.Mock).toHaveBeenCalled())
    expect(copyButton.querySelector('[data-state="copied"]')).toBeNull()
  })

  it("fetches and shows the view count on demand", async () => {
    getShareStats.mockResolvedValue({ viewCount: 7, revoked: false })
    await seed()
    render(<MySharesPanel />)
    await screen.findByText("My chat")
    fireEvent.click(screen.getByRole("button", { name: "Check views" }))
    await waitFor(() => expect(getShareStats).toHaveBeenCalledWith("AbC"))
    expect(await screen.findByText("7 views")).toBeInTheDocument()
  })

  it("toasts an error when stats come back null", async () => {
    getShareStats.mockResolvedValue(null)
    await seed()
    render(<MySharesPanel />)
    await screen.findByText("My chat")
    fireEvent.click(screen.getByRole("button", { name: "Check views" }))
    await waitFor(() => expect(toastError).toHaveBeenCalled())
  })

  it("toasts an error when stats fetch throws", async () => {
    getShareStats.mockRejectedValue(new Error("network"))
    await seed()
    render(<MySharesPanel />)
    await screen.findByText("My chat")
    fireEvent.click(screen.getByRole("button", { name: "Check views" }))
    await waitFor(() => expect(toastError).toHaveBeenCalled())
  })

  it("shows the expiry timestamp for an expiring link", async () => {
    await seed({ expiresAt: 1_800_000_000_000 })
    render(<MySharesPanel />)
    const name = await screen.findByText("My chat")
    const meta = name.closest("li")?.querySelector("p")
    // The expiry branch renders a date, not the "Never" fallback.
    expect(meta?.textContent).not.toContain("Never")
  })

  it("labels a titleless link by its kind", async () => {
    await seed({ title: undefined, kind: "usage-card" })
    render(<MySharesPanel />)
    // Both the name slot and the badge show the kind label.
    expect(await screen.findAllByText("Usage card")).not.toHaveLength(0)
  })

  it("revokes a link and the list drops it", async () => {
    await seed()
    render(<MySharesPanel />)
    await screen.findByText("My chat")
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }))
    await waitFor(() => expect(revokeShareLink).toHaveBeenCalledWith("AbC"))
    await waitFor(() =>
      expect(screen.getByText("You haven’t created any share links yet.")).toBeInTheDocument()
    )
  })

  it("keeps the row when revoking fails", async () => {
    revokeShareLink.mockRejectedValueOnce(new Error("network"))
    await seed()
    render(<MySharesPanel />)
    await screen.findByText("My chat")
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }))
    await waitFor(() => expect(revokeShareLink).toHaveBeenCalledWith("AbC"))
    // Revoke failed → the row stays.
    expect(screen.getByText("My chat")).toBeInTheDocument()
  })

  it("extends a link's expiry by a week", async () => {
    extendShareLink.mockResolvedValueOnce(1_900_000_000_000)
    await seed()
    render(<MySharesPanel />)
    await screen.findByText("My chat")
    fireEvent.click(screen.getByRole("button", { name: "Extend expiry" }))
    await waitFor(() => expect(extendShareLink).toHaveBeenCalledWith("AbC", 7 * 24 * 60 * 60))
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled())
  })

  it("toasts an error when extending fails", async () => {
    extendShareLink.mockRejectedValueOnce(new Error("network"))
    await seed()
    render(<MySharesPanel />)
    await screen.findByText("My chat")
    fireEvent.click(screen.getByRole("button", { name: "Extend expiry" }))
    await waitFor(() => expect(toastError).toHaveBeenCalled())
  })

  it("toasts an error when extending rejects with a non-Error value", async () => {
    extendShareLink.mockRejectedValueOnce("boom")
    await seed()
    render(<MySharesPanel />)
    await screen.findByText("My chat")
    fireEvent.click(screen.getByRole("button", { name: "Extend expiry" }))
    await waitFor(() => expect(toastError).toHaveBeenCalled())
  })
})
