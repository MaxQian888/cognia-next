/**
 * @jest-environment node
 */
import { DEV_TOKEN_HEADER } from "../handoff/client"
import {
  BRIDGE_EXECUTE_PATH,
  BRIDGE_MANIFEST_PATH,
  bridgeProviderTransport,
  localProviderTransport,
  parseManifestProjection,
  resolveProviderTransport,
  rpcProviderTransport,
} from "./transport"

const ENDPOINT = { baseUrl: "http://127.0.0.1:47811", devToken: "dev-secret" }

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

const MANIFEST = {
  ok: true,
  schemaVersion: 1,
  operations: [{ id: "models.list" }, { id: "capabilities.read" }],
  adminCommands: ["provider_catalog_status", "provider_diagnostics_status"],
}

describe("parseManifestProjection", () => {
  it("accepts the bridge projection and drops malformed entries", () => {
    const parsed = parseManifestProjection({
      schemaVersion: 1,
      operations: [{ id: "models.list" }, "junk", { noId: true }],
      adminCommands: ["provider_catalog_status", 7],
    })
    expect(parsed?.operations.map((op) => op.id)).toEqual(["models.list"])
    expect(parsed?.adminCommands).toEqual(["provider_catalog_status"])
  })

  it("rejects a body without the three fields", () => {
    expect(parseManifestProjection({ ok: true })).toBeNull()
    expect(
      parseManifestProjection({ schemaVersion: "1", operations: [], adminCommands: [] })
    ).toBeNull()
  })
})

describe("localProviderTransport", () => {
  it("dispatches nothing", async () => {
    const local = localProviderTransport()
    expect(local.kind).toBe("local")
    expect(local.supportsCommand("provider_catalog_status")).toBe(false)
    const outcome = await local.execute("provider_catalog_status")
    expect(outcome).toMatchObject({ ok: false, reason: "no-transport" })
  })
})

describe("bridgeProviderTransport", () => {
  it("is null without a live desktop", async () => {
    expect(await bridgeProviderTransport({ detect: async () => null })).toBeNull()
  })

  it("reads the manifest with the dev token and dispatches listed commands only", async () => {
    const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith(BRIDGE_MANIFEST_PATH)) return jsonResponse(200, MANIFEST)
      if (url.endsWith(BRIDGE_EXECUTE_PATH)) {
        expect(JSON.parse(String(init?.body))).toEqual({
          name: "provider_catalog_status",
          args: { verbose: true },
        })
        return jsonResponse(200, { ok: true, command: "provider_catalog_status", result: { n: 1 } })
      }
      throw new Error(`unexpected ${url}`)
    })
    const transport = (await bridgeProviderTransport({
      detect: async () => ENDPOINT,
      fetch: fetchMock as unknown as typeof fetch,
    }))!
    expect(transport.kind).toBe("bridge")
    expect(transport.manifest?.adminCommands).toEqual(MANIFEST.adminCommands)
    expect(transport.supportsCommand("provider_catalog_status")).toBe(true)
    expect(transport.supportsCommand("gateway_probe_upstream")).toBe(false)

    const listed = await transport.execute("provider_catalog_status", { verbose: true })
    expect(listed).toEqual({ ok: true, result: { n: 1 } })
    for (const call of fetchMock.mock.calls) {
      const headers = (call[1] as RequestInit | undefined)?.headers as Record<string, string>
      expect(headers[DEV_TOKEN_HEADER]).toBe("dev-secret")
    }

    const unlisted = await transport.execute("gateway_probe_upstream", { model: "m" })
    expect(unlisted).toMatchObject({ ok: false, reason: "unavailable" })
    // Never sent: the manifest already said no.
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith(BRIDGE_EXECUTE_PATH))
    ).toHaveLength(1)
  })

  it("degrades every command on a desktop without the manifest route", async () => {
    const fetchMock = jest.fn(async () => jsonResponse(404, { error: "not found" }))
    const transport = (await bridgeProviderTransport({
      detect: async () => ENDPOINT,
      fetch: fetchMock as unknown as typeof fetch,
    }))!
    expect(transport.manifest).toBeNull()
    expect(transport.supportsCommand("provider_catalog_status")).toBe(false)
    const outcome = await transport.execute("provider_catalog_status")
    expect(outcome).toMatchObject({ ok: false, reason: "unavailable" })
    expect((outcome as { message: string }).message).toMatch(/predates/)
  })

  it("maps a 403 command_not_exposed to unavailable, other errors to rejected, and 202 to accepted", async () => {
    const answers = [
      jsonResponse(403, { ok: false, error: "command_not_exposed" }),
      jsonResponse(503, { ok: false, error: "companion API server is not running" }),
      jsonResponse(202, { ok: true, operationId: "op-1" }),
    ]
    const fetchMock = jest.fn(async (url: string) =>
      url.endsWith(BRIDGE_MANIFEST_PATH) ? jsonResponse(200, MANIFEST) : answers.shift()!
    )
    const transport = (await bridgeProviderTransport({
      detect: async () => ENDPOINT,
      fetch: fetchMock as unknown as typeof fetch,
    }))!
    expect(await transport.execute("provider_catalog_status")).toMatchObject({
      ok: false,
      reason: "unavailable",
      message: "command_not_exposed",
    })
    expect(await transport.execute("provider_catalog_status")).toMatchObject({
      ok: false,
      reason: "rejected",
    })
    expect(await transport.execute("provider_catalog_status")).toEqual({
      ok: true,
      accepted: true,
      result: { operationId: "op-1" },
    })
  })
})

describe("rpcProviderTransport", () => {
  const env = { COGNIA_SERVER_URL: "https://brain.example/", COGNIA_SERVICE_TOKEN: "svc" }

  it("is null without the server env", () => {
    expect(rpcProviderTransport({ env: {} })).toBeNull()
  })

  it("posts args to /internal/_rpc/{name} with the service token", async () => {
    const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://brain.example/internal/_rpc/provider_catalog_search")
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer svc")
      expect(JSON.parse(String(init?.body))).toEqual({ query: "gpt" })
      return jsonResponse(200, { results: [] })
    })
    const transport = rpcProviderTransport({ env, fetch: fetchMock as unknown as typeof fetch })!
    expect(transport.kind).toBe("rpc")
    expect(transport.supportsCommand("anything")).toBeNull()
    expect(await transport.execute("provider_catalog_search", { query: "gpt" })).toEqual({
      ok: true,
      result: { results: [] },
    })
  })

  it("reports unknown_command as unavailable and other refusals as rejected", async () => {
    const answers = [
      jsonResponse(404, { code: "unknown_command", message: "no such command" }),
      jsonResponse(500, { code: "internal", message: "boom" }),
    ]
    const fetchMock = jest.fn(async () => answers.shift()!)
    const transport = rpcProviderTransport({ env, fetch: fetchMock as unknown as typeof fetch })!
    expect(await transport.execute("gateway_probe_upstream")).toMatchObject({
      ok: false,
      reason: "unavailable",
      message: "no such command",
    })
    expect(await transport.execute("gateway_probe_upstream")).toMatchObject({
      ok: false,
      reason: "rejected",
      message: "boom",
    })
  })

  it("reports a thrown fetch as network", async () => {
    const transport = rpcProviderTransport({
      env,
      fetch: (async () => {
        throw new Error("ECONNREFUSED")
      }) as unknown as typeof fetch,
    })!
    expect(await transport.execute("x")).toMatchObject({ ok: false, reason: "network" })
  })
})

describe("resolveProviderTransport", () => {
  it("falls through bridge and rpc to local, recording both", async () => {
    const detect = jest.fn(async () => null)
    const { transport, skipped } = await resolveProviderTransport({ detect, env: {} })
    expect(transport.kind).toBe("local")
    expect(skipped.map((s) => s.kind)).toEqual(["bridge", "rpc"])
  })

  it("never probes the network when local is asked for", async () => {
    const detect = jest.fn(async () => ENDPOINT)
    const { transport, skipped } = await resolveProviderTransport({ detect, prefer: "local" })
    expect(transport.kind).toBe("local")
    expect(detect).not.toHaveBeenCalled()
    expect(skipped).toEqual([])
  })

  it("takes rpc directly when asked, without trying the bridge", async () => {
    const detect = jest.fn(async () => ENDPOINT)
    const { transport } = await resolveProviderTransport({
      detect,
      prefer: "rpc",
      env: { COGNIA_SERVER_URL: "http://s", COGNIA_SERVICE_TOKEN: "t" },
    })
    expect(transport.kind).toBe("rpc")
    expect(detect).not.toHaveBeenCalled()
  })

  it("prefers the bridge when a desktop answers", async () => {
    const fetchMock = jest.fn(async () => jsonResponse(200, MANIFEST))
    const { transport, skipped } = await resolveProviderTransport({
      detect: async () => ENDPOINT,
      fetch: fetchMock as unknown as typeof fetch,
      env: { COGNIA_SERVER_URL: "http://s", COGNIA_SERVICE_TOKEN: "t" },
    })
    expect(transport.kind).toBe("bridge")
    expect(skipped).toEqual([])
  })
})
