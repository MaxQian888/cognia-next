import { describe, expect, it } from "vitest"

import { identitiesFromAccounts } from "./identities-claim"

describe("identitiesFromAccounts", () => {
  it("publishes Feishu as lark with its tenant and union id", () => {
    expect(identitiesFromAccounts([{ providerId: "feishu", accountId: "tk_1:on_union" }])).toEqual([
      { provider: "lark", tenant: "tk_1", subject: "on_union" },
    ])
  })

  it("passes GitHub, Google and Apple subjects through", () => {
    expect(
      identitiesFromAccounts([
        { providerId: "github", accountId: "12345" },
        { providerId: "google", accountId: "1098" },
        { providerId: "apple", accountId: "001.abc" },
      ])
    ).toEqual([
      { provider: "github", subject: "12345" },
      { provider: "google", subject: "1098" },
      { provider: "apple", subject: "001.abc" },
    ])
  })

  it("never publishes a password credential, an unknown provider or a malformed Feishu subject", () => {
    expect(
      identitiesFromAccounts([
        { providerId: "credential", accountId: "usr_x" },
        { providerId: "someday", accountId: "1" },
        { providerId: "feishu", accountId: "on_without_tenant" },
        { providerId: "feishu", accountId: ":on_x" },
        { providerId: "feishu", accountId: "tk:" },
        { providerId: "github", accountId: "" },
      ])
    ).toEqual([])
  })

  it("drops duplicates", () => {
    expect(
      identitiesFromAccounts([
        { providerId: "github", accountId: "1" },
        { providerId: "github", accountId: "1" },
      ])
    ).toHaveLength(1)
  })
})
