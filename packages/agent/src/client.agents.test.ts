import { createInterface } from "node:readline"
import { PassThrough } from "node:stream"

import * as v from "valibot"

import { buildAgentDefinition, type AgentDefinitionInput } from "./agent-definition"
import { createCogniaClient } from "./client"
import { defineTool } from "./define-tool"
import { RPC_METHODS, RPC_PROTOCOL_VERSION } from "./rpc/protocol"
import { defineOutput } from "./structured-output"

const AUTHORING = ["agent-definitions-v1", "agent-session-binding-v1", "sessions-v1"]

function createHost(options: { capabilities?: string[] } = {}) {
  const hostToClient = new PassThrough()
  const clientToHost = new PassThrough()
  const requests: Record<string, unknown>[] = []
  const lines = createInterface({ input: clientToHost, crlfDelay: Infinity })
  /** A tiny in-memory stand-in for the host's definition store. */
  const agents = new Map<string, AgentDefinitionInput[]>()

  void (async () => {
    for await (const line of lines) {
      const request = JSON.parse(line) as Record<string, unknown>
      requests.push(request)
      if (request.id === undefined) continue
      const params = (request.params ?? {}) as Record<string, never>
      let result: unknown
      let error: { code: number; message: string } | undefined

      switch (request.method) {
        case "initialize":
          result = {
            protocolVersion: RPC_PROTOCOL_VERSION,
            host: { name: "test-host", version: "0.1.0" },
            runtimeVersion: "0.1.0",
            instanceId: "host-1",
            methods: RPC_METHODS,
            capabilities: options.capabilities ?? AUTHORING,
            limits: {},
          }
          break
        case "agent/create": {
          const agentId = String(params.agentId ?? "minted")
          const definition = params.definition as AgentDefinitionInput
          agents.set(agentId, [definition])
          result = buildAgentDefinition(definition, {
            agentId,
            version: 1,
            createdAt: "2026-08-23T00:00:00.000Z",
          })
          break
        }
        case "agent/update": {
          const agentId = String(params.agentId)
          const history = agents.get(agentId) ?? []
          if (history.length !== Number(params.expectedVersion)) {
            error = { code: -32015, message: "version conflict" }
            break
          }
          history.push(params.changes as AgentDefinitionInput)
          agents.set(agentId, history)
          result = buildAgentDefinition(params.changes as AgentDefinitionInput, {
            agentId,
            version: history.length,
            createdAt: "2026-08-23T00:00:01.000Z",
          })
          break
        }
        case "agent/get": {
          const agentId = String(params.agentId)
          const history = agents.get(agentId) ?? []
          const version = Number(params.version ?? history.length)
          result = buildAgentDefinition(history[version - 1]!, {
            agentId,
            version,
            createdAt: "2026-08-23T00:00:00.000Z",
          })
          break
        }
        case "agent/list":
          result = {
            agents: [...agents.entries()].map(([agentId, history]) => ({
              agentId,
              name: history.at(-1)!.name,
              latestVersion: history.length,
              definitionDigest: "sha256-x",
              createdAt: "2026-08-23T00:00:00.000Z",
            })),
          }
          break
        case "agent/versions":
          result = {
            agentId: String(params.agentId),
            versions: (agents.get(String(params.agentId)) ?? []).map((_, index) => index + 1),
          }
          break
        case "agent/archive":
        case "agent/restore":
          result = {
            agentId: String(params.agentId),
            name: "n",
            latestVersion: 1,
            definitionDigest: "sha256-x",
            createdAt: "2026-08-23T00:00:00.000Z",
            ...(request.method === "agent/archive"
              ? { archivedAt: "2026-08-23T01:00:00.000Z" }
              : {}),
          }
          break
        case "session/create":
          result = {
            sessionId: "session-1",
            spec: { runtime: "built-in" },
            ...(params.agent
              ? {
                  agentBinding: {
                    agentId: (params.agent as { agentId: string }).agentId,
                    version: (params.agent as { version?: number }).version ?? 1,
                    definitionDigest: "sha256-x",
                  },
                }
              : {}),
          }
          break
        case "session/entries":
          result = { entries: [] }
          break
        case "turn/run":
          result = {
            status: "completed",
            result: {
              status: "completed",
              text: "done",
              structuredOutput: { summary: "shipped", risk: "low" },
            },
          }
          break
        default:
          result = { ok: true }
      }

      hostToClient.write(
        `${JSON.stringify(
          error
            ? { jsonrpc: "2.0", id: request.id, error }
            : { jsonrpc: "2.0", id: request.id, result }
        )}\n`
      )
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

const definition: AgentDefinitionInput = {
  name: "Release bot",
  composition: { presetId: "coding" },
}

describe("client.agents", () => {
  it("creates a definition and hands back a handle at that version", async () => {
    const host = createHost()
    const client = await createCogniaClient({ host: { kind: "streams", ...host.streams } })
    const agent = await client.agents.create({ ...definition, agentId: "release-bot" })
    expect(agent.id).toBe("release-bot")
    expect(agent.version).toBe(1)
    expect(agent.definition.definitionDigest).toMatch(/^sha256-/)
    await client.close()
    host.close()
  })

  it("updates through a compare-and-swap defaulting to the handle's version", async () => {
    const host = createHost()
    const client = await createCogniaClient({ host: { kind: "streams", ...host.streams } })
    const agent = await client.agents.create({ ...definition, agentId: "cas" })
    const next = await agent.update({ ...definition, name: "Renamed" })
    expect(next.version).toBe(2)
    const update = host.requests.find((request) => request.method === "agent/update")
    expect(update?.params).toMatchObject({ agentId: "cas", expectedVersion: 1 })
    await client.close()
    host.close()
  })

  it("leaves the original handle describing the version it was read at", async () => {
    const host = createHost()
    const client = await createCogniaClient({ host: { kind: "streams", ...host.streams } })
    const agent = await client.agents.create({ ...definition, agentId: "frozen" })
    await agent.update({ ...definition, name: "Renamed" })
    expect(agent.version).toBe(1)
    expect(agent.definition.name).toBe("Release bot")
    await client.close()
    host.close()
  })

  it("surfaces a stale compare-and-swap as version_conflict", async () => {
    const host = createHost()
    const client = await createCogniaClient({ host: { kind: "streams", ...host.streams } })
    const agent = await client.agents.create({ ...definition, agentId: "stale" })
    await agent.update({ ...definition, name: "Second" })
    await expect(agent.update({ ...definition, name: "Third" })).rejects.toMatchObject({
      code: "version_conflict",
      rpcCode: -32015,
    })
    await client.close()
    host.close()
  })

  it("pins the handle's exact version when creating a session", async () => {
    const host = createHost()
    const client = await createCogniaClient({ host: { kind: "streams", ...host.streams } })
    const agent = await client.agents.create({ ...definition, agentId: "pinned" })
    await agent.sessions.create({ name: "run" })
    const created = host.requests.find((request) => request.method === "session/create")
    expect(created?.params).toMatchObject({ agent: { agentId: "pinned", version: 1 } })
    await client.close()
    host.close()
  })

  it("starts a turn straight from the agent", async () => {
    const host = createHost()
    const client = await createCogniaClient({ host: { kind: "streams", ...host.streams } })
    const agent = await client.agents.create({ ...definition, agentId: "runner" })
    const run = await agent.start("ship it")
    await expect(run.result).resolves.toMatchObject({ status: "completed" })
    expect(host.methods()).toEqual(expect.arrayContaining(["session/create", "turn/run"]))
    await client.close()
    host.close()
  })

  it("lists, versions, archives and restores through the handle", async () => {
    const host = createHost()
    const client = await createCogniaClient({ host: { kind: "streams", ...host.streams } })
    const agent = await client.agents.create({ ...definition, agentId: "lifecycle" })
    await agent.update({ ...definition, name: "Second" })
    await expect(agent.versions()).resolves.toEqual([1, 2])
    await expect(client.agents.list()).resolves.toEqual([
      expect.objectContaining({ agentId: "lifecycle", latestVersion: 2 }),
    ])
    await expect(agent.archive()).resolves.toMatchObject({ archivedAt: expect.any(String) })
    await expect(agent.restore()).resolves.toMatchObject({ agentId: "lifecycle" })
    await client.close()
    host.close()
  })

  it("refuses the authoring API against a host that does not declare it", async () => {
    const host = createHost({ capabilities: ["sessions-v1"] })
    const client = await createCogniaClient({ host: { kind: "streams", ...host.streams } })
    await expect(client.agents.create(definition)).rejects.toMatchObject({
      code: "capability_error",
    })
    expect(host.methods()).not.toContain("agent/create")
    await client.close()
    host.close()
  })

  it("carries a typed tool contract into the definition without its handler", async () => {
    const host = createHost()
    const client = await createCogniaClient({ host: { kind: "streams", ...host.streams } })
    const readFile = defineTool({
      name: "read_file",
      description: "Read a file",
      input: v.object({ path: v.string() }),
      handler: async ({ path }) => path,
    })
    const agent = await client.agents.create({
      ...definition,
      agentId: "tooled",
      toolRefs: [readFile.reference],
    })
    expect(agent.definition.toolRefs).toEqual([readFile.reference])
    const created = host.requests.find((request) => request.method === "agent/create")
    expect(JSON.stringify(created)).not.toContain("handler:")
    await client.close()
    host.close()
  })

  it("round-trips an output contract and reads the structured result", async () => {
    const host = createHost()
    const client = await createCogniaClient({ host: { kind: "streams", ...host.streams } })
    const outputSchema = v.object({ summary: v.string(), risk: v.picklist(["low", "high"]) })
    const agent = await client.agents.create({
      ...definition,
      agentId: "structured",
      output: defineOutput(outputSchema),
    })
    expect(agent.definition.output?.schemaDigest).toMatch(/^sha256-/)

    const run = await agent.start("assess")
    const outcome = await run.result
    const { parseStructuredOutput } = await import("./structured-output")
    expect(parseStructuredOutput(outputSchema, outcome)).toEqual({
      summary: "shipped",
      risk: "low",
    })
    await client.close()
    host.close()
  })
})
