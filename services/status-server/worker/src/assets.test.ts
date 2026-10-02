import { describe, expect, it } from "vitest"

import { executionContext, testEnv } from "../test/helpers"
import { INERT_SERVICE_WORKER, serveStatusAsset, STATUS_CSP } from "./assets"
import type { Env } from "./env"
import worker from "./index"

function assetsEnv(files: Record<string, { body: string; type: string }>): Env {
  return {
    ...testEnv,
    ASSETS: {
      fetch: async (input: RequestInfo | URL) => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        const file = files[url.pathname]
        if (!file) return new Response("missing", { status: 404 })
        return new Response(file.body, { headers: { "content-type": file.type } })
      },
      connect: () => {
        throw new Error("unused")
      },
    } as unknown as Fetcher,
  }
}

const PAGE = {
  "/status/": {
    body: '<!doctype html><html><head><meta name="cognia-status-runtime" content="{&quot;mode&quot;:&quot;primary&quot;,&quot;apiBase&quot;:&quot;https://evil.example&quot;}"><link rel="manifest" href="/manifest.webmanifest"><link rel="icon" href="/favicon.ico?757f"><title>Status</title></head><body>ok</body></html>',
    type: "text/html; charset=utf-8",
  },
  "/_next/static/chunks/app.js": { body: "console.log(1)", type: "application/javascript" },
}

describe("static status assets", () => {
  it("redirects the root and the bare route to /status/", async () => {
    const env = assetsEnv(PAGE)
    const root = await serveStatusAsset(
      new Request("https://status.test/?x=1"),
      env,
      new URL("https://status.test/?x=1")
    )
    expect(root.status).toBe(302)
    expect(root.headers.get("location")).toBe("https://status.test/status/?x=1")
    const bare = await serveStatusAsset(
      new Request("https://status.test/status"),
      env,
      new URL("https://status.test/status")
    )
    expect(bare.status).toBe(301)
  })

  it("injects exactly one primary runtime meta and a strict CSP into HTML", async () => {
    const env = assetsEnv(PAGE)
    const url = new URL("https://status.test/status/?incident=inc_1")
    const response = await serveStatusAsset(new Request(url), env, url)
    const html = await response.text()
    expect(html.match(/cognia-status-runtime/g)).toHaveLength(1)
    expect(html).toContain(`content='{"mode":"primary","apiBase":"/api/status/v1"}'`)
    expect(html).not.toContain("evil.example")
    expect(html).not.toContain('rel="manifest"')
    expect(html).toContain('<link rel="icon" href="/favicon.ico?757f">')
    expect(response.headers.get("content-security-policy")).toBe(STATUS_CSP)
    expect(response.headers.get("cache-control")).toBe("no-cache")
    expect(response.headers.get("x-frame-options")).toBe("DENY")
  })

  it("serves other assets untouched with security headers and refuses writes", async () => {
    const env = assetsEnv(PAGE)
    const url = new URL("https://status.test/_next/static/chunks/app.js")
    const response = await serveStatusAsset(new Request(url), env, url)
    expect(await response.text()).toBe("console.log(1)")
    expect(response.headers.get("content-security-policy")).toBeNull()
    expect(response.headers.get("x-content-type-options")).toBe("nosniff")
    const post = await serveStatusAsset(new Request(url, { method: "POST" }), env, url)
    expect(post.status).toBe(405)
    const missingUrl = new URL("https://status.test/settings/")
    expect((await serveStatusAsset(new Request(missingUrl), env, missingUrl)).status).toBe(404)
  })

  it("serves an inert service worker instead of the app's precaching one", async () => {
    const url = new URL("https://status.test/sw.js")
    const response = await serveStatusAsset(new Request(url), assetsEnv(PAGE), url)
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("javascript")
    const body = await response.text()
    expect(body).toBe(INERT_SERVICE_WORKER)
    expect(body).not.toMatch(/addEventListener\("fetch"|caches\./)
  })

  it("routes non-API paths to assets through the Worker entrypoint", async () => {
    const ctx = executionContext()
    const response = await worker.fetch(
      new Request("https://status.test/status/"),
      assetsEnv(PAGE),
      ctx
    )
    expect(response.status).toBe(200)
    expect(await response.text()).toContain("cognia-status-runtime")
  })
})
