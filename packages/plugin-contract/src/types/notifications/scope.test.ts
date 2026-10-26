// Coverage for the scope contract (V2): the canonical scopeKey encoding, its
// reversibility, separator-safety, the namespace+account PREFIX used for
// account-level reconciliation, and the legacy projectId→workspaceId mapping.
// Pure — no Dexie.

import {
  notificationScopeKey,
  scopeKeyOf,
  notificationAccountScopePrefix,
  parseNotificationScopeKey,
  scopeFromLegacy,
} from "./scope"

const FIELDS = {
  namespaceId: "cognia-claude",
  accountId: "acct-1",
  workspaceId: "ws-9",
  businessProjectId: "bp-3",
}

describe("notificationScopeKey", () => {
  it("encodes the four stable fields in fixed order", () => {
    const k = notificationScopeKey(FIELDS)
    const parts = k.split("\u001f")
    expect(parts).toHaveLength(4)
    expect(parts[0]).toBe("cognia-claude")
    expect(parts[1]).toBe("acct-1")
    expect(parts[2]).toBe("ws-9")
    expect(parts[3]).toBe("bp-3")
  })

  it("encodes absent trailing fields as empty segments (stable under addition)", () => {
    const k = notificationScopeKey({ namespaceId: "n", accountId: "a" })
    expect(k.split("\u001f")).toEqual(["n", "a", "", ""])
  })

  it("escapes a field that itself contains the separator", () => {
    const tricky = { ...FIELDS, workspaceId: "ws\u001finjected" }
    const k = notificationScopeKey(tricky)
    // The literal SEP inside the id is percent-encoded, so the key still has
    // exactly 4 segments — no ambiguity for the prefix matcher.
    expect(k.split("\u001f")).toHaveLength(4)
  })
})

describe("scopeKeyOf / parseNotificationScopeKey", () => {
  it("round-trips the stable fields", () => {
    const scope = { ...FIELDS, authorityHostId: "host-1", executionHostId: "exec-2" }
    const key = scopeKeyOf(scope)
    const parsed = parseNotificationScopeKey(key)
    expect(parsed.namespaceId).toBe("cognia-claude")
    expect(parsed.accountId).toBe("acct-1")
    expect(parsed.workspaceId).toBe("ws-9")
    expect(parsed.businessProjectId).toBe("bp-3")
  })

  it("omits the host authority + execution host from the key (unstable fields)", () => {
    const a = scopeKeyOf({ ...FIELDS, authorityHostId: "host-A" })
    const b = scopeKeyOf({
      ...FIELDS,
      authorityHostId: "host-B",
      executionHostId: "e",
      runtimeId: "r",
    })
    // The SAME fact under a different host/run mints the SAME scopeKey.
    expect(a).toBe(b)
  })
})

describe("notificationAccountScopePrefix", () => {
  const prefix = notificationAccountScopePrefix({ namespaceId: "n", accountId: "acct" })

  it("prefix-matches every workspace scopeKey the account wrote", () => {
    const ws = notificationScopeKey({ namespaceId: "n", accountId: "acct", workspaceId: "ws1" })
    expect(ws.startsWith(prefix)).toBe(true)
  })

  it("prefix-matches the account-level scopeKey (empty workspace)", () => {
    const acct = notificationScopeKey({ namespaceId: "n", accountId: "acct" })
    expect(acct.startsWith(prefix)).toBe(true)
  })

  it("does NOT match a foreign account's scopeKey", () => {
    const other = notificationScopeKey({ namespaceId: "n", accountId: "other", workspaceId: "ws1" })
    expect(other.startsWith(prefix)).toBe(false)
  })

  it("does NOT false-match an account id that is a string prefix of another", () => {
    // `acct` is a prefix of `acct-long` — the trailing SEP in the prefix is
    // load-bearing: without it this would wrongly match a different account.
    const longer = notificationScopeKey({
      namespaceId: "n",
      accountId: "acct-long",
      workspaceId: "w",
    })
    expect(longer.startsWith(prefix)).toBe(false)
  })
})

describe("scopeFromLegacy", () => {
  it("maps the legacy projectId onto workspaceId, never businessProjectId", () => {
    const s = scopeFromLegacy({
      namespaceId: "n",
      accountId: "a",
      authorityHostId: "h",
      legacyProjectId: "proj-1",
    })
    expect(s.workspaceId).toBe("proj-1")
    expect(s.businessProjectId).toBeUndefined()
    expect(s.authorityHostId).toBe("h")
  })

  it("leaves workspaceId unset for a legacy record without one", () => {
    const s = scopeFromLegacy({ namespaceId: "n", accountId: "a", authorityHostId: "h" })
    expect(s.workspaceId).toBeUndefined()
  })
})
