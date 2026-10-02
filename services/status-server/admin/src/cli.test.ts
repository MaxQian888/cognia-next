import { describe, expect, it, vi } from "vitest"

import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, run, type CliDeps } from "./cli"

const JWT = "eyJhbGciOiJSUzI1NiJ9.eyJlbWFpbCI6Im9wQGV4YW1wbGUuY29tIn0.c2ln"

interface Harness {
  deps: CliDeps
  out: string[]
  err: string[]
  fetch: ReturnType<typeof vi.fn>
}

function harness(
  responses: Array<{ status: number; body: unknown; headers?: Record<string, string> }> = [],
  opts: { confirm?: boolean; env?: Record<string, string | undefined> } = {}
): Harness {
  const out: string[] = []
  const err: string[] = []
  const queue = [...responses]
  const fetch = vi.fn(async () => {
    const next = queue.shift()
    if (!next) throw new Error("unexpected request")
    return new Response(typeof next.body === "string" ? next.body : JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json", ...next.headers },
    })
  })
  const deps: CliDeps = {
    env: opts.env ?? { CF_ACCESS_TOKEN: JWT },
    fetch,
    run: vi.fn().mockRejectedValue(new Error("no cloudflared")),
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    confirm: vi.fn().mockResolvedValue(opts.confirm ?? false),
    newOperationId: () => "op-test-0001",
  }
  return { deps, out, err, fetch }
}

const createArgs = [
  "incident",
  "create",
  "--title-en",
  "Relay degraded",
  "--message-en",
  "Investigating",
  "--impact",
  "partial_outage",
  "--components",
  "relayData",
]

describe("operator CLI", () => {
  it("previews a write and sends nothing without confirmation", async () => {
    const h = harness()
    expect(await run(createArgs, h.deps)).toBe(EXIT_FAILED)
    expect(h.out[0]).toBe("Operation preview")
    expect(h.out).toContain("  POST https://status.cognia.cn/api/status/v1/admin/incidents")
    expect(h.out).toContain("  operationId: op-test-0001")
    expect(h.out.join("\n")).toContain('"impact": "partial_outage"')
    expect(h.err.join("\n")).toContain("nothing was sent")
    expect(h.fetch).not.toHaveBeenCalled()
  })

  it("sends after an interactive yes with the Access token header and prints safe IDs", async () => {
    const h = harness(
      [
        {
          status: 201,
          body: {
            schemaVersion: 1,
            incident: {
              id: "inc_1",
              revision: 1,
              state: "investigating",
              impact: "partial_outage",
              componentIds: ["relayData"],
              source: "manual",
              startedAt: "2026-10-02T10:00:00.000Z",
              title: { en: "Relay degraded" },
            },
          },
        },
      ],
      { confirm: true }
    )
    expect(
      await run([...createArgs, "--api", "https://status.example/api/status/v1/"], h.deps)
    ).toBe(EXIT_OK)
    const [url, init] = h.fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("https://status.example/api/status/v1/admin/incidents")
    expect(init.method).toBe("POST")
    const headers = init.headers as Record<string, string>
    expect(headers["cf-access-token"]).toBe(JWT)
    expect(headers["cf-access-jwt-assertion"]).toBeUndefined()
    expect(JSON.parse(String(init.body))).toMatchObject({
      operationId: "op-test-0001",
      impact: "partial_outage",
    })
    expect(h.out).toContain("OK (HTTP 201)")
    expect(h.out.some((line) => line.startsWith("inc_1  rev 1  investigating"))).toBe(true)
    // The token is never echoed.
    expect([...h.out, ...h.err].join("\n")).not.toContain(JWT)
  })

  it("sends with --yes and reports an idempotent replay", async () => {
    const h = harness([
      {
        status: 201,
        body: { incident: { id: "inc_1", revision: 1 } },
        headers: { "x-idempotent-replay": "true" },
      },
    ])
    expect(await run([...createArgs, "--yes", "--operation-id", "op-earlier-0001"], h.deps)).toBe(
      EXIT_OK
    )
    expect(h.deps.confirm).not.toHaveBeenCalled()
    expect(h.out.find((line) => line.startsWith("OK"))).toContain("replayed")
    expect(h.out).toContain("operationId: op-earlier-0001")
  })

  it("shows the current revision on a 409", async () => {
    const h = harness([
      { status: 409, body: { code: "revision_conflict", requestId: "req-1", currentRevision: 5 } },
    ])
    const code = await run(
      ["incident", "update", "inc_1", "--revision", "3", "--message-en", "x", "--yes"],
      h.deps
    )
    expect(code).toBe(EXIT_FAILED)
    expect(h.err).toEqual([
      "Error 409: revision_conflict",
      "requestId: req-1",
      expect.stringContaining("currentRevision: 5"),
    ])
  })

  it("renders reads and supports --json", async () => {
    const page = {
      schemaVersion: 1,
      incidents: [
        {
          id: "inc_2",
          revision: 2,
          state: "resolved",
          impact: "major_outage",
          componentIds: ["signalingHttp"],
          source: "automated",
          startedAt: "2026-10-02T09:00:00.000Z",
          title: { en: "Outage" },
          pinned: false,
        },
      ],
      nextCursor: "abc",
    }
    const h = harness([
      { status: 200, body: page },
      { status: 200, body: page },
    ])
    expect(await run(["incident", "list", "--limit", "1"], h.deps)).toBe(EXIT_OK)
    expect((h.fetch.mock.calls[0] as unknown as [string])[0]).toBe(
      "https://status.cognia.cn/api/status/v1/admin/incidents?limit=1"
    )
    expect(h.out[0]).toContain("inc_2  rev 2  resolved  major_outage")
    expect(h.out[1]).toBe("next page: --cursor abc")
    expect(await run(["incident", "list", "--json"], h.deps)).toBe(EXIT_OK)
    expect(JSON.parse(h.out.slice(2).join("\n"))).toEqual(page)
  })

  it("uses cloudflared when no token is in the environment, and fails clearly without one", async () => {
    const h = harness([{ status: 200, body: { probes: [] } }], {
      env: { STATUS_API_BASE: "https://status.example/api/status/v1" },
    })
    h.deps.run = vi.fn().mockResolvedValue({ code: 0, stdout: JWT, stderr: "" })
    expect(await run(["probe", "list"], h.deps)).toBe(EXIT_OK)
    expect(h.deps.run).toHaveBeenCalledWith("cloudflared", [
      "access",
      "token",
      "-app=https://status.example",
    ])

    const none = harness([], { env: {} })
    expect(await run(["probe", "list"], none.deps)).toBe(EXIT_FAILED)
    expect(none.err[0]).toContain("CF_ACCESS_TOKEN")
    expect(none.fetch).not.toHaveBeenCalled()
  })

  it("handles usage errors, bad API bases, HTML login pages and network failures", async () => {
    const usage = harness()
    expect(await run(["incident", "frobnicate"], usage.deps)).toBe(EXIT_USAGE)
    expect(await run([], usage.deps)).toBe(EXIT_USAGE)
    expect(await run(["probe", "list", "--api", "http://status.example/api"], usage.deps)).toBe(
      EXIT_USAGE
    )
    expect(await run(["--help"], usage.deps)).toBe(EXIT_OK)

    const html = harness([{ status: 200, body: "<html>Sign in</html>" }])
    expect(await run(["probe", "list"], html.deps)).toBe(EXIT_FAILED)
    expect(html.err[0]).toContain("non-JSON")

    const network = harness()
    network.fetch.mockRejectedValueOnce(new Error("ECONNRESET"))
    expect(await run([...createArgs, "--yes"], network.deps)).toBe(EXIT_FAILED)
    expect(network.err.join("\n")).toContain("--operation-id op-test-0001")
  })
})
