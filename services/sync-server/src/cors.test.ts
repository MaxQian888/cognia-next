import { describe, expect, it } from "vitest"

import { preflightResponse, withCors } from "./cors"

const ORIGINS = ["https://app.test"]

describe("CORS", () => {
  it("answers a preflight for an allowed origin with the proof header allowed", () => {
    const response = preflightResponse(
      new Request("https://sync.test/v1/space", {
        method: "OPTIONS",
        headers: { origin: "https://app.test" },
      }),
      ORIGINS
    )
    expect(response.status).toBe(204)
    expect(response.headers.get("access-control-allow-origin")).toBe("https://app.test")
    expect(response.headers.get("access-control-allow-headers")).toContain("cognia-device-proof")
    expect(response.headers.get("access-control-allow-credentials")).toBeNull()
  })

  it("gives a foreign origin nothing", () => {
    const request = new Request("https://sync.test/v1/space", {
      headers: { origin: "https://evil.test" },
    })
    expect(
      preflightResponse(request, ORIGINS).headers.get("access-control-allow-origin")
    ).toBeNull()
    expect(
      withCors(new Response("x"), request, ORIGINS).headers.get("access-control-allow-origin")
    ).toBeNull()
  })

  it("exposes the server time to the web app", () => {
    const request = new Request("https://sync.test/v1/space", {
      headers: { origin: "https://app.test" },
    })
    const response = withCors(new Response("x", { status: 418 }), request, ORIGINS)
    expect(response.status).toBe(418)
    expect(response.headers.get("access-control-expose-headers")).toBe("cognia-server-time")
    expect(response.headers.get("vary")).toBe("Origin")
  })
})
