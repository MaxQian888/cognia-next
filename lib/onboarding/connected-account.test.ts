import { describeConnectedAccount } from "./connected-account"
import type { Account, ProviderCredential } from "@/types/subscription"

const account = (credential: ProviderCredential): Account => ({
  id: "acc-1",
  credential,
  createdAtMs: 1,
  lastUsedAtMs: 1,
})

describe("describeConnectedAccount", () => {
  it("reads Anthropic's identity and tier", () => {
    const out = describeConnectedAccount(
      account({
        provider: "anthropic",
        accessToken: "a",
        refreshToken: "r",
        expiresAtMs: 0,
        mode: "subscription",
        email: "ada@example.com",
        plan: "max",
        storedAtMs: 1,
      })
    )
    expect(out).toEqual({ provider: "anthropic", email: "ada@example.com", plan: "max" })
  })

  it("reads Codex's differently-named tier field", () => {
    // `chatgptPlanType`, not `plan` — the reason this is a function and not a
    // property read at the call site.
    const out = describeConnectedAccount(
      account({
        provider: "codex",
        accessToken: "a",
        refreshToken: "r",
        idTokenRaw: "",
        expiresAtMs: 0,
        authMode: "chatgpt",
        email: "ada@example.com",
        chatgptPlanType: "plus",
        storedAtMs: 1,
      })
    )
    expect(out).toEqual({ provider: "codex", email: "ada@example.com", plan: "plus" })
  })

  it("reports OpenCode Zen's plan tag, which is all the identity it has", () => {
    const out = describeConnectedAccount(
      account({ provider: "opencode-zen", accessToken: "k", plan: "go", storedAtMs: 1 })
    )
    expect(out).toEqual({ provider: "opencode", plan: "go" })
  })

  it("maps an adopted OpenCode discovery onto the opencode vault", () => {
    // The credential tag and the vault id differ for this variant, and the
    // vault id is what `defaultProvider` has to be set to.
    const out = describeConnectedAccount(
      account({
        provider: "opencode-discovered",
        subProvider: "anthropic",
        authJsonPath: "/tmp/auth.json",
        originalPayloadJson: "{}",
        lastSeenAtMs: 1,
      })
    )
    expect(out).toEqual({ provider: "opencode" })
  })
})
