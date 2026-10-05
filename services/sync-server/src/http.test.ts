import { describe, expect, it } from "vitest"

import { SERVER_TIME_HEADER, SyncHttpError, errorReply, reply, toResponse } from "./http"

describe("http helpers", () => {
  it("shapes errors as {error, message?}", () => {
    expect(errorReply(new SyncHttpError(409, "head_moved", "fetch and retry"))).toEqual({
      status: 409,
      body: { error: "head_moved", message: "fetch and retry" },
    })
    expect(errorReply(new SyncHttpError(404, "not_found"))).toEqual({
      status: 404,
      body: { error: "not_found" },
    })
  })

  it("stamps the server time and forbids caching", async () => {
    const response = toResponse(reply({ ok: true }, 201), 1234)
    expect(response.status).toBe(201)
    expect(response.headers.get(SERVER_TIME_HEADER)).toBe("1234")
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.json()).toEqual({ ok: true })
  })
})
