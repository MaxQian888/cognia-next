import { describe, expect, it } from "vitest"

import { call, signInAndGetTokens } from "../test/helpers"
import { normalizeRevocation } from "./revocation"

const json = (status: number, body: unknown) => Response.json(body, { status })

describe("normalizeRevocation", () => {
  it("answers an unknown or retired token with 200, as RFC 7009 requires", async () => {
    for (const description of ["token not found", "refresh token revoked"]) {
      const response = await normalizeRevocation(
        json(400, { error: "invalid_request", error_description: description })
      )
      expect(response.status).toBe(200)
      expect(await response.text()).toBe("")
    }
  })

  it("passes every other answer through unchanged", async () => {
    for (const original of [
      json(400, { error: "invalid_request", error_description: "token is required" }),
      json(401, { error: "invalid_client" }),
      new Response("not json", { status: 400 }),
      new Response(null, { status: 200 }),
    ]) {
      expect(await normalizeRevocation(original)).toBe(original)
    }
  })
})

describe("POST /oauth2/revoke", () => {
  it("succeeds for a retired refresh token, and names a JWT access token unsupported", async () => {
    const { tokens } = await signInAndGetTokens()
    const revoke = (token: string, hint: string) =>
      call("/api/auth/oauth2/revoke", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token, token_type_hint: hint, client_id: "cognia-app" }),
      })
    expect((await revoke(tokens.refresh_token!, "refresh_token")).status).toBe(200)
    // Revoked already: still 200, nothing left to revoke.
    const again = await revoke(tokens.refresh_token!, "refresh_token")
    expect({ status: again.status, body: await again.text() }).toEqual({ status: 200, body: "" })
    // A self-contained access token is RFC 7009 §2.2.1's `unsupported_token_type`,
    // which clients report as "expires on its own", not as a failure.
    const access = await revoke(tokens.access_token, "access_token")
    expect(access.status).toBe(400)
    expect(((await access.json()) as { error: string }).error).toBe("unsupported_token_type")
  })
})
