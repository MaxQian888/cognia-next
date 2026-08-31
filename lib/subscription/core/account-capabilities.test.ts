import { accountCapabilities, providerDisplayOrder } from "./account-capabilities"

import type { AccountSummary } from "@/types/subscription"

function summary(overrides: Partial<AccountSummary> = {}): AccountSummary {
  return {
    id: "account-1",
    provider: "codex",
    variant: "codex",
    expiresAtMs: 0,
    createdAtMs: 1,
    lastUsedAtMs: 1,
    authMode: "chatgpt",
    credentialSource: "oauth",
    health: "ready",
    isExternal: false,
    ...overrides,
  }
}

describe("accountCapabilities", () => {
  it("allows targeted reauthentication only for Cognia-managed Codex OAuth", () => {
    expect(accountCapabilities(summary()).reauthenticate).toBe(true)
    expect(accountCapabilities(summary({ authMode: "api_key" })).reauthenticate).toBe(false)
    expect(accountCapabilities(summary({ isExternal: true, credentialSource: "file" }))).toEqual(
      expect.objectContaining({ reauthenticate: false, updateCredential: true })
    )
  })

  it("keeps OpenCode discovery pointers read-only except local unlink", () => {
    expect(
      accountCapabilities(
        summary({
          provider: "opencode",
          variant: "opencode-discovered",
          authMode: "external",
          isExternal: true,
        })
      )
    ).toEqual({
      activate: false,
      deactivate: false,
      setDefault: false,
      rename: false,
      bindPreset: false,
      updateCredential: false,
      reauthenticate: false,
      removeLocal: true,
    })
  })

  it("disables presets for managed OpenCode keys", () => {
    expect(
      accountCapabilities(
        summary({ provider: "opencode", variant: "opencode-zen", authMode: "api_key" })
      ).bindPreset
    ).toBe(false)
  })
})

it("keeps the provider order stable", () => {
  expect(
    ["opencode", "anthropic", "codex"].sort(
      (a, b) => providerDisplayOrder(a as never) - providerDisplayOrder(b as never)
    )
  ).toEqual(["anthropic", "codex", "opencode"])
})
