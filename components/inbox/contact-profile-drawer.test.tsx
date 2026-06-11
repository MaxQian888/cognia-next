/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"
import { render, screen, waitFor, fireEvent } from "@testing-library/react"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { upsertIdentity, mergeIdentities, getByPlatformUser } from "@/lib/db/platform-identities"
import { ContactProfileDrawer } from "./contact-profile-drawer"

beforeEach(async () => {
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
})
