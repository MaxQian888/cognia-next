import test from "node:test"
import assert from "node:assert/strict"
import { connectBroker } from "./broker.ts"
import { fakeSocket, scriptedBroker } from "../../../test-support/mcp-broker.ts"
test("connectBroker resolves a call with the matching response id", async () => {
  const { broker } = scriptedBroker((method) => ({ echoed: method }))
  assert.deepEqual(await broker.call("hello", {}), { echoed: "hello" })
})

test("connectBroker rejects every pending call when Cognia goes away", async () => {
  const socket = fakeSocket()
  const broker = connectBroker("/ignored", { connect: () => socket })
  const pending = broker.call("authorize", {})
  socket.emit("close")
  await assert.rejects(pending, /closed the connection/)
})

test("connectBroker rejects a malformed frame rather than guessing", async () => {
  const socket = fakeSocket()
  const broker = connectBroker("/ignored", { connect: () => socket })
  const pending = broker.call("authorize", {})
  socket.emit("data", "garbage\n")
  await assert.rejects(pending, /malformed frame/)
})

test("connectBroker surfaces a broker-side error as a rejection", async () => {
  const socket = fakeSocket()
  const broker = connectBroker("/ignored", { connect: () => socket })
  socket.write = (chunk) => {
    const { id } = JSON.parse(chunk)
    queueMicrotask(() => socket.emit("data", `${JSON.stringify({ id, error: "unauthorized" })}\n`))
    return true
  }
  await assert.rejects(broker.call("hello", {}), /unauthorized/)
})
