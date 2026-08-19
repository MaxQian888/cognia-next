/** @jest-environment jsdom */
import {
  buildPairLink,
  PAIR_LINK_PARAM,
  readPairLinkPayload,
  stripPairLinkPayload,
} from "./pair-link"
import { encodePairPayload } from "./pair-payload"

function invitation(expiresAt = Date.now() + 300_000): string {
  return encodePairPayload({
    baseUrl: "https://127.0.0.1:27890",
    mode: "owner-invitation",
    invitation: "one-shot",
    hostId: "host-1",
    tenantId: "local_acct_a",
    expiresAt,
    serverVersion: "1.0.0",
    fingerprint: "ab12",
  })
}

describe("buildPairLink", () => {
  it("puts the invitation in the fragment so it never reaches a server", () => {
    const link = buildPairLink("http://localhost:3000/", invitation())
    expect(link.startsWith("http://localhost:3000/pair#")).toBe(true)
    expect(new URL(link).search).toBe("")
  })

  it("round-trips through the reader", () => {
    const payload = invitation()
    const url = new URL(buildPairLink("http://localhost:3000", payload))
    expect(readPairLinkPayload(url.search, url.hash)).toBe(payload)
  })
})

describe("readPairLinkPayload", () => {
  it("accepts the legacy query form the Capacitor deep-link router writes", () => {
    const payload = invitation()
    expect(readPairLinkPayload(`?${PAIR_LINK_PARAM}=${encodeURIComponent(payload)}`, "")).toBe(
      payload
    )
  })

  it("prefers the fragment when both are present", () => {
    const fromHash = invitation(Date.now() + 300_000)
    const fromQuery = invitation(Date.now() + 400_000)
    expect(
      readPairLinkPayload(
        `?${PAIR_LINK_PARAM}=${encodeURIComponent(fromQuery)}`,
        `#${PAIR_LINK_PARAM}=${encodeURIComponent(fromHash)}`
      )
    ).toBe(fromHash)
  })

  it("null for absent, malformed, or expired invitations", () => {
    expect(readPairLinkPayload("", "")).toBeNull()
    expect(readPairLinkPayload("", `#${PAIR_LINK_PARAM}=not-a-payload`)).toBeNull()
    expect(readPairLinkPayload("", `#${PAIR_LINK_PARAM}=cgnp2%7Cabc`)).toBeNull()
    // An expired invitation must reach the manual form with an explanation,
    // not be auto-submitted into a guaranteed Host rejection.
    const expired = encodePairPayload({
      baseUrl: "https://127.0.0.1:27890",
      mode: "owner-invitation",
      invitation: "one-shot",
      hostId: "host-1",
      tenantId: "local_acct_a",
      expiresAt: Date.now() - 1_000,
      serverVersion: "1.0.0",
      fingerprint: "",
    })
    expect(readPairLinkPayload("", `#${PAIR_LINK_PARAM}=${encodeURIComponent(expired)}`)).toBeNull()
  })
})

describe("stripPairLinkPayload", () => {
  function fakeWindow(search: string, hash: string) {
    const replaceState = jest.fn()
    return {
      window: {
        location: { pathname: "/pair", search, hash },
        history: { state: null, replaceState },
      } as unknown as Window,
      replaceState,
    }
  }

  it("removes the consumed invitation without adding a history entry", () => {
    const { window, replaceState } = fakeWindow("", `#${PAIR_LINK_PARAM}=abc`)
    stripPairLinkPayload(window)
    expect(replaceState).toHaveBeenCalledWith(null, "", "/pair")
  })

  it("keeps unrelated params on both sides", () => {
    const { window, replaceState } = fakeWindow(`?mode=add&${PAIR_LINK_PARAM}=abc`, "#tab=manual")
    stripPairLinkPayload(window)
    expect(replaceState).toHaveBeenCalledWith(null, "", "/pair?mode=add#tab=manual")
  })

  it("no-op when nothing to strip", () => {
    const { window, replaceState } = fakeWindow("?mode=add", "")
    stripPairLinkPayload(window)
    expect(replaceState).not.toHaveBeenCalled()
  })
})
