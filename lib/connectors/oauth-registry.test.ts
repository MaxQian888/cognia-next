/**
 * OAuth registry tests — Task 80 + Task 93, updated at ADR-0009 v41 / D2
 * when the Lark stub was replaced with the real handler.
 *
 * Lark exchange is exercised end-to-end in
 * `lib/connectors/adapters/lark/oauth-handler.test.ts` with mocked Dexie +
 * keyring + http; this file just verifies the registry shape so the
 * deep-link router resolves the right handler.
 */

import { oauthRegistry } from "./oauth-registry"

describe("oauthRegistry", () => {
  it("has the slack key registered", () => {
    expect(oauthRegistry.has("slack")).toBe(true)
  })

  it("slack handler throws Phase-2 stub error", async () => {
    const handler = oauthRegistry.get("slack")
    expect(handler).toBeDefined()
    await expect(handler!("fake-code", "fake-state")).rejects.toThrow(
      "Slack OAuth exchange not yet implemented"
    )
  })

  it("has the lark key registered", () => {
    expect(oauthRegistry.has("lark")).toBe(true)
  })

  it("lark handler is wired to the real OAuth exchange (no stub error)", async () => {
    const handler = oauthRegistry.get("lark")
    expect(handler).toBeDefined()
    // Real handler delegates to `handleLarkOAuth`; calling with a malformed
    // state surfaces the parser's "state malformed" error rather than the
    // old Phase-1 stub error. Either branch proves we left the stub
    // behind; we assert on the parser message because it has clearer
    // semantics for downstream tests.
    await expect(handler!("fake-code", "garbage")).rejects.toThrow(/state malformed/i)
  })

  it("does not have telegram key registered (no OAuth)", () => {
    expect(oauthRegistry.has("telegram")).toBe(false)
  })

  it("does not have discord key registered (no OAuth)", () => {
    expect(oauthRegistry.has("discord")).toBe(false)
  })
})
