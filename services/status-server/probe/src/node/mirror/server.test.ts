import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises"
import type { Server } from "node:http"
import type { AddressInfo } from "node:net"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { createStatusFixture } from "../../../../../../lib/status/fixtures"
import { memoryLogger } from "../logger"
import { MIRROR_RUNTIME_CONTENT } from "./html"
import { createMirrorServer, MIRROR_CSP, resolveStaticPath } from "./server"
import { SYNC_STATE_FILE } from "./sync"

const PAGE_HTML =
  '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><script src="/_next/static/chunks/app.js"></script></body></html>'

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve)))
  )
})

async function site(layout: "dir" | "file" = "dir") {
  const base = await mkdtemp(path.join(os.tmpdir(), "mirror-site-"))
  const release = path.join(base, "releases", "v1")
  await mkdir(path.join(release, "_next", "static", "chunks"), { recursive: true })
  if (layout === "dir") {
    await mkdir(path.join(release, "status"), { recursive: true })
    await writeFile(path.join(release, "status", "index.html"), PAGE_HTML)
  } else {
    await writeFile(path.join(release, "status.html"), PAGE_HTML)
  }
  await writeFile(path.join(release, "_next", "static", "chunks", "app.js"), "console.log(1)")
  await writeFile(path.join(release, "favicon.ico"), "ico")
  await writeFile(path.join(release, ".env"), "SECRET=1")
  await writeFile(path.join(base, "outside.txt"), "outside the assets root")
  const current = path.join(base, "current")
  await symlink(release, current)
  const dataDir = path.join(base, "data")
  await mkdir(dataDir)
  return { base, release, current, dataDir }
}

async function serve(assetsDir: string, dataDir: string) {
  const server = createMirrorServer({ assetsDir, dataDir, logger: memoryLogger() })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  servers.push(server)
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return (pathname: string, init?: RequestInit) =>
    fetch(`${origin}${pathname}`, { redirect: "manual", ...init })
}

describe("mirror static site", () => {
  it("redirects / to /status/ and serves the page with mirror runtime meta and security headers", async () => {
    const s = await site()
    const get = await serve(s.current, s.dataDir)
    const root = await get("/")
    expect(root.status).toBe(302)
    expect(root.headers.get("location")).toBe("/status/")

    const page = await get("/status/")
    expect(page.status).toBe(200)
    expect(page.headers.get("content-type")).toContain("text/html")
    expect(page.headers.get("content-security-policy")).toBe(MIRROR_CSP)
    expect(page.headers.get("x-content-type-options")).toBe("nosniff")
    expect(page.headers.get("referrer-policy")).toBe("no-referrer")
    const html = await page.text()
    expect(html).toContain(
      `<meta name="cognia-status-runtime" content='${MIRROR_RUNTIME_CONTENT}'>`
    )
    expect((await get("/status")).status).toBe(308)
    expect(await (await get("/status/index.html")).text()).toContain('"mode":"mirror"')

    const chunk = await get("/_next/static/chunks/app.js")
    expect(chunk.status).toBe(200)
    expect(chunk.headers.get("content-type")).toContain("javascript")
    expect(chunk.headers.get("cache-control")).toContain("immutable")
  })

  it("supports the flat status.html export layout", async () => {
    const s = await site("file")
    const get = await serve(s.current, s.dataDir)
    for (const pathname of ["/status", "/status/", "/status.html"]) {
      const response = await get(pathname)
      expect(response.status, pathname).toBe(200)
      expect(await response.text()).toContain('"mode":"mirror"')
    }
  })

  it("picks up an atomic release swap without restart", async () => {
    const s = await site()
    const get = await serve(s.current, s.dataDir)
    const v2 = path.join(s.base, "releases", "v2")
    await mkdir(path.join(v2, "status"), { recursive: true })
    await writeFile(
      path.join(v2, "status", "index.html"),
      "<html><head></head><body>v2</body></html>"
    )
    const next = path.join(s.base, "current.next")
    await symlink(v2, next)
    await rename(next, s.current)
    expect(await (await get("/status/")).text()).toContain("v2")
  })

  it.each([
    "/../outside.txt",
    "/%2e%2e/outside.txt",
    "/_next/%2e%2e/%2e%2e/outside.txt",
    "/..%2foutside.txt",
    "/.env",
    "/%2eenv",
    "/status/%00",
    "/%E0%A4%A",
    "/nope.js",
  ])("refuses %s", async (pathname) => {
    const s = await site()
    const get = await serve(s.current, s.dataDir)
    const response = await get(pathname)
    expect([400, 404]).toContain(response.status)
    expect(await response.text()).not.toContain("outside the assets root")
  })

  it("refuses symlinks that point outside the release", async () => {
    const s = await site()
    await symlink(path.join(s.base, "outside.txt"), path.join(s.release, "leak.txt"))
    expect(await resolveStaticPath(s.release, "/leak.txt")).toBeNull()
    expect(await resolveStaticPath(s.release, "/favicon.ico")).toBe(
      path.join(await realpath(s.release), "favicon.ico")
    )
  })

  it("answers 503 while the assets directory is missing", async () => {
    const s = await site()
    await rm(s.current)
    const get = await serve(s.current, s.dataDir)
    expect((await get("/status/")).status).toBe(503)
  })
})

describe("mirror API", () => {
  it("serves the last validated snapshot per range, or a JSON 404 before the first sync", async () => {
    const s = await site()
    const get = await serve(s.current, s.dataDir)
    const missing = await get("/api/status/v1/snapshot?range=7d")
    expect(missing.status).toBe(404)
    const body = (await missing.json()) as { code: string; requestId: string }
    expect(body.code).toBe("unavailable")
    expect(body.requestId).toMatch(/[0-9a-f-]{36}/)

    const snapshot = JSON.stringify(createStatusFixture("operational", "7d"))
    await writeFile(path.join(s.dataDir, "snapshot-7d.json"), snapshot)
    const hit = await get("/api/status/v1/snapshot?range=7d")
    expect(hit.status).toBe(200)
    expect(hit.headers.get("content-type")).toContain("application/json")
    expect(await hit.text()).toBe(snapshot)
    expect((await get("/api/status/v1/snapshot?range=1y")).status).toBe(400)
  })

  it("reports mirror health from the sync state", async () => {
    const s = await site()
    const get = await serve(s.current, s.dataDir)
    expect(await (await get("/api/status/v1/healthz")).json()).toEqual({
      ok: true,
      mode: "mirror",
      lastSyncAt: null,
      lastSyncOk: null,
    })
    await writeFile(
      path.join(s.dataDir, SYNC_STATE_FILE),
      JSON.stringify({ lastSyncAt: "2026-10-02T10:00:00.000Z", lastSyncOk: false, resources: {} })
    )
    expect(await (await get("/api/status/v1/healthz")).json()).toEqual({
      ok: true,
      mode: "mirror",
      lastSyncAt: "2026-10-02T10:00:00.000Z",
      lastSyncOk: false,
    })
  })

  it("serves synced feeds with their content types", async () => {
    const s = await site()
    const get = await serve(s.current, s.dataDir)
    expect((await get("/api/status/v1/feed.atom")).status).toBe(404)
    await writeFile(path.join(s.dataDir, "feed.atom"), "<feed/>")
    const feed = await get("/api/status/v1/feed.atom")
    expect(feed.headers.get("content-type")).toContain("application/atom+xml")
    expect(await feed.text()).toBe("<feed/>")
  })

  it("has no incident API, no writes and JSON 404 for unknown API paths", async () => {
    const s = await site()
    const get = await serve(s.current, s.dataDir)
    for (const pathname of ["/api/status/v1/incidents", "/api/status/v1/incidents/inc_1"]) {
      const response = await get(pathname)
      expect(response.status).toBe(503)
      expect(((await response.json()) as { code: string }).code).toBe("unavailable")
    }
    for (const pathname of [
      "/api/status/v1/subscriptions",
      "/api/status/v1/admin/incidents",
      "/api/nope",
      "/api",
    ]) {
      const response = await get(pathname)
      expect(response.status, pathname).toBe(404)
      expect(response.headers.get("content-type")).toContain("application/json")
      expect(((await response.json()) as { code: string }).code).toBe("not_found")
    }
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
      for (const pathname of [
        "/api/status/v1/observations",
        "/api/status/v1/subscriptions",
        "/status/",
      ]) {
        const response = await get(pathname, {
          method,
          body: method === "OPTIONS" ? undefined : "{}",
        })
        expect(response.status, `${method} ${pathname}`).toBe(405)
        expect(response.headers.get("allow")).toBe("GET, HEAD")
        expect(((await response.json()) as { code: string }).code).toBe("method_not_allowed")
      }
    }
  })

  it("answers HEAD without a body", async () => {
    const s = await site()
    const get = await serve(s.current, s.dataDir)
    const head = await get("/status/", { method: "HEAD" })
    expect(head.status).toBe(200)
    expect(Number(head.headers.get("content-length"))).toBeGreaterThan(0)
    expect(await head.text()).toBe("")
  })
})
