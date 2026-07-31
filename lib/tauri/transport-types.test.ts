import { WebStubTransport } from "./transport-web"
import type { Transport } from "./transport-types"

it("keeps concrete transports on the asynchronous, idempotent public contract", async () => {
  const transport: Transport = new WebStubTransport()
  const call = transport.call("contract_probe", {}, { idempotencyKey: "probe-1" })

  expect(call).toBeInstanceOf(Promise)
  await expect(call).rejects.toThrow("contract_probe")

  const unsubscribe = transport.subscribe("contract:event", () => {})
  expect(() => {
    unsubscribe()
    unsubscribe()
  }).not.toThrow()
})
