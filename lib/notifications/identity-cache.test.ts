import {
  getNotificationIdentity,
  setNotificationIdentity,
  setNotificationNamespaceAccount,
  __resetNotificationIdentityForTesting,
} from "./identity-cache"

beforeEach(() => __resetNotificationIdentityForTesting())

it("is null before any prime", () => {
  expect(getNotificationIdentity()).toBeNull()
})

it("setNotificationIdentity stores the full triple", () => {
  setNotificationIdentity({ namespaceId: "ns", accountId: "acct", authorityHostId: "host" })
  expect(getNotificationIdentity()).toEqual({
    namespaceId: "ns",
    accountId: "acct",
    authorityHostId: "host",
  })
})

it("setNotificationNamespaceAccount keeps a previously resolved host", () => {
  setNotificationIdentity({ namespaceId: "old", accountId: "old", authorityHostId: "device-1" })
  setNotificationNamespaceAccount("ns2", "acct2")
  expect(getNotificationIdentity()).toEqual({
    namespaceId: "ns2",
    accountId: "acct2",
    authorityHostId: "device-1",
  })
})

it("setNotificationNamespaceAccount defaults the host before any full prime", () => {
  setNotificationNamespaceAccount("ns", "acct")
  expect(getNotificationIdentity()?.authorityHostId).toBe("unknown")
})

it("reset clears the cache", () => {
  setNotificationIdentity({ namespaceId: "ns", accountId: "a", authorityHostId: "h" })
  __resetNotificationIdentityForTesting()
  expect(getNotificationIdentity()).toBeNull()
})
