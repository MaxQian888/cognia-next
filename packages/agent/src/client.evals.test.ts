import { createInterface } from "node:readline"
import { PassThrough } from "node:stream"

import { createCogniaClient } from "./client"
import { RPC_METHODS, RPC_PROTOCOL_VERSION } from "./rpc/protocol"

function createHost(options: { capabilities?: string[] } = {}) {
  const hostToClient = new PassThrough()
  const clientToHost = new PassThrough()
  const requests: Record<string, unknown>[] = []
  const lines = createInterface({ input: clientToHost, crlfDelay: Infinity })

  void (async () => {
    for await (const line of lines) {
      const request = JSON.parse(line) as Record<string, unknown>
      requests.push(request)
      if (request.id === undefined) continue
      let result: unknown
      switch (request.method) {
        case "initialize":
          result = {
            protocolVersion: RPC_PROTOCOL_VERSION,
            host: { name: "test-host", version: "0.1.0" },
            runtimeVersion: "0.1.0",
            instanceId: "host-1",
            methods: RPC_METHODS,
            capabilities: options.capabilities ?? ["evals-v1"],
            limits: {},
          }
          break
        case "eval/replay":
          result = {
            ok: true,
            scenarioId: "scenario-1",
            requests: 3,
            unmatched: 0,
            summary: "3/3 tapes consumed",
          }
          break
        case "eval/fixture/refresh":
          result = { changed: true, fixture: { scenario: {}, tapes: [] } }
          break
        case "eval/record/start":
          result = { recordingId: "rec-1", proxyUrl: "http://127.0.0.1:5599" }
          break
        case "eval/record/stop":
          result = { fixture: { scenario: {}, tapes: [] }, actors: ["root"] }
          break
        default:
          result = { ok: true }
      }
      hostToClient.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`)
    }
  })()

  return {
    streams: { readable: hostToClient, writable: clientToHost },
    requests,
    methods: () => requests.map((request) => request.method),
    close() {
      lines.close()
      hostToClient.end()
      clientToHost.end()
    },
  }
}

describe("client.evals", () => {
  it("replays a fixture and reports tape consumption", async () => {
    const host = createHost()
    const client = await createCogniaClient({ host: { kind: "streams", ...host.streams } })
    await expect(client.evals.replay({ scenario: {}, tapes: [] })).resolves.toMatchObject({
      ok: true,
      scenarioId: "scenario-1",
      requests: 3,
      unmatched: 0,
    })
    await client.close()
    host.close()
  })

  it("requires synthetic fixtures by default", async () => {
    const host = createHost()
    const client = await createCogniaClient({ host: { kind: "streams", ...host.streams } })
    await client.evals.replay({ scenario: {}, tapes: [] })
    const replay = host.requests.find((request) => request.method === "eval/replay")
    // Omitted means the host's own default (true) applies; passing false is the
    // explicit act of replaying a real recording.
    expect((replay?.params as Record<string, unknown>).requireSynthetic).toBeUndefined()

    await client.evals.replay({ scenario: {}, tapes: [] }, { requireSynthetic: false })
    const second = host.requests.filter((request) => request.method === "eval/replay").at(-1)
    expect((second?.params as Record<string, unknown>).requireSynthetic).toBe(false)
    await client.close()
    host.close()
  })

  it("gives a replay far longer than the ordinary request timeout", async () => {
    const host = createHost()
    const client = await createCogniaClient({
      host: { kind: "streams", ...host.streams },
      requestTimeoutMs: 50,
    })
    // A whole scenario cannot finish inside a control-call timeout; if the
    // client used `requestTimeoutMs` this would reject.
    await expect(client.evals.replay({ scenario: {}, tapes: [] })).resolves.toMatchObject({
      ok: true,
    })
    await client.close()
    host.close()
  })

  it("opens a recording proxy and returns its fixture on stop", async () => {
    const host = createHost()
    const client = await createCogniaClient({ host: { kind: "streams", ...host.streams } })
    const recording = await client.evals.record({ actors: [{ role: "root", actorRef: "a" }] })
    expect(recording).toMatchObject({
      recordingId: "rec-1",
      proxyUrl: "http://127.0.0.1:5599",
    })
    await expect(recording.stop()).resolves.toMatchObject({ actors: ["root"] })
    await client.close()
    host.close()
  })

  it("refuses to stop the same recording twice", async () => {
    const host = createHost()
    const client = await createCogniaClient({ host: { kind: "streams", ...host.streams } })
    const recording = await client.evals.record({})
    await recording.stop()
    await expect(recording.stop()).rejects.toMatchObject({ code: "invalid_params" })
    await client.close()
    host.close()
  })

  it("stops an abandoned recording when it is disposed", async () => {
    const host = createHost()
    const client = await createCogniaClient({ host: { kind: "streams", ...host.streams } })
    {
      await using recording = await client.evals.record({})
      expect(recording.recordingId).toBe("rec-1")
    }
    expect(host.methods()).toContain("eval/record/stop")
    await client.close()
    host.close()
  })

  it("refreshes a fixture's digests", async () => {
    const host = createHost()
    const client = await createCogniaClient({ host: { kind: "streams", ...host.streams } })
    await expect(client.evals.refreshFixture({ scenario: {}, tapes: [] })).resolves.toMatchObject({
      changed: true,
    })
    await client.close()
    host.close()
  })

  it("refuses the eval API against a host that does not declare it", async () => {
    const host = createHost({ capabilities: ["sessions-v1"] })
    const client = await createCogniaClient({ host: { kind: "streams", ...host.streams } })
    for (const call of [
      () => client.evals.replay({}),
      () => client.evals.refreshFixture({}),
      () => client.evals.record({}),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: "capability_error" })
    }
    expect(host.methods()).not.toContain("eval/replay")
    await client.close()
    host.close()
  })
})
