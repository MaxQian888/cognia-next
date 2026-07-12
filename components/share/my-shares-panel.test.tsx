import "fake-indexeddb/auto"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { MySharesPanel } from "./my-shares-panel"
import { recordSharedLink, markSharedLinkRevoked } from "@/lib/db/shared-links"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"

// revokeShareLink (client) hits the network + flips the Dexie row. Here we stub
// the network half and keep the real Dexie mark so useLiveQuery refreshes. The
// full client behaviour is covered in lib/share/client.test.ts.
const revokeShareLink = jest.fn((code: string) => markSharedLinkRevoked(code))
jest.mock("@/lib/share/client", () => ({
  revokeShareLink: (code: string) => revokeShareLink(code),
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
})
