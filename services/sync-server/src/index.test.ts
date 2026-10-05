import { SELF } from "cloudflare:test"
import { describe, expect, it } from "vitest"

import { Person, testEnv } from "../test/helpers"
import { handleRequest, MAX_BODY_BYTES } from "./index"

describe("the sync Worker", () => {
  it("answers health without a token", async () => {
    const response = await SELF.fetch("https://sync.test/v1/health")
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, protocolVersion: 1 })
    expect(Number(response.headers.get("cognia-server-time"))).toBeGreaterThan(0)
  })

  it("is a 404 off the route list, before authentication", async () => {
    const response = await handleRequest(new Request("https://sync.test/v1/admin"), testEnv)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: "not_found" })
    expect(
      (await handleRequest(new Request("https://sync.test/", { method: "OPTIONS" }), testEnv))
        .status
    ).toBe(404)
  })

  it("needs a bearer token on every other route", async () => {
    const person = new Person()
    const response = await person.json("GET", "/v1/space", { token: null })
    expect(response).toMatchObject({ status: 401, body: { error: "unauthorized" } })
  })

  it("answers CORS preflights and stamps CORS on answers for the web app", async () => {
    const preflight = await handleRequest(
      new Request("https://sync.test/v1/registry", {
        method: "OPTIONS",
        headers: { origin: "https://app.test" },
      }),
      testEnv
    )
    expect(preflight.headers.get("access-control-allow-origin")).toBe("https://app.test")
    const person = new Person()
    const response = await person.call("GET", "/v1/space", {
      headers: { origin: "https://app.test" },
    })
    expect(response.headers.get("access-control-allow-origin")).toBe("https://app.test")
  })

  it("refuses an oversized or non-UTF-8 body", async () => {
    const person = new Person()
    const big = await person.json("POST", "/v1/space/genesis", {
      body: "x".repeat(MAX_BODY_BYTES + 1),
    })
    expect(big).toMatchObject({ status: 413, body: { error: "payload_too_large" } })
    const response = await handleRequest(
      new Request("https://sync.test/v1/space/genesis", {
        method: "POST",
        headers: { authorization: `Bearer ${await person.token()}` },
        body: new Uint8Array([0xff, 0xfe]),
      }),
      testEnv
    )
    expect(response.status).toBe(400)
  })

  it("answers 503 when misconfigured", async () => {
    const response = await handleRequest(new Request("https://sync.test/v1/health"), {
      ...testEnv,
      ISSUER: "",
    })
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: "server_misconfigured" })
  })
})
