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
})

describe("pushHandoff", () => {
  it("POSTs the payload with the dev token and resolves on 2xx", async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 })
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
    expect(res).toEqual({ ok: true, sessionId: "s_1" })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${ENDPOINT.baseUrl}${HANDOFF_PATH}`)
    expect(init.method).toBe("POST")
    expect(init.headers[DEV_TOKEN_HEADER]).toBe("tok123")
    expect(JSON.parse(init.body)).toMatchObject({ sessionId: "s_1", title: "T" })
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
})
