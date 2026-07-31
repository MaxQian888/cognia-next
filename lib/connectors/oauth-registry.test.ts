/**
 * OAuth registry tests — Task 80 + Task 93, updated at ADR-0009 v41 / D2
 * to keep the deep-link registry pointed at the real platform handlers.
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

  it("slack handler delegates to the real OAuth exchange", async () => {
    const handler = oauthRegistry.get("slack")
    expect(handler).toBeDefined()
    // Real handler delegates to `handleSlackOAuth`; a malformed state surfaces
    // the platform parser's "state malformed" error before any code exchange.
    await expect(handler!("fake-code", "garbage")).rejects.toThrow(/state malformed/i)
  })

  it("has the lark key registered", () => {
    expect(oauthRegistry.has("lark")).toBe(true)
  })

  it("lark handler delegates to the real OAuth exchange", async () => {
    const handler = oauthRegistry.get("lark")
    expect(handler).toBeDefined()
    // Real handler delegates to `handleLarkOAuth`; calling with a malformed
    // state surfaces the parser's "state malformed" error before any token
    // exchange, which is the stable boundary the deep-link router depends on.
    await expect(handler!("fake-code", "garbage")).rejects.toThrow(/state malformed/i)
  })

  it("does not have telegram key registered (no OAuth)", () => {
    expect(oauthRegistry.has("telegram")).toBe(false)
  })

  it("does not have discord key registered (no OAuth)", () => {
    expect(oauthRegistry.has("discord")).toBe(false)
  })
})
