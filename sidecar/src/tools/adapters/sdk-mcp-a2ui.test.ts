import test from "node:test"
import assert from "node:assert/strict"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { A2UI_TOOL_NAMES } from "../a2ui/tools.ts"
import { buildA2UIBridgeServer } from "./sdk-mcp-a2ui.ts"

test("the real SDK server validates and dispatches model and connector objects", async () => {
  const events: unknown[] = []
  const server = buildA2UIBridgeServer({
    sessionId: "a2ui-test",
    emit: (event) => events.push(event),
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: "a2ui-test", version: "1" })
  await server.instance.connect(serverTransport)
  await client.connect(clientTransport)
  try {
    assert.deepEqual(
      (await client.listTools()).tools.map((tool) => tool.name),
      A2UI_TOOL_NAMES
    )
    for (const request of [
      {
        name: "a2ui_data_model_update",
        arguments: { surfaceId: "s", data: { nested: { count: 2 } } },
      },
      {
        name: "a2ui_handle_connector_action",
        arguments: { surfaceId: "s", actionType: "submit", payload: { selected: ["a"] } },
      },
    ]) {
      const result = await client.callTool(request)
      assert.notEqual(result.isError, true, JSON.stringify(result))
    }
    assert.equal(events.length, 2)
    const invalid = await client.callTool({
      name: "a2ui_data_model_update",
      arguments: { surfaceId: "s", data: "invalid" },
    })
    assert.equal(invalid.isError, true)
    assert.equal(events.length, 2)
  } finally {
    await client.close()
    await server.instance.close()
  }
})

test("the A2UI server keeps its tools resident unless told otherwise", async () => {
  const residency = async (alwaysLoad?: boolean) => {
    const server = buildA2UIBridgeServer({
      sessionId: "a2ui-resident",
      emit: () => {},
      ...(alwaysLoad === undefined ? {} : { alwaysLoad }),
    })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: "a2ui-resident", version: "1" })
    await server.instance.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      return (await client.listTools()).tools.map(
        (entry) => entry._meta?.["anthropic/alwaysLoad"] === true
      )
    } finally {
      await client.close()
      await server.instance.close()
    }
  }
  assert.ok((await residency()).every(Boolean))
  assert.ok((await residency(false)).every((resident) => !resident))
})
