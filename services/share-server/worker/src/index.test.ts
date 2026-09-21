import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
  runInDurableObject,
  runDurableObjectAlarm,
  evictDurableObject,
} from "cloudflare:test"
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

/** Owner-only request carrying the per-share `X-Owner-Token`. */
function owner(method: string, ownerToken: string): RequestInit {
  return { method, headers: { "X-Owner-Token": ownerToken } }
}

async function create(
  body: Record<string, unknown>
): Promise<{ code: string; ownerToken: string }> {
  const res = await run(req("/v1/share", authed("POST", { envelope: ENVELOPE, ...body })))
  expect(res.status).toBe(201)
  const parsed = await res.json<{ code: string; ownerToken: string }>()
  expect(typeof parsed.ownerToken).toBe("string")
  expect(parsed.ownerToken.length).toBeGreaterThanOrEqual(32)
  return parsed
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
    const { code } = await create({})
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
    const { code } = await create({ maxViews: 2 })
    expect((await run(req(`/v1/share/${code}`))).status).toBe(200)
    expect((await run(req(`/v1/share/${code}`))).status).toBe(200)
    expect((await run(req(`/v1/share/${code}`))).status).toBe(404)
  })

  it("burns after the first read", async () => {
    const { code } = await create({ burnAfterRead: true })
    expect((await run(req(`/v1/share/${code}`))).status).toBe(200)
    expect((await run(req(`/v1/share/${code}`))).status).toBe(404)
  })
})

describe("stats", () => {
  it("reports view count for the owner token and 401 without it", async () => {
    const { code, ownerToken } = await create({ maxViews: 5 })
    await run(req(`/v1/share/${code}`))
    const res = await run(req(`/v1/share/${code}/stats`, owner("GET", ownerToken)))
    expect(res.status).toBe(200)
    const stats = await res.json<{ viewCount: number; maxViews?: number }>()
    expect(stats.viewCount).toBe(1)
    expect(stats.maxViews).toBe(5)

    // No credential → 401.
    expect((await run(req(`/v1/share/${code}/stats`))).status).toBe(401)
    // Wrong owner token → 401.
    expect(
      (await run(req(`/v1/share/${code}/stats`, owner("GET", "wrong-owner-token-aaaa")))).status
    ).toBe(401)
  })

  it("does NOT authorize stats with only the global upload secret (tenant isolation)", async () => {
    const { code } = await create({ maxViews: 5 })
    // The shared upload secret must not grant access to another tenant's share.
    expect((await run(req(`/v1/share/${code}/stats`, authed("GET")))).status).toBe(401)
  })

  it("returns 404 for expired shares while their KV metadata still exists", async () => {
    const { code, ownerToken } = await create({ ttlSeconds: 0.001 })
    await new Promise((resolve) => setTimeout(resolve, 20))

    const res = await run(req(`/v1/share/${code}/stats`, owner("GET", ownerToken)))

    expect(res.status).toBe(404)
  })
})

describe("delete", () => {
  it("removes a share with the owner token (204) and then reads 404", async () => {
    const { code, ownerToken } = await create({})
    const del = await run(req(`/v1/share/${code}`, owner("DELETE", ownerToken)))
    expect(del.status).toBe(204)
    expect((await run(req(`/v1/share/${code}`))).status).toBe(404)
  })

  it("rejects delete without a credential", async () => {
    const { code } = await create({})
    expect((await run(req(`/v1/share/${code}`, { method: "DELETE" }))).status).toBe(401)
  })

  it("rejects delete with only the global upload secret (tenant isolation)", async () => {
    const { code } = await create({})
    expect((await run(req(`/v1/share/${code}`, authed("DELETE")))).status).toBe(401)
  })

  it("returns 204 idempotently for an unknown code without leaking existence", async () => {
    expect((await run(req(`/v1/share/does-not-exist-code`, { method: "DELETE" }))).status).toBe(204)
  })

  it("returns 204 for expired shares without requiring owner proof", async () => {
    const { code } = await create({ ttlSeconds: 0.001 })
    await new Promise((resolve) => setTimeout(resolve, 20))

    const res = await run(req(`/v1/share/${code}`, { method: "DELETE" }))

    expect(res.status).toBe(204)
  })
})

describe("renew", () => {
  function patch(body: unknown, ownerToken?: string): RequestInit {
    return {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        ...(ownerToken ? { "X-Owner-Token": ownerToken } : {}),
      },
      body: JSON.stringify(body),
    }
  }

  it("extends the expiry with the owner token", async () => {
    const { code, ownerToken } = await create({ ttlSeconds: 60 })
    const before = await run(req(`/v1/share/${code}/stats`, owner("GET", ownerToken)))
    const beforeExpiry = (await before.json<{ expiresAt: number }>()).expiresAt

    const res = await run(req(`/v1/share/${code}`, patch({ ttlSeconds: 3600 }, ownerToken)))
    expect(res.status).toBe(200)
    const { expiresAt } = await res.json<{ expiresAt: number }>()
    expect(expiresAt).toBeGreaterThan(beforeExpiry)

    const after = await run(req(`/v1/share/${code}/stats`, owner("GET", ownerToken)))
    expect((await after.json<{ expiresAt: number }>()).expiresAt).toBe(expiresAt)
  })

  it("rejects renew without the owner token", async () => {
    const { code } = await create({ ttlSeconds: 60 })
    expect((await run(req(`/v1/share/${code}`, patch({ ttlSeconds: 3600 })))).status).toBe(401)
  })

  it("400s when ttlSeconds is missing", async () => {
    const { code, ownerToken } = await create({ ttlSeconds: 60 })
    expect((await run(req(`/v1/share/${code}`, patch({}, ownerToken)))).status).toBe(400)
  })

  it.each([null, [], "invalid", 0, { ttlSeconds: 0 }, { ttlSeconds: -1 }, { ttlSeconds: "60" }])(
    "rejects invalid renewal body %j",
    async (body) => {
      const { code, ownerToken } = await create({ ttlSeconds: 60 })
      const response = await run(req(`/v1/share/${code}`, patch(body, ownerToken)))
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: "ttlSeconds required" })
    }
  )

  it("404s for an unknown code", async () => {
    expect((await run(req(`/v1/share/unknown-code`, patch({ ttlSeconds: 3600 })))).status).toBe(404)
  })
})

describe("cors + size guards", () => {
  it("answers preflight", async () => {
    const res = await run(req("/v1/share", { method: "OPTIONS" }))
    expect(res.status).toBe(204)
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST")
  })

  it("allows owner-token lifecycle requests in preflight", async () => {
    const res = await run(
      req("/v1/share", {
        method: "OPTIONS",
        headers: {
          "Access-Control-Request-Method": "DELETE",
          "Access-Control-Request-Headers": "X-Owner-Token",
        },
      })
    )

    expect(res.status).toBe(204)
    const allowHeaders = res.headers
      .get("Access-Control-Allow-Headers")
      ?.split(",")
      .map((header) => header.trim().toLowerCase())
    expect(allowHeaders).toContain("x-owner-token")
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

// ---------------------------------------------------------------------------
// ADR-0149 §8 — the org-scoped plane
// ---------------------------------------------------------------------------

const GRANT_KEY = "0123456789abcdef0123456789abcdef"

/** Mint a grant this Worker will accept. The Worker only ever verifies one. */
async function grantFor(orgId: string, userId = "usr_ada"): Promise<string> {
  const expiresAt = Math.floor(Date.now() / 1000) + 300
  const claims = JSON.stringify({ userId, orgId, expiresAt })
  const payload = base64Url(new TextEncoder().encode(claims))
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(GRANT_KEY),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))
  return `${payload}.${base64Url(new Uint8Array(signature))}`
}

function base64Url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
}

function granted(method: string, grant: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { Authorization: `Bearer ${grant}`, "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }
}

describe("org-scoped shares", () => {
  it("attributes a share created with a grant, and lists it for that org", async () => {
    const grant = await grantFor("org_acme")
    const created = await run(req("/v1/share", granted("POST", grant, { envelope: ENVELOPE })))
    expect(created.status).toBe(201)
    const { code } = await created.json<{ code: string }>()

    const listed = await run(req("/v1/orgs/org_acme/shares", granted("GET", grant)))
    expect(listed.status).toBe(200)
    const body = await listed.json<{ shares: Record<string, unknown>[] }>()
    const row = body.shares.find((share) => share.code === code)
    expect(row).toBeDefined()
    expect(row?.creatorUserId).toBe("usr_ada")
    // A listing is for deciding what to revoke; handing back the per-share
    // secret would turn a read into a grant.
    expect(row?.ownerToken).toBeUndefined()
  })

  it("does not list a share created with the legacy secret", async () => {
    const { code } = await create({})
    const grant = await grantFor("org_legacyless")
    const listed = await run(req("/v1/orgs/org_legacyless/shares", granted("GET", grant)))
    expect(listed.status).toBe(200)
    const body = await listed.json<{ shares: { code: string }[] }>()
    expect(body.shares.some((share) => share.code === code)).toBe(false)
  })

  it("refuses a grant for a different org exactly like no grant at all", async () => {
    const other = await grantFor("org_other")
    expect((await run(req("/v1/orgs/org_acme/shares", granted("GET", other)))).status).toBe(401)
    expect((await run(req("/v1/orgs/org_acme/shares", { method: "GET" }))).status).toBe(401)
  })

  it("never honours the legacy upload secret on the org plane", async () => {
    // One global bearer says nothing about which org is asking; accepting it
    // would let any holder list and delete every tenant's links.
    expect((await run(req("/v1/orgs/org_acme/shares", authed("GET")))).status).toBe(401)
    expect((await run(req("/v1/orgs/org_acme/shares/abcdefgh", authed("DELETE")))).status).toBe(401)
  })

  it("lets an org revoke its own share without the owner token", async () => {
    const grant = await grantFor("org_revoke")
    const created = await run(req("/v1/share", granted("POST", grant, { envelope: ENVELOPE })))
    const { code } = await created.json<{ code: string }>()

    const deleted = await run(req(`/v1/orgs/org_revoke/shares/${code}`, granted("DELETE", grant)))
    expect(deleted.status).toBe(200)
    expect((await run(req(`/v1/share/${code}`, { method: "GET" }))).status).toBe(404)
  })

  it("answers 404 for a code in another org, so it is not an existence oracle", async () => {
    const acme = await grantFor("org_acme2")
    const other = await grantFor("org_other2")
    const created = await run(req("/v1/share", granted("POST", acme, { envelope: ENVELOPE })))
    const { code } = await created.json<{ code: string }>()

    const refused = await run(req(`/v1/orgs/org_other2/shares/${code}`, granted("DELETE", other)))
    expect(refused.status).toBe(404)
    // And the share survived.
    expect((await run(req(`/v1/share/${code}`, { method: "GET" }))).status).toBe(200)
  })

  it("refuses an expired grant", async () => {
    const expiresAt = Math.floor(Date.now() / 1000) - 10
    const claims = JSON.stringify({ userId: "usr_ada", orgId: "org_acme", expiresAt })
    const payload = base64Url(new TextEncoder().encode(claims))
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(GRANT_KEY),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    )
    const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))
    const stale = `${payload}.${base64Url(new Uint8Array(signature))}`
    expect((await run(req("/v1/orgs/org_acme/shares", granted("GET", stale)))).status).toBe(401)
  })

  it("refuses a grant signed with the wrong key", async () => {
    const claims = JSON.stringify({
      userId: "usr_ada",
      orgId: "org_acme",
      expiresAt: Math.floor(Date.now() / 1000) + 300,
    })
    const payload = base64Url(new TextEncoder().encode(claims))
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("ffffffffffffffffffffffffffffffff"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    )
    const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))
    const forged = `${payload}.${base64Url(new Uint8Array(signature))}`
    expect((await run(req("/v1/orgs/org_acme/shares", granted("GET", forged)))).status).toBe(401)
  })
})

describe("durable lifecycle authority", () => {
  function stub(code: string) {
    const namespace = (env as Env).SHARE_LIFECYCLE
    return namespace.get(namespace.idFromName(code))
  }

  it("serves at most the allowed number of concurrent views", async () => {
    const { code } = await create({ maxViews: 3 })
    const responses = await Promise.all(
      Array.from({ length: 12 }, () => run(req(`/v1/share/${code}`)))
    )
    expect(responses.filter((response) => response.status === 200)).toHaveLength(3)
    expect(responses.filter((response) => response.status === 404)).toHaveLength(9)
  })

  it("preserves concurrent reads through renewal and eviction", async () => {
    const { code, ownerToken } = await create({ ttlSeconds: 60 })
    const results = await Promise.all([
      ...Array.from({ length: 8 }, () => run(req(`/v1/share/${code}`))),
      run(
        req(`/v1/share/${code}`, {
          ...owner("PATCH", ownerToken),
          body: JSON.stringify({ ttlSeconds: 3600 }),
        })
      ),
    ])
    expect(results.every((response) => response.status === 200)).toBe(true)
    const renewed = await results[8].json<{ expiresAt: number }>()
    await Promise.all(results.slice(0, 8).map((response) => response.arrayBuffer()))
    await evictDurableObject(stub(code))
    const response = await run(req(`/v1/share/${code}/stats`, owner("GET", ownerToken)))
    expect(await response.json()).toMatchObject({ viewCount: 8, expiresAt: renewed.expiresAt })
  })

  it("never resurrects a burned share when renewal runs concurrently", async () => {
    const { code, ownerToken } = await create({ burnAfterRead: true })
    const responses = await Promise.all([
      run(req(`/v1/share/${code}`)),
      run(
        req(`/v1/share/${code}`, {
          ...owner("PATCH", ownerToken),
          body: JSON.stringify({ ttlSeconds: 3600 }),
        })
      ),
    ])
    expect(responses[0].status).toBe(200)
    expect([200, 404]).toContain(responses[1].status)
    expect((await run(req(`/v1/share/${code}`))).status).toBe(404)
  })

  it("imports legacy links once and retains deletion tombstones across eviction", async () => {
    const code = `legacy-${crypto.randomUUID()}`
    const meta = {
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      burnAfterRead: false,
      viewCount: 4,
      revoked: false,
      ownerToken: "legacy-owner",
    }
    await (env as Env).SHARE_BUCKET.put(`share/${code}`, JSON.stringify(ENVELOPE))
    await (env as Env).SHARE_KV.put(`meta:${code}`, JSON.stringify(meta))
    const read = await run(req(`/v1/share/${code}`))
    expect(read.status).toBe(200)
    await read.arrayBuffer()
    const stats = await run(req(`/v1/share/${code}/stats`, owner("GET", meta.ownerToken)))
    expect(await stats.json()).toMatchObject({ viewCount: 5 })
    expect((await run(req(`/v1/share/${code}`, owner("DELETE", meta.ownerToken)))).status).toBe(204)
    // Simulate stale legacy KV/R2 values still visible at another edge.
    await (env as Env).SHARE_KV.put(`meta:${code}`, JSON.stringify(meta))
    await (env as Env).SHARE_BUCKET.put(`share/${code}`, JSON.stringify(ENVELOPE))
    await evictDurableObject(stub(code))
    expect((await run(req(`/v1/share/${code}`))).status).toBe(404)
    expect(
      (
        await run(
          req(`/v1/share/${code}`, {
            ...owner("PATCH", meta.ownerToken),
            body: '{"ttlSeconds":60}',
          })
        )
      ).status
    ).toBe(404)
  })

  it("expiry alarms use current metadata and clean up expired bodies", async () => {
    const { code, ownerToken } = await create({ ttlSeconds: 60 })
    expect(await runDurableObjectAlarm(stub(code))).toBe(true)
    expect((await run(req(`/v1/share/${code}/stats`, owner("GET", ownerToken)))).status).toBe(200)
    await runInDurableObject(stub(code), async (_instance, state) => {
      const meta = await state.storage.get<Record<string, unknown>>("meta")
      await state.storage.put("meta", { ...meta, expiresAt: Date.now() - 1 })
    })
    expect(await runDurableObjectAlarm(stub(code))).toBe(true)
    expect(await (env as Env).SHARE_BUCKET.get(`share/${code}`)).toBeNull()
    expect((await run(req(`/v1/share/${code}`))).status).toBe(404)
  })

  it("does not permanently cache an absent legacy KV record", async () => {
    const code = `late-legacy-${crypto.randomUUID()}`
    const missing = await run(req(`/v1/share/${code}`))
    expect(missing.status).toBe(404)
    await missing.arrayBuffer()
    await (env as Env).SHARE_KV.put(
      `meta:${code}`,
      JSON.stringify({
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        burnAfterRead: false,
        viewCount: 0,
        revoked: false,
      })
    )
    await (env as Env).SHARE_BUCKET.put(`share/${code}`, JSON.stringify(ENVELOPE))
    expect((await run(req(`/v1/share/${code}`))).status).toBe(200)
  })

  it("resumes tombstoned external cleanup after eviction", async () => {
    const { code } = await create({})
    await runInDurableObject(stub(code), async (_instance, state) => {
      await state.storage.put({ meta: null, cleanup: { code } })
    })
    await evictDurableObject(stub(code))
    expect(await runDurableObjectAlarm(stub(code))).toBe(true)
    expect(await (env as Env).SHARE_BUCKET.get(`share/${code}`)).toBeNull()
    expect((await run(req(`/v1/share/${code}`))).status).toBe(404)
  })

  it("recovers cleanup after creation fails after writing its R2 body", async () => {
    const code = `failed-create-${crypto.randomUUID()}`
    await runInDurableObject(stub(code), async (instance, state) => {
      // Inject the failure at the external storage boundary after a real put.
      const internal = instance as unknown as { env: Env }
      const original = internal.env
      internal.env = {
        ...original,
        SHARE_BUCKET: new Proxy(original.SHARE_BUCKET, {
          get(target, key) {
            if (key === "put")
              return async (...args: Parameters<R2Bucket["put"]>) => {
                await target.put(...args)
                throw new Error("injected failure after R2 write")
              }
            const value = Reflect.get(target, key)
            return typeof value === "function" ? value.bind(target) : value
          },
        }),
      }
      try {
        await expect(
          instance.fetch(
            new Request(
              `https://lifecycle.internal/${code}?action=create`,
              authed("POST", { envelope: ENVELOPE })
            )
          )
        ).rejects.toThrow("injected failure after R2 write")
      } finally {
        internal.env = original
      }
      expect(await state.storage.get("meta")).toBeNull()
      expect(await state.storage.get("cleanup")).toMatchObject({ code })
      expect(await state.storage.getAlarm()).not.toBeNull()
    })
    expect(await (env as Env).SHARE_BUCKET.head(`share/${code}`)).not.toBeNull()
    await evictDurableObject(stub(code))
    expect(await runDurableObjectAlarm(stub(code))).toBe(true)
    expect(await (env as Env).SHARE_BUCKET.get(`share/${code}`)).toBeNull()
    expect((await run(req(`/v1/share/${code}`))).status).toBe(404)
  })

  it("clears creation cleanup intent only when live metadata commits", async () => {
    const { code } = await create({})
    await runInDurableObject(stub(code), async (_instance, state) => {
      expect(await state.storage.get("cleanup")).toBeUndefined()
      expect(await state.storage.get("meta")).toMatchObject({ revoked: false, viewCount: 0 })
    })
    expect(await runDurableObjectAlarm(stub(code))).toBe(true)
    expect((await run(req(`/v1/share/${code}`))).status).toBe(200)
  })

  it("fails closed when the lifecycle binding is missing", async () => {
    const broken = { ...env, SHARE_LIFECYCLE: undefined } as unknown as Env
    const response = await worker.fetch(req("/v1/share/missing"), broken, createExecutionContext())
    expect(response.status).toBe(503)
  })
})
