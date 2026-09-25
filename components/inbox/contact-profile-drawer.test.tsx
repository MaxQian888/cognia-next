/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"
import { render, screen, waitFor, fireEvent } from "@testing-library/react"
import { toast } from "sonner"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import {
  upsertIdentity,
  mergeIdentities,
  getByPlatformUser,
  updateIdentityProfile,
} from "@/lib/db/platform-identities"
import { ContactProfileDrawer } from "./contact-profile-drawer"

const mockUnmergeIdentity = jest.fn()
const mockRoute = jest.fn(() => "local")

jest.mock("sonner", () => ({ toast: { error: jest.fn(), success: jest.fn() } }))
jest.mock("@/lib/connectors/inbox-writes", () => ({ useInboxWriteRoute: () => mockRoute() }))
jest.mock("@/lib/db/platform-identities", () => {
  const actual = jest.requireActual("@/lib/db/platform-identities")
  return {
    ...actual,
    unmergeIdentity: (...args: unknown[]) => mockUnmergeIdentity(...args),
  }
})

beforeEach(async () => {
  jest.restoreAllMocks()
  mockRoute.mockReturnValue("local")
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

  it("resolves a Slack DM by its latest sender, not the channel id", async () => {
    await upsertIdentity({
      platform: "slack",
      adapterId: "a1",
      remoteUserId: "U1",
      displayName: "Umi",
    })
    const db = getDb()
    await db.sessions.add({
      id: "s-dm",
      title: "DM",
      createdAt: 1,
      updatedAt: 1,
      platformConversationKey: "slack:a1:D9",
      platformBinding: { adapterId: "a1", conversationKey: "slack:a1:D9" },
    } as never)
    await db.messages.add({
      id: "m1",
      sessionId: "s-dm",
      role: "user",
      createdAt: 2,
      parts: [{ type: "text", text: "hi" }],
      metadata: {
        platformMessage: {
          messageId: "p1",
          platform: "slack",
          sender: { id: "x", platform: "slack", remoteUserId: "U1", displayName: "Umi" },
        },
      },
    } as never)
    render(<ContactProfileDrawer open onOpenChange={noop} conversationKey="slack:a1:D9" />)
    await waitFor(() => expect(screen.getByText("Umi")).toBeInTheDocument(), SETTLE)
  })

  it("edits and saves the relationship and note on the host", async () => {
    const primary = await upsertIdentity({
      platform: "telegram",
      adapterId: "a1",
      remoteUserId: "u1",
      displayName: "Alice",
    })
    render(<ContactProfileDrawer open onOpenChange={noop} conversationKey="telegram:a1:u1" />)
    const relationship = await screen.findByLabelText("Relationship", {}, SETTLE)
    fireEvent.change(relationship, { target: { value: "manager" } })
    fireEvent.change(screen.getByLabelText("Note"), { target: { value: "prefers mornings" } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(async () => {
      const row = await getDb().platformIdentities.get(primary.id)
      expect(row).toMatchObject({ relationship: "manager", note: "prefers mornings" })
    }, SETTLE)
    expect(toast.success).toHaveBeenCalledWith("Contact notes saved")
  })

  it("shows the profile read-only on a paired device", async () => {
    mockRoute.mockReturnValue("remote")
    const primary = await upsertIdentity({
      platform: "telegram",
      adapterId: "a1",
      remoteUserId: "u1",
      displayName: "Alice",
    })
    await updateIdentityProfile(primary.id, { relationship: "sister" })
    render(<ContactProfileDrawer open onOpenChange={noop} conversationKey="telegram:a1:u1" />)
    const readOnly = await screen.findByTestId("contact-profile-notes-readonly", {}, SETTLE)
    expect(readOnly).toHaveTextContent("Relationship: sister")
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument()
  })
})
