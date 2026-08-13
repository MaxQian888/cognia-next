/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"
import { render, screen, waitFor, fireEvent } from "@testing-library/react"
import { toast } from "sonner"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { upsertIdentity, mergeIdentities, getByPlatformUser } from "@/lib/db/platform-identities"
import { ContactProfileDrawer } from "./contact-profile-drawer"

const mockUnmergeIdentity = jest.fn()

jest.mock("sonner", () => ({ toast: { error: jest.fn() } }))
jest.mock("@/lib/db/platform-identities", () => {
  const actual = jest.requireActual("@/lib/db/platform-identities")
  return {
    ...actual,
    unmergeIdentity: (...args: unknown[]) => mockUnmergeIdentity(...args),
  }
})

beforeEach(async () => {
  jest.restoreAllMocks()
  ;(toast.error as jest.Mock).mockReset()
  mockUnmergeIdentity
    .mockReset()
    .mockImplementation(jest.requireActual("@/lib/db/platform-identities").unmergeIdentity)
  await getDb().delete()
  __resetDbForTesting()
  getDb()
})

const SETTLE = { timeout: 5000 }

function noop() {}

describe("ContactProfileDrawer", () => {
  it("shows the resolved contact for a DM conversation", async () => {
    await upsertIdentity({
      platform: "telegram",
      adapterId: "a1",
      remoteUserId: "u1",
      displayName: "Alice",
    })
    render(<ContactProfileDrawer open onOpenChange={noop} conversationKey="telegram:a1:u1" />)
    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument(), SETTLE)
    expect(screen.getByTestId("contact-profile")).toHaveTextContent("u1")
  })

  it("shows an empty state when no identity matches the conversation", async () => {
    render(<ContactProfileDrawer open onOpenChange={noop} conversationKey="telegram:a1:unknown" />)
    await waitFor(
      () => expect(screen.getByTestId("contact-profile-empty")).toBeInTheDocument(),
      SETTLE
    )
  })

  it("shows the empty state for an unparseable conversation key", async () => {
    render(<ContactProfileDrawer open onOpenChange={noop} conversationKey="not-a-valid-key" />)
    await waitFor(
      () => expect(screen.getByTestId("contact-profile-empty")).toBeInTheDocument(),
      SETTLE
    )
  })

  it("lists absorbed identities and unmerges one", async () => {
    const primary = await upsertIdentity({
      platform: "telegram",
      adapterId: "a1",
      remoteUserId: "u1",
      displayName: "Alice",
    })
    const secondary = await upsertIdentity({
      platform: "discord",
      adapterId: "d1",
      remoteUserId: "d-9",
      displayName: "Alice (Discord)",
    })
    await mergeIdentities(primary.id, secondary.id)

    render(<ContactProfileDrawer open onOpenChange={noop} conversationKey="telegram:a1:u1" />)
    await waitFor(() => expect(screen.getByText("Alice (Discord)")).toBeInTheDocument(), SETTLE)
    fireEvent.click(screen.getByRole("button", { name: /unmerge/i }))
    // The secondary identity is restored as its own row.
    await waitFor(async () => {
      const restored = await getByPlatformUser("discord", "d-9")
      expect(restored).toBeDefined()
    }, SETTLE)
  })

  it("shows a localized error for a stale unmerge", async () => {
    const primary = await upsertIdentity({
      platform: "telegram",
      adapterId: "a1",
      remoteUserId: "u1",
      displayName: "Alice",
    })
    const secondary = await upsertIdentity({
      platform: "discord",
      adapterId: "d1",
      remoteUserId: "d-9",
      displayName: "Alice (Discord)",
    })
    await mergeIdentities(primary.id, secondary.id)
    mockUnmergeIdentity.mockResolvedValue({
      ok: false,
      reason: "primary_missing",
    })

    render(<ContactProfileDrawer open onOpenChange={noop} conversationKey="telegram:a1:u1" />)
    await waitFor(() => expect(screen.getByText("Alice (Discord)")).toBeInTheDocument(), SETTLE)
    fireEvent.click(screen.getByRole("button", { name: /unmerge/i }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("This contact no longer exists."))
  })

  it("mounts the merge dialog with the conversation identity locked as primary", async () => {
    const primary = await upsertIdentity({
      platform: "telegram",
      adapterId: "a1",
      remoteUserId: "u1",
      displayName: "Alice",
    })
    const candidate = await upsertIdentity({
      platform: "discord",
      adapterId: "d1",
      remoteUserId: "d-9",
      displayName: "Alice Discord",
    })
    render(<ContactProfileDrawer open onOpenChange={noop} conversationKey="telegram:a1:u1" />)

    await waitFor(() => expect(screen.getByText("Alice Discord")).toBeInTheDocument(), SETTLE)
    fireEvent.click(screen.getByRole("button", { name: /^merge$/i }))
    expect(await screen.findByTestId(`primary-badge-${primary.id}`)).toBeInTheDocument()
    fireEvent.click(screen.getByTestId(`identity-card-${candidate.id}`))
    expect(screen.getByTestId(`primary-badge-${primary.id}`)).toBeInTheDocument()
  })

  it("recomputes valid candidates when switching contacts", async () => {
    const first = await upsertIdentity({
      platform: "telegram",
      adapterId: "a1",
      remoteUserId: "u1",
      displayName: "Alice",
    })
    const absorbed = await upsertIdentity({
      platform: "discord",
      adapterId: "d1",
      remoteUserId: "d-9",
      displayName: "Alice Discord",
    })
    await upsertIdentity({
      platform: "slack",
      adapterId: "s1",
      remoteUserId: "s-2",
      displayName: "Other Contact",
    })
    expect((await mergeIdentities(first.id, absorbed.id)).ok).toBe(true)

    const { rerender } = render(
      <ContactProfileDrawer open onOpenChange={noop} conversationKey="telegram:a1:u1" />
    )
    await waitFor(() => expect(screen.getByText("Other Contact")).toBeInTheDocument(), SETTLE)
    rerender(<ContactProfileDrawer open onOpenChange={noop} conversationKey="slack:s1:s-2" />)
    await waitFor(
      () => expect(screen.getByTestId("contact-profile")).toHaveTextContent("s-2"),
      SETTLE
    )
    expect(screen.getByText("Alice")).toBeInTheDocument()
    expect(screen.queryByText("Alice Discord")).not.toBeInTheDocument()
  })
})
