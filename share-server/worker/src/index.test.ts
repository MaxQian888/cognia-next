import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import worker, { type Env } from "./index"

const SECRET = "test-secret" // injected via vitest.config.ts miniflare bindings

const ENVELOPE = {
  v: 1,
  alg: "AES-GCM",
  iv: "aXYtYmFzZTY0",
  ciphertext: "Y2lwaGVy",
  checksum: "0".repeat(64),
}

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`https://share.test${path}`, init)
}

async function run(request: Request): Promise<Response> {
  const ctx = createExecutionContext()
  const res = await worker.fetch(request, env as Env, ctx)
  await waitOnExecutionContext(ctx)
  return res
}

function authed(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }
}

async function create(body: Record<string, unknown>): Promise<string> {
  const res = await run(req("/v1/share", authed("POST", { envelope: ENVELOPE, ...body })))
  expect(res.status).toBe(201)
  return (await res.json<{ code: string }>()).code
}

describe("auth", () => {
  it("rejects POST without a bearer", async () => {
    const res = await run(
      req("/v1/share", { method: "POST", body: JSON.stringify({ envelope: ENVELOPE }) })
    )
    expect(res.status).toBe(401)
  })

  it("rejects POST with a wrong bearer", async () => {
    const res = await run(
      req("/v1/share", {
        method: "POST",
        headers: { Authorization: "Bearer nope" },
        body: JSON.stringify({ envelope: ENVELOPE }),
      })
    )
    expect(res.status).toBe(401)
  })
})

describe("create + read", () => {
  it("stores an opaque envelope and serves it back verbatim", async () => {
    const code = await create({})
    const res = await run(req(`/v1/share/${code}`))
    expect(res.status).toBe(200)
    const { envelope } = await res.json<{ envelope: typeof ENVELOPE }>()
    expect(envelope).toEqual(ENVELOPE)
    expect(res.headers.get("Cache-Control")).toBe("no-store")
  })

  it("rejects a malformed envelope", async () => {
    const res = await run(req("/v1/share", authed("POST", { envelope: { v: 2 } })))
    expect(res.status).toBe(400)
  })

  it("rejects invalid json", async () => {
    const res = await run(
      req("/v1/share", {
        method: "POST",
        headers: { Authorization: `Bearer ${SECRET}` },
        body: "{",
      })
    )
    expect(res.status).toBe(400)
  })

  it("returns 404 for an unknown code", async () => {
    const res = await run(req("/v1/share/does-not-exist"))
    expect(res.status).toBe(404)
  })

  it("returns expiresAt when a ttl is set", async () => {
    const res = await run(
      req("/v1/share", authed("POST", { envelope: ENVELOPE, ttlSeconds: 3600 }))
    )
    const body = await res.json<{ expiresAt?: number }>()
    expect(typeof body.expiresAt).toBe("number")
  })
})

describe("max-views / burn-after-read", () => {
  it("self-destructs after maxViews successful reads", async () => {
    const code = await create({ maxViews: 2 })
    expect((await run(req(`/v1/share/${code}`))).status).toBe(200)
    expect((await run(req(`/v1/share/${code}`))).status).toBe(200)
    expect((await run(req(`/v1/share/${code}`))).status).toBe(404)
  })

  it("burns after the first read", async () => {
    const code = await create({ burnAfterRead: true })
    expect((await run(req(`/v1/share/${code}`))).status).toBe(200)
    expect((await run(req(`/v1/share/${code}`))).status).toBe(404)
  })
})

describe("stats", () => {
  it("reports view count for the owner and 401 without a bearer", async () => {
    const code = await create({ maxViews: 5 })
    await run(req(`/v1/share/${code}`))
    const res = await run(req(`/v1/share/${code}/stats`, authed("GET")))
    expect(res.status).toBe(200)
    const stats = await res.json<{ viewCount: number; maxViews?: number }>()
    expect(stats.viewCount).toBe(1)
    expect(stats.maxViews).toBe(5)

    expect((await run(req(`/v1/share/${code}/stats`))).status).toBe(401)
  })
})

describe("delete", () => {
  it("removes a share (204) and then reads 404", async () => {
    const code = await create({})
    const del = await run(req(`/v1/share/${code}`, authed("DELETE")))
    expect(del.status).toBe(204)
    expect((await run(req(`/v1/share/${code}`))).status).toBe(404)
  })

  it("rejects delete without a bearer", async () => {
    const code = await create({})
    expect((await run(req(`/v1/share/${code}`, { method: "DELETE" }))).status).toBe(401)
  })
})

describe("cors + size guards", () => {
  it("answers preflight", async () => {
    const res = await run(req("/v1/share", { method: "OPTIONS" }))
    expect(res.status).toBe(204)
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST")
  })

  it("rejects an oversized declared body", async () => {
    const res = await run(
      req("/v1/share", {
        method: "POST",
        headers: { Authorization: `Bearer ${SECRET}`, "Content-Length": String(20 * 1024 * 1024) },
        body: JSON.stringify({ envelope: ENVELOPE }),
      })
    )
    expect(res.status).toBe(413)
  })

  // The Worker is a pure /v1 API; the viewer lives on Cloudflare Pages.
  it("404s a non-/v1 path instead of serving a viewer SPA", async () => {
    const res = await run(req("/share/view?c=abc"))
    expect(res.status).toBe(404)
  })
})
