import { accountMatchesBinding, assertRemoteDocBinding, bindRemoteDocRef } from "./account-binding"
import type { RemoteDocRef } from "./types"

const ref: RemoteDocRef = { providerId: "test", kind: "doc", id: "same", title: "Spec" }

it("pins the original account and epoch without mutating the provider result", () => {
  const bound = bindRemoteDocRef(ref, { id: "a", label: "Same", authorizationEpoch: "first" })
  expect(bound.accountBinding).toEqual({ accountId: "a", authorizationEpoch: "first" })
  expect(ref.accountBinding).toBeUndefined()
  expect(() => assertRemoteDocBinding(bound, "b", "first")).toThrow("notAuthorized")
  expect(() => assertRemoteDocBinding(bound, "a", "second")).toThrow("notAuthorized")
  expect(() => bindRemoteDocRef(bound, { id: "b", label: "Same" })).toThrow("notAuthorized")
})

it("matches epochs exactly including missing legacy values", () => {
  expect(accountMatchesBinding({ id: "a", label: "A" }, { accountId: "a" })).toBe(true)
  expect(
    accountMatchesBinding({ id: "a", label: "A", authorizationEpoch: "new" }, { accountId: "a" })
  ).toBe(false)
  expect(accountMatchesBinding({ id: "b", label: "A" }, { accountId: "a" })).toBe(false)
})
