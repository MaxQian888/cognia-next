import { WebDavClient } from "./client"
import { WebDavAuthError, WebDavNotFoundError, WebDavError } from "./errors"
import type { WebDavRequest, WebDavResponse, WebDavTransport } from "./types"

interface Canned {
  status: number
  body?: string
  headers?: Record<string, string>
}

class FakeTransport implements WebDavTransport {
  readonly requests: WebDavRequest[] = []
  private queue: Canned[]
  constructor(responses: Canned[]) {
    this.queue = [...responses]
  }
  async send(req: WebDavRequest): Promise<WebDavResponse> {
    this.requests.push(req)
    const next = this.queue.shift() ?? { status: 200, body: "" }
    return { status: next.status, headers: next.headers ?? {}, body: next.body ?? "" }
  }
}

const creds = { baseUrl: "https://dav.example.com/", username: "user", password: "pä$$" }

describe("WebDavClient", () => {
  it("sends Basic auth + encodes path segments", async () => {
    const t = new FakeTransport([{ status: 201 }])
    const client = new WebDavClient(creds, t)
    await client.putFile("/cognia backups/latest.enc.cbk", "data")

    const req = t.requests[0]
    expect(req.method).toBe("PUT")
    expect(req.url).toBe("https://dav.example.com/cognia%20backups/latest.enc.cbk")
    expect(req.headers?.Authorization).toMatch(/^Basic /)
    // UTF-8 basic auth round-trips through atob.
    const decoded = atob(req.headers!.Authorization.slice("Basic ".length))
    const bytes = Uint8Array.from(decoded, (c) => c.charCodeAt(0))
    expect(new TextDecoder().decode(bytes)).toBe("user:pä$$")
  })

  it("getFile returns body on 200 and throws NotFound on 404", async () => {
    const ok = new WebDavClient(creds, new FakeTransport([{ status: 200, body: "hello" }]))
    expect(await ok.getFile("/a.txt")).toBe("hello")

    const missing = new WebDavClient(creds, new FakeTransport([{ status: 404 }]))
    await expect(missing.getFile("/a.txt")).rejects.toBeInstanceOf(WebDavNotFoundError)
  })

  it("putFile maps 401 to an auth error", async () => {
    const client = new WebDavClient(creds, new FakeTransport([{ status: 401 }]))
    await expect(client.putFile("/a", "b")).rejects.toBeInstanceOf(WebDavAuthError)
  })

  it("ensureCollection tolerates 405 (already exists)", async () => {
    const client = new WebDavClient(creds, new FakeTransport([{ status: 405 }]))
    await expect(client.ensureCollection("/dir")).resolves.toBeUndefined()
  })

  it("ensureCollection throws on a real error", async () => {
    const client = new WebDavClient(creds, new FakeTransport([{ status: 500 }]))
    await expect(client.ensureCollection("/dir")).rejects.toBeInstanceOf(WebDavError)
  })

  it("propfindList parses entries from a 207 multistatus", async () => {
    const xml = `<multistatus xmlns="DAV:"><response><href>/d/x.cbk</href>
      <propstat><prop><getcontentlength>5</getcontentlength></prop></propstat>
      </response></multistatus>`
    const client = new WebDavClient(creds, new FakeTransport([{ status: 207, body: xml }]))
    const entries = await client.propfindList("/d")
    expect(entries).toHaveLength(1)
    expect(entries[0].name).toBe("x.cbk")
  })

  it("lastModified reads the single resource mtime, null on 404", async () => {
    const xml = `<multistatus xmlns="DAV:"><response><href>/d/latest.cbk</href>
      <propstat><prop><getlastmodified>Sat, 30 May 2026 12:30:00 GMT</getlastmodified></prop></propstat>
      </response></multistatus>`
    const client = new WebDavClient(creds, new FakeTransport([{ status: 207, body: xml }]))
    expect(await client.lastModified("/d/latest.cbk")).toBe(
      Date.parse("Sat, 30 May 2026 12:30:00 GMT")
    )

    const missing = new WebDavClient(creds, new FakeTransport([{ status: 404 }]))
    expect(await missing.lastModified("/d/latest.cbk")).toBeNull()
  })

  it("deleteFile treats 404 as success", async () => {
    const client = new WebDavClient(creds, new FakeTransport([{ status: 404 }]))
    await expect(client.deleteFile("/gone")).resolves.toBeUndefined()
  })
})
