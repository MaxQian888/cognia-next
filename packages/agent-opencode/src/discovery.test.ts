import type { AgentFetch } from "@cognia/agent-contracts/host"

jest.mock(
  "@opencode/client/service",
  () => ({ Service: { discover: jest.fn(), headers: jest.fn() } }),
  { virtual: true }
)
import { Service } from "@opencode/client/service"
import { discoverOpenCodeV2InProcess, validateOpenCodeV2Discovery } from "./discovery"

describe("OpenCode V2 discovery validation", () => {
  it("keeps ephemeral string headers and normalizes the endpoint", () => {
    expect(
      validateOpenCodeV2Discovery({
        endpoint: "http://127.0.0.1:4096/",
        version: "2.0.0-beta.1",
        headers: {
          authorization: "Bearer ephemeral",
          "x-number": 1,
          "": "ignored",
        },
      })
    ).toEqual({
      endpoint: "http://127.0.0.1:4096",
      version: "2.0.0-beta.1",
      headers: { authorization: "Bearer ephemeral" },
    })
  })

  it("rejects missing versions and non-HTTP endpoints", () => {
    expect(() =>
      validateOpenCodeV2Discovery({ endpoint: "http://127.0.0.1:4096", headers: {} })
    ).toThrow("invalid service descriptor")
    expect(() =>
      validateOpenCodeV2Discovery({
        endpoint: "file:///tmp/service.sock",
        version: "2.0.0-beta.1",
      })
    ).toThrow("invalid endpoint")
  })

  it.each(["1.9.0", "3.0.0", "2.invalid", " "])(
    "rejects unsupported service version %s",
    (version) => {
      expect(() =>
        validateOpenCodeV2Discovery({ endpoint: "http://127.0.0.1:4096", version })
      ).toThrow("incompatible service version")
    }
  )
})

describe("discoverOpenCodeV2InProcess", () => {
  const signal = () => new AbortController().signal

  it("discovers the service, probes /api/info through the host's fetch and validates it", async () => {
    jest.mocked(Service.discover).mockResolvedValue({ url: "http://127.0.0.1:5566" } as never)
    jest.mocked(Service.headers).mockReturnValue({ authorization: "Basic x", empty: 1 } as never)
    const fetch = jest.fn<ReturnType<AgentFetch>, Parameters<AgentFetch>>(
      async () => new Response(JSON.stringify({ version: "2.0.5", pid: 42 }), { status: 200 })
    )
    await expect(discoverOpenCodeV2InProcess(fetch, signal())).resolves.toEqual({
      endpoint: "http://127.0.0.1:5566",
      version: "2.0.5",
      headers: { authorization: "Basic x" },
    })
    expect(fetch).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:5566/api/info"),
      expect.objectContaining({ headers: { authorization: "Basic x" } })
    )
  })

  it("refuses a missing service, a failed probe and an incompatible health contract", async () => {
    jest.mocked(Service.headers).mockReturnValue({} as never)
    jest.mocked(Service.discover).mockResolvedValueOnce(undefined as never)
    await expect(discoverOpenCodeV2InProcess(jest.fn(), signal())).rejects.toThrow(
      "No compatible OpenCode V2 service"
    )
    jest.mocked(Service.discover).mockResolvedValue({ url: "http://127.0.0.1:1" } as never)
    await expect(
      discoverOpenCodeV2InProcess(async () => new Response("{}", { status: 500 }), signal())
    ).rejects.toThrow("health probe failed")
    await expect(
      discoverOpenCodeV2InProcess(
        async () => new Response(JSON.stringify({ version: "1.0.0", pid: 1 }), { status: 200 }),
        signal()
      )
    ).rejects.toThrow("incompatible health contract")
  })
})
