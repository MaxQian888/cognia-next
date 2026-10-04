import { describe, expect, it } from "vitest"

import { call, signInAndGetTokens } from "../../test/helpers"

function deletion(method: string, accessToken?: string, body?: unknown, origin?: string) {
  return call("/api/account/deletion", {
    method,
    headers: {
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(origin ? { origin } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

describe("/api/account/deletion", () => {
  it("requires a bearer access token", async () => {
    const response = await deletion("GET")
    expect(response.status).toBe(401)
    expect(response.headers.get("www-authenticate")).toContain("invalid_token")
    expect((await deletion("GET", "not.a.token")).status).toBe(401)
  })

  it("reports, requests and cancels a deletion for the signed-in person", async () => {
    const { tokens } = await signInAndGetTokens()
    expect(await (await deletion("GET", tokens.access_token)).json()).toEqual({ status: "none" })

    const requested = await deletion("POST", tokens.access_token, { id_token: tokens.id_token })
    expect(requested.status).toBe(200)
    const state = (await requested.json()) as {
      status: string
      purgeAfter: string
      requestedAt: string
    }
    expect(state.status).toBe("pending")
    const coolingOff = Date.parse(state.purgeAfter) - Date.parse(state.requestedAt)
    expect(coolingOff).toBe(7 * 24 * 60 * 60 * 1000)

    expect(await (await deletion("DELETE", tokens.access_token)).json()).toEqual({
      status: "cancelled",
    })
  })

  it("refuses to start a deletion without a fresh ID token of the same person", async () => {
    const ada = await signInAndGetTokens()
    const grace = await signInAndGetTokens()
    expect((await deletion("POST", ada.tokens.access_token, {})).status).toBe(400)
    const foreign = await deletion("POST", ada.tokens.access_token, {
      id_token: grace.tokens.id_token,
    })
    expect(foreign.status).toBe(403)
    expect(((await foreign.json()) as { error: string }).error).toBe(
      "insufficient_user_authentication"
    )
    expect(
      (await deletion("POST", ada.tokens.access_token, { id_token: ada.tokens.access_token }))
        .status
    ).toBe(401)
    expect(await (await deletion("GET", ada.tokens.access_token)).json()).toEqual({
      status: "none",
    })
  })

  it("answers the web app across origins and refuses other methods", async () => {
    const { tokens } = await signInAndGetTokens()
    const response = await deletion("GET", tokens.access_token, undefined, "https://app.test")
    expect(response.headers.get("access-control-allow-origin")).toBe("https://app.test")
    expect((await deletion("PUT", tokens.access_token)).status).toBe(405)
  })
})
