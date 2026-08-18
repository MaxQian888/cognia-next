import type { ChatSession } from "@cognia/agent-config-types"

import type { PlatformIdentityRow } from "@/lib/db/connector-types"
import type { ContactGroup } from "@/lib/db/platform-identities"

import { __resetGlobalSearchCachesForTesting } from "../cache"
import { makeProviderInput, makeTestContext, TEST_NOW } from "../testing"
import {
  INBOX_CONTACTS_PROVIDER_ID,
  INBOX_PROVIDER_ID,
  contactAction,
  createInboxContactsProvider,
  createInboxProviders,
  findContactDmSession,
  inboxContactsProvider,
  inboxProvider,
} from "./inbox"

jest.mock("@/lib/db/platform-identities", () => ({
  listMergedGroups: jest.fn(async () => []),
}))

const sessions = [
  {
    id: "s1",
    title: "Ops room",
    updatedAt: TEST_NOW,
    platformBinding: { platform: "lark", adapterId: "a1", conversationKey: "lark:a1:oc_1" },
  },
  {
    id: "s2",
    title: "",
    updatedAt: TEST_NOW - 1,
    platformBinding: { platform: "slack", adapterId: "a2", conversationKey: "slack:a2:C1" },
  },
  { id: "s3", title: "Plain chat", updatedAt: TEST_NOW },
  // DM with alice on telegram adapter a3 (newer) and on a re-created adapter a4 (older).
  {
    id: "dm-new",
    title: "Alice",
    updatedAt: TEST_NOW - 2,
    platformBinding: { platform: "telegram", adapterId: "a3", conversationKey: "telegram:a3:1001" },
  },
  {
    id: "dm-old",
    title: "Alice (old bot)",
    updatedAt: TEST_NOW - 3,
    platformBinding: { platform: "telegram", adapterId: "a4", conversationKey: "telegram:a4:1001" },
  },
  // A thread inside a chat with the same id is not a DM.
  {
    id: "thread",
    title: "Alice thread",
    updatedAt: TEST_NOW,
    platformBinding: {
      platform: "telegram",
      adapterId: "a3",
      conversationKey: "telegram:a3:1001:77",
    },
  },
  {
    id: "broken",
    title: "Broken key",
    updatedAt: TEST_NOW,
    platformBinding: { platform: "telegram", adapterId: "a3", conversationKey: "nope" },
  },
] as unknown as ChatSession[]

const identity = (over: Partial<PlatformIdentityRow>): PlatformIdentityRow =>
  ({
    id: "i",
    platform: "telegram",
    adapterId: "a3",
    remoteUserId: "1001",
    lastSeenAt: TEST_NOW,
    ...over,
  }) as PlatformIdentityRow

const alice: ContactGroup = {
  primary: identity({ id: "alice", displayName: "Alice", adapterId: "a4", avatarUrl: "a.png" }),
  merged: [identity({ id: "alice-slack", platform: "slack", adapterId: "a2", remoteUserId: "U9" })],
}
const bob: ContactGroup = {
  primary: identity({ id: "bob", remoteUserId: "2002", adapterId: "a3", lastSeenAt: TEST_NOW - 5 }),
  merged: [],
}
const nameless: ContactGroup = {
  primary: identity({ id: "n1", remoteUserId: "3003", displayName: "  " }),
  merged: [identity({ id: "n2", displayName: "Named Twin", remoteUserId: "3004" })],
}

describe("inboxProvider (conversations)", () => {
  afterEach(() => __resetGlobalSearchCachesForTesting())

  it("only platform-bound sessions, opens the Inbox route, marks the active one", async () => {
    const ctx = makeTestContext({ sessions, activeSessionId: "s1" })
    const out = await inboxProvider.search(makeProviderInput("ops", { ctx }))
    expect(out.items.map((i) => i.id)).toEqual(["inbox-conversation:s1"])
    expect(out.items[0]).toMatchObject({
      kind: "inbox-conversation",
      subtitle: "lark:a1:oc_1",
      meta: "lark",
      timestamp: TEST_NOW,
      extra: { current: true },
      action: { type: "open-inbox-conversation", conversationKey: "lark:a1:oc_1" },
    })
    const byKey = await inboxProvider.search(makeProviderInput("slack", { ctx }))
    expect(byKey.items[0]!.title).toBe("slack:a2:C1")
    expect(byKey.items[0]!.extra?.current).toBe(false)
    const plain = await inboxProvider.search(makeProviderInput("plain", { ctx }))
    expect(plain.items).toEqual([])
    expect(inboxProvider.id).toBe(INBOX_PROVIDER_ID)
  })
})

describe("findContactDmSession / contactAction", () => {
  it("prefers the identity's own adapter, then the same platform, newest first", () => {
    // alice.primary is on a4 → the older a4 DM wins over the newer a3 one.
    expect(findContactDmSession(alice, sessions)?.id).toBe("dm-old")
    // Same user id on the platform, but no identity on that adapter → falls back.
    const aliceOnA9: ContactGroup = {
      primary: identity({ id: "x", adapterId: "a9" }),
      merged: [],
    }
    expect(findContactDmSession(aliceOnA9, sessions)?.id).toBe("dm-new")
    // Threads and unparseable keys never match; a stranger has no DM.
    expect(findContactDmSession(bob, sessions)).toBeUndefined()
    expect(findContactDmSession(alice, [])).toBeUndefined()
  })

  it("opens the DM when bound, else the adapter's inbox", () => {
    expect(contactAction(alice, sessions)).toEqual({
      type: "open-inbox-conversation",
      conversationKey: "telegram:a4:1001",
    })
    expect(contactAction(bob, sessions)).toEqual({
      type: "navigate",
      href: "/inbox/adapter?adapterId=a3",
    })
  })
})

describe("inbox contacts provider", () => {
  afterEach(() => __resetGlobalSearchCachesForTesting())

  it("matches by name / user id / platform, names the action, carries the avatar", async () => {
    const provider = createInboxContactsProvider({
      listContacts: async () => [alice, bob, nameless],
    })
    const ctx = makeTestContext({ sessions })
    const out = await provider.search(makeProviderInput("alice", { ctx }))
    expect(out.items[0]).toMatchObject({
      id: "inbox-contact:alice",
      kind: "inbox-contact",
      title: "Alice",
      subtitle: "telegram · slack",
      meta: "globalSearch.inbox.openConversation",
      icon: { avatar: { name: "Alice", avatarImageUrl: "a.png" } },
      timestamp: TEST_NOW,
      action: { type: "open-inbox-conversation", conversationKey: "telegram:a4:1001" },
    })
    // Bob has no display name → remoteUserId is the title; no DM → adapter route.
    const byId = await provider.search(makeProviderInput("2002", { ctx }))
    expect(byId.items[0]).toMatchObject({
      id: "inbox-contact:bob",
      title: "2002",
      meta: "globalSearch.inbox.openAdapter",
      icon: { avatar: { name: "2002" } },
      action: { type: "navigate", href: "/inbox/adapter?adapterId=a3" },
    })
    // A merged identity's platform is a keyword of the group.
    const bySlack = await provider.search(makeProviderInput("slack", { ctx }))
    expect(bySlack.items.map((i) => i.id)).toContain("inbox-contact:alice")
    // A blank primary name yields to a merged identity's name.
    const twin = await provider.search(makeProviderInput("twin", { ctx }))
    expect(twin.items[0]!.title).toBe("Named Twin")
    expect(provider.id).toBe(INBOX_CONTACTS_PROVIDER_ID)
  })

  it("ships both providers, and the default instance reads the identity directory", async () => {
    const both = createInboxProviders({ listContacts: async () => [] })
    expect(both.map((p) => p.kind)).toEqual(["inbox-conversation", "inbox-contact"])
    const { listMergedGroups } = jest.requireMock("@/lib/db/platform-identities") as {
      listMergedGroups: jest.Mock
    }
    listMergedGroups.mockResolvedValueOnce([bob])
    const out = await inboxContactsProvider.search(makeProviderInput("2002"))
    expect(out.items.map((i) => i.id)).toEqual(["inbox-contact:bob"])
  })
})
