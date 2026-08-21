/**
 * Slack authorize step.
 *
 * The three things that made the old flow impossible are exactly what these
 * pin: the state has to be `slack:<adapterId>:<nonce>` (or the completion
 * handler rejects it), the redirect has to be an https relay (Slack refuses a
 * custom scheme), and the pending record has to be written before the URL is
 * handed out (or the returned link can never be exchanged).
 */

jest.mock("@/lib/connectors/tauri/commands", () => ({ connectorsKeyringGet: jest.fn() }))

import { parseSlackOAuthState } from "./oauth-handler"
import { SLACK_BOT_SCOPES, beginSlackOAuth } from "./oauth-begin"

const RELAY = "https://relay.example/oauth/connector/slack/callback"

function deps(over: Partial<Parameters<typeof beginSlackOAuth>[1]> = {}) {
  return {
    keyringGet: jest.fn(async (_id: string, cred: string) =>
      cred === "clientId" ? "cid.123" : null
    ),
    setPending: jest.fn(async () => undefined),
    makeNonce: () => "nonce1",
    ...over,
  }
}

describe("beginSlackOAuth", () => {
  it("mints the state shape the completion handler parses", async () => {
    const d = deps()
    const { state } = await beginSlackOAuth({ adapterId: "sl1", redirectUri: RELAY }, d)

    expect(state).toBe("slack:sl1:nonce1")
    // The old flow sent a bare UUID here, which `parseSlackOAuthState` rejects.
    expect(parseSlackOAuthState(state)).toEqual({ adapterId: "sl1", nonce: "nonce1" })
  })

  it("builds an authorize URL carrying the bot scopes, redirect and state", async () => {
    const d = deps()
    const { authorizeUrl } = await beginSlackOAuth({ adapterId: "sl1", redirectUri: RELAY }, d)

    const url = new URL(authorizeUrl)
    expect(`${url.origin}${url.pathname}`).toBe("https://slack.com/oauth/v2/authorize")
    expect(url.searchParams.get("client_id")).toBe("cid.123")
    expect(url.searchParams.get("redirect_uri")).toBe(RELAY)
    expect(url.searchParams.get("state")).toBe("slack:sl1:nonce1")
    expect(url.searchParams.get("scope")).toBe(SLACK_BOT_SCOPES.join(","))
  })

  it("persists the pending record before returning the URL", async () => {
    const d = deps()
    const result = await beginSlackOAuth({ adapterId: "sl1", redirectUri: RELAY }, d)

    // Order matters: a link whose state was never stored can never be exchanged.
    expect(d.setPending).toHaveBeenCalledWith("sl1", {
      state: result.state,
      redirectUri: RELAY,
    })
  })

  it("does not hand out a URL when the pending write fails", async () => {
    const d = deps({
      setPending: jest.fn(async () => {
        throw new Error("keyring locked")
      }),
    })
    await expect(beginSlackOAuth({ adapterId: "sl1", redirectUri: RELAY }, d)).rejects.toThrow(
      "keyring locked"
    )
  })

  it("refuses a custom-scheme redirect — Slack only registers https", async () => {
    const d = deps()
    // This is the exact value the dialog used to send.
    await expect(
      beginSlackOAuth({ adapterId: "sl1", redirectUri: "cognia://connector/oauth/slack" }, d)
    ).rejects.toThrow("redirect_uri_invalid")
    expect(d.setPending).not.toHaveBeenCalled()
  })

  it("refuses a plain-http redirect", async () => {
    await expect(
      beginSlackOAuth({ adapterId: "sl1", redirectUri: "http://relay.example/cb" }, deps())
    ).rejects.toThrow("redirect_uri_invalid")
  })

  it("refuses a blank adapter id", async () => {
    await expect(beginSlackOAuth({ adapterId: "  ", redirectUri: RELAY }, deps())).rejects.toThrow(
      "adapter_id_required"
    )
  })

  it("reports a missing client id as a stable operator-facing reason", async () => {
    const d = deps({ keyringGet: jest.fn(async () => null) })
    await expect(beginSlackOAuth({ adapterId: "sl1", redirectUri: RELAY }, d)).rejects.toThrow(
      "client_id_missing"
    )
    expect(d.setPending).not.toHaveBeenCalled()
  })
})
