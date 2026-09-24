/**
 * @jest-environment node
 */
import {
  detectDesktop,
  pushHandoff,
  DEV_TOKEN_HEADER,
  HANDOFF_PATH,
  HEALTH_PATH,
  type HandoffClientDeps,
} from "./client"
import { endpointFilePath } from "./endpoint"
import { createServer } from "node:http"

const ENDPOINT = { baseUrl: "http://127.0.0.1:7891", devToken: "tok123" }
const EP_FILE = endpointFilePath("linux", { XDG_CONFIG_HOME: "/cfg" }, "/home/u")

function depsWith(fetchImpl: jest.Mock, endpointJson: string | null): HandoffClientDeps {
  return {
    platform: "linux",
    env: { XDG_CONFIG_HOME: "/cfg" },
    homedir: "/home/u",
    readFile: (p) => (p === EP_FILE ? endpointJson : null),
    fetch: fetchImpl as unknown as typeof fetch,
  }
}

describe("detectDesktop", () => {
  it("returns the endpoint when the file exists and health is ok", async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true })
    const ep = await detectDesktop(depsWith(fetchMock, JSON.stringify(ENDPOINT)))
    expect(ep).toEqual(ENDPOINT)
    expect(fetchMock).toHaveBeenCalledWith(
      `${ENDPOINT.baseUrl}${HEALTH_PATH}`,
      expect.objectContaining({ headers: { [DEV_TOKEN_HEADER]: "tok123" } })
    )
  })

  it("returns null when no endpoint file exists", async () => {
    const fetchMock = jest.fn()
    expect(await detectDesktop(depsWith(fetchMock, null))).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("returns null when health responds non-ok (stale file)", async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: false })
    expect(await detectDesktop(depsWith(fetchMock, JSON.stringify(ENDPOINT)))).toBeNull()
  })

  it("returns null when health throws (desktop gone)", async () => {
    const fetchMock = jest.fn().mockRejectedValue(new Error("ECONNREFUSED"))
    expect(await detectDesktop(depsWith(fetchMock, JSON.stringify(ENDPOINT)))).toBeNull()
  })

  it("bounds health discovery when a desktop accepts but never responds", async () => {
    const fetchMock = jest.fn(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal.reason), { once: true })
        })
    )
    const result = detectDesktop({
      ...depsWith(fetchMock, JSON.stringify(ENDPOINT)),
      healthTimeoutMs: 10,
    })
    await expect(result).resolves.toBeNull()
  })
})

describe("pushHandoff", () => {
  it("POSTs the payload with the dev token and resolves on 2xx", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { sessionId: "actual-id", persisted: true } }),
    })
    const res = await pushHandoff(
      ENDPOINT,
      {
        sessionId: "s_1",
        title: "T",
        messages: [{ role: "user", content: "hi" }],
        meta: { provider: "anthropic" },
      },
      { fetch: fetchMock as unknown as typeof fetch }
    )
    expect(res).toEqual({ ok: true, sessionId: "actual-id" })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${ENDPOINT.baseUrl}${HANDOFF_PATH}`)
    expect(init.method).toBe("POST")
    expect(init.headers[DEV_TOKEN_HEADER]).toBe("tok123")
    expect(JSON.parse(init.body)).toMatchObject({ sessionId: "s_1", title: "T" })
  })

  it("rejects an old best-effort acknowledgement", async () => {
    await expect(
      pushHandoff(
        ENDPOINT,
        { sessionId: "s", messages: [] },
        {
          fetch: jest
            .fn()
            .mockResolvedValue({ ok: true, json: async () => ({ ok: true, sessionId: "s" }) }),
        }
      )
    ).rejects.toThrow("did not confirm persisted import")
  })

  it("throws on a non-2xx response", async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: false, status: 401 })
    await expect(
      pushHandoff(
        ENDPOINT,
        { sessionId: "s_1", messages: [] },
        {
          fetch: fetchMock as unknown as typeof fetch,
        }
      )
    ).rejects.toThrow(/HTTP 401/)
  })

  it("preserves a renderer persistence failure in the error", async () => {
    await expect(
      pushHandoff(
        ENDPOINT,
        { sessionId: "s", messages: [] },
        {
          fetch: jest.fn().mockResolvedValue({
            ok: false,
            status: 502,
            json: async () => ({
              ok: false,
              error: "renderer request timed out: session_handoff",
            }),
          }),
        }
      )
    ).rejects.toThrow("renderer request timed out: session_handoff")
  })

  it.each([12, {}, "   "])("rejects malformed persisted target id %p", async (sessionId) => {
    await expect(
      pushHandoff(
        ENDPOINT,
        { sessionId: "s", messages: [] },
        {
          fetch: jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ ok: true, result: { sessionId, persisted: true } }),
          }),
        }
      )
    ).rejects.toThrow("did not confirm persisted import")
  })

  it("reports an uncertain timeout without automatically reposting the snapshot", async () => {
    const fetchMock = jest.fn(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal.reason), { once: true })
        })
    )
    await expect(
      pushHandoff(
        ENDPOINT,
        { sessionId: "s", messages: [] },
        {
          fetch: fetchMock as unknown as typeof fetch,
          requestTimeoutMs: 10,
        }
      )
    ).rejects.toThrow("Retry the same snapshot")
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("times out a real loopback response that sends headers but stalls its acknowledgement body", async () => {
    let requests = 0
    const server = createServer((_req, res) => {
      requests += 1
      res.writeHead(200, { "Content-Type": "application/json" })
      res.write('{"ok":true,')
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("missing loopback address")
      await expect(
        pushHandoff(
          { ...ENDPOINT, baseUrl: `http://127.0.0.1:${address.port}` },
          {
            sessionId: "timeout-regression",
            messages: [],
          },
          { requestTimeoutMs: 200 }
        )
      ).rejects.toThrow("Retry the same snapshot")
      expect(requests).toBe(1)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  })
})
