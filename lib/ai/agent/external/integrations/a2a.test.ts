import { A2aClientAdapter } from "@cognia/agent-a2a/client"
import { A2A_EXECUTION_SEMANTICS } from "@cognia/agent-a2a/manifest"
import { createA2aAdapterFactory } from "./a2a"

describe("A2A host wiring", () => {
  it("builds the a2a adapter with remote, task-cancel semantics", () => {
    const adapter = createA2aAdapterFactory(jest.fn())()
    expect(adapter).toBeInstanceOf(A2aClientAdapter)
    expect(adapter.protocol).toBe("a2a")
    expect(adapter.semantics).toBe(A2A_EXECUTION_SEMANTICS)
  })

  it("sends through the fetch it was built with", async () => {
    const fetch = jest.fn(async () => new Response("{}", { status: 404 }))
    const adapter = createA2aAdapterFactory(fetch)()
    await adapter
      .connect({
        id: "a",
        name: "A",
        protocol: "a2a",
        transport: "http",
        network: { endpoint: "https://agent.example" },
      } as never)
      .catch(() => undefined)
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("https://agent.example/"),
      expect.anything()
    )
  })

  it("applies the app's PII gate to outbound messages", async () => {
    const adapter = createA2aAdapterFactory(jest.fn())() as unknown as {
      outboundGate: (payload: unknown) => boolean
    }
    expect(adapter.outboundGate({ text: "mail alice@example.com" })).toBe(false)
  })

  it("creates an independent adapter per configuration", () => {
    const factory = createA2aAdapterFactory(jest.fn())
    expect(factory()).not.toBe(factory())
  })
})
