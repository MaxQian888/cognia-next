/**
 * @jest-environment node
 */
import nodeHttp from "node:http"

import { parseCallback, resultPage, startCallbackServer } from "./oauth-callback-server"

describe("parseCallback", () => {
  it("extracts code and state", () => {
    expect(parseCallback("/callback?code=abc&state=xyz")).toEqual({
      code: "abc",
      state: "xyz",
      error: undefined,
      errorDescription: undefined,
    })
  })

  it("extracts error and description", () => {
    expect(parseCallback("/callback?error=access_denied&error_description=nope")).toMatchObject({
      error: "access_denied",
      errorDescription: "nope",
    })
  })

  it("tolerates a malformed url", () => {
    expect(parseCallback("::::")).toEqual({})
  })
})

describe("resultPage", () => {
  it("renders success copy when a code is present", () => {
    expect(resultPage({ code: "abc" })).toContain("Authorization complete")
  })
  it("renders the error when present", () => {
    expect(resultPage({ error: "access_denied", errorDescription: "denied" })).toContain(
      "access_denied"
    )
  })
})

function get(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    nodeHttp
      .get(url, (res) => {
        res.resume()
        res.on("end", resolve)
      })
      .on("error", reject)
  })
}

describe("startCallbackServer (live loopback)", () => {
  it("captures the code from a redirect request", async () => {
    const server = await startCallbackServer()
    expect(server.redirectUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    const wait = server.waitForCode(2000)
    await get(`${server.redirectUrl}?code=THECODE&state=ST`)
    await expect(wait).resolves.toMatchObject({ code: "THECODE", state: "ST" })
    server.close()
  })

  it("rejects when the redirect carries an error", async () => {
    const server = await startCallbackServer()
    // Attach the rejection assertion BEFORE firing the request so there's no
    // window where `wait` rejects with no handler (Node would flag it unhandled).
    const assertion = expect(server.waitForCode(2000)).rejects.toThrow(/access_denied/)
    await get(`${server.redirectUrl}?error=access_denied`)
    await assertion
    server.close()
  })

  it("times out when no redirect arrives", async () => {
    const server = await startCallbackServer()
    await expect(server.waitForCode(20)).rejects.toThrow(/Timed out/)
    server.close()
  })
})
